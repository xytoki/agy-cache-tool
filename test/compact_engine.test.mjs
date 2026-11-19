import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCompact, DRAFT_RESUME_GRACE_SEC } from '../agy-cache-helper/sidecars/cache_helper/compact_engine.mjs';
import { createPingController } from '../agy-cache-helper/sidecars/cache_helper/ping_engine.mjs';
import { DEFAULT_SETTINGS, createSettingsStore } from '../agy-cache-helper/sidecars/cache_helper/settings.mjs';
import { createEventLog } from '../agy-cache-helper/sidecars/cache_helper/event_log.mjs';
import { buildFooterRuntimeBundle } from '../agy-cache-helper/sidecars/cache_helper/footer_injector.mjs';

function makeConv(overrides = {}) {
  const nowMs = 1_700_000_000_000;
  return {
    conversationId: 'conv-main-1',
    title: 'Long Build Task',
    projectId: 'proj-1',
    isRunning: false,
    isSubagent: false,
    justCompacted: false,
    notFullyIdle: false,
    activeChildCount: 0,
    hasActiveBackground: false,
    modelStr: 'gemini-4-carbon',
    modelDisplay: 'Gemini 4 Carbon (Medium)',
    modelFamily: 'carbon',
    contextTokens: 470_000,
    maxContextTokens: 512_000,
    contextPct: (470_000 / 512_000) * 100, // 91.8%
    cachedIn: 450_000,
    uncachedIn: 20_000,
    outTokens: 200,
    latestCacheHitPct: 95,
    latestGenIdx: 20,
    lastCompletedAtMs: nowMs - 5_000, // 5s idle
    lastRealBoundaryIdx: 50,
    consecutivePings: 0,
    lastRealTurnDurationSec: 45,
    ...overrides,
  };
}

test('Trigger policy: >=90% counts down even with active bg; 80%-89% only after finished long turn; stale/subagent/reverted skip', () => {
  const nowMs = 1_700_000_000_000;

  // Tier 1 (>=90%): triggers even when subagents/background commands are active
  const tier1 = evaluateCompact(
    makeConv({ hasActiveBackground: true, activeChildCount: 2, notFullyIdle: true }),
    DEFAULT_SETTINGS,
    nowMs,
  );
  assert.equal(tier1.action, 'countdown');
  assert.equal(Math.round(tier1.remainingSec), 55);

  // Tier 2 (80%-89%): skips short turn and skips while background still running; triggers when long turn finishes
  const ctx84 = { contextTokens: 430_000, contextPct: 84.0 };
  assert.equal(evaluateCompact(makeConv({ ...ctx84, lastRealTurnDurationSec: 120 }), DEFAULT_SETTINGS, nowMs).action, 'skip');
  assert.equal(evaluateCompact(makeConv({ ...ctx84, lastRealTurnDurationSec: 420, hasActiveBackground: true }), DEFAULT_SETTINGS, nowMs).action, 'skip');
  assert.equal(evaluateCompact(makeConv({ ...ctx84, lastRealTurnDurationSec: 420, hasActiveBackground: false }), DEFAULT_SETTINGS, nowMs).action, 'countdown');

  // Exclusions: subagent, post-revert, and stale (>60s on first sight without prior countdown) never trigger immediately
  assert.equal(evaluateCompact(makeConv({ isSubagent: true }), DEFAULT_SETTINGS, nowMs).action, 'skip');
  assert.equal(evaluateCompact(makeConv({ justReverted: true }), DEFAULT_SETTINGS, nowMs).action, 'skip');
  assert.equal(evaluateCompact(makeConv({ lastCompletedAtMs: nowMs - 75_000 }), DEFAULT_SETTINGS, nowMs, {}).action, 'skip');
});

test('Draft pauses countdown and resumes with grace buffer (or skips if pause outlasted warm window)', () => {
  const t0 = 1_700_000_000_000;
  const conv = makeConv({ lastCompletedAtMs: t0 });

  // At t0+50s, countdown has 10s left
  const c1 = evaluateCompact(conv, DEFAULT_SETTINGS, t0 + 50_000, { deadlineMs: t0 + 60_000 });
  assert.equal(c1.action, 'countdown');
  assert.equal(Math.round(c1.remainingSec), 10);

  // User starts typing draft at t0+52s -> paused with 8s frozen
  const p1 = evaluateCompact(conv, DEFAULT_SETTINGS, t0 + 52_000, { deadlineMs: t0 + 60_000, hasDraft: true });
  assert.equal(p1.action, 'paused');
  assert.equal(p1.reason, 'compact_paused_draft');
  assert.equal(Math.round(p1.remainingSec), 8);

  // Even at t0+70s (past 60s), stays paused while draft exists
  const p2 = evaluateCompact(conv, DEFAULT_SETTINGS, t0 + 70_000, {
    deadlineMs: null,
    remainingOnPauseSec: p1.nextState.remainingOnPauseSec,
    hasDraft: true,
  });
  assert.equal(p2.action, 'paused');
  assert.equal(Math.round(p2.remainingSec), 8);

  // Clearing draft at t0+80s resumes with at least DRAFT_RESUME_GRACE_SEC (15s) buffer
  const r1 = evaluateCompact(conv, DEFAULT_SETTINGS, t0 + 80_000, {
    deadlineMs: null,
    remainingOnPauseSec: p2.nextState.remainingOnPauseSec,
    hasDraft: false,
  });
  assert.equal(r1.action, 'countdown');
  assert.equal(Math.round(r1.remainingSec), DRAFT_RESUME_GRACE_SEC);

  // If draft was held for 4 minutes (cache cold) and then cleared -> skip
  const coldAfterPause = evaluateCompact(conv, DEFAULT_SETTINGS, t0 + 240_000, {
    deadlineMs: null,
    remainingOnPauseSec: 20,
    hasDraft: false,
  });
  assert.equal(coldAfterPause.action, 'skip');
  assert.equal(coldAfterPause.reason, 'compact_stale_after_pause');
});

test('Controller runs 60s detect-only lifecycle, supports cancel/preview, and builds footer snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ch-cmp-'));
  try {
    let nowMs = 1_700_000_000_000;
    const settingsStore = createSettingsStore(join(dir, 'settings.json'));
    settingsStore.update({ compactExecuteMode: 'detect_only' });
    const eventLog = createEventLog(join(dir, 'events.json'));
    const readyHooks = [];

    let convA = makeConv({
      conversationId: 'conv-a',
      title: 'Tail 92% Session',
      lastCompletedAtMs: nowMs - 5_000,
      lastRealBoundaryIdx: 10,
    });
    let convB = makeConv({
      conversationId: 'conv-b',
      title: 'Mid 40% Session',
      contextTokens: 200_000,
      contextPct: 39.1,
      lastCompletedAtMs: nowMs - 10_000,
      lastRealBoundaryIdx: 5,
    });

    const ctrl = createPingController({
      readCandidates: () => [convA, convB],
      sendPing: async () => ({ ok: true }),
      settingsStore,
      eventLog,
      onCompactReady: (conv, decision) => { readyHooks.push({ cid: conv.conversationId, tier: decision.tier }); },
      nowFn: () => nowMs,
    });

    // Tick 1 (t+5s): conv-a enters countdown; conv-b is foreground -> conv-a shows as background badge!
    ctrl.reportPageState('page-1', { conversationId: 'conv-b', hasDraft: false });
    await ctrl.tick();

    const snapOnB = ctrl.getFooterSnapshot('conv-b');
    assert.equal(snapOnB.current, null);
    assert.equal(snapOnB.background.length, 1);
    assert.equal(snapOnB.background[0].conversationId, 'conv-a');
    assert.equal(snapOnB.background[0].remainingSec, 55);
    assert.equal(snapOnB.detectOnly, true);

    const snapOnA = ctrl.getFooterSnapshot('conv-a');
    assert.equal(snapOnA.current.conversationId, 'conv-a');
    assert.equal(snapOnA.background.length, 0);

    // Advance past 60s -> fires detect-only ready ONCE and records event
    nowMs += 56_000;
    await ctrl.tick();
    assert.equal(readyHooks.length, 1);
    assert.equal(readyHooks[0].cid, 'conv-a');
    assert.equal(eventLog.list()[0].type, 'compact_ready');
    assert.equal(eventLog.list()[0].outcome, 'detect_only');

    // Next tick on same turn must NOT fire again
    nowMs += 5_000;
    await ctrl.tick();
    assert.equal(readyHooks.length, 1);
    assert.equal(ctrl.getFooterSnapshot('conv-a').current, null);

    // Preview countdown on mid-context conv-b -> shows in footer, then user cancels via footer!
    const prevRes = ctrl.startCompactPreview('conv-b');
    assert.equal(prevRes.ok, true);
    await ctrl.tick();
    assert.equal(ctrl.getFooterSnapshot('conv-b').current.conversationId, 'conv-b');
    assert.equal(ctrl.getFooterSnapshot('conv-b').current.preview, true);

    nowMs += 12_000;
    const cancelRes = ctrl.cancelCompact('conv-b', 'footer');
    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.remainingSec, 48);
    await ctrl.tick();
    assert.equal(ctrl.getFooterSnapshot('conv-b').current, null);
    assert.equal(eventLog.list()[0].type, 'compact_preview_cancelled');
    assert.equal(eventLog.list()[0].remainingSec, 48);
    // Cancelling preview must NOT mark the real turn as compact_cancelled_turn
    assert.notEqual(ctrl.getStatus().conversations.find(c => c.conversationId === 'conv-b').compact.reason, 'compact_cancelled_turn');

    // New turn on conv-a resets triggered flag
    convA = makeConv({
      conversationId: 'conv-a',
      title: 'Tail 92% Session',
      lastCompletedAtMs: nowMs - 2_000,
      lastRealBoundaryIdx: 11,
    });
    await ctrl.tick();
    assert.equal(ctrl.getFooterSnapshot('conv-a').current.remainingSec, 58);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Execute mode fires compact hook once and audits CHECKPOINT landing in the DB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ch-exec-'));
  try {
    let nowMs = 1_700_000_000_000;
    const settingsStore = createSettingsStore(join(dir, 'settings.json'));
    settingsStore.update({ compactExecuteMode: 'execute' });
    const eventLog = createEventLog(join(dir, 'events.json'));
    const calls = [];

    let convA = makeConv({
      conversationId: 'conv-a',
      title: 'Tail 92% Session',
      lastCompletedAtMs: nowMs - 5_000,
      lastRealBoundaryIdx: 10,
      latestCheckpointIdx: 3,
    });

    const ctrl = createPingController({
      readCandidates: () => [convA],
      sendPing: async () => ({ ok: true }),
      settingsStore,
      eventLog,
      executeCompact: async conv => {
        calls.push(conv.conversationId);
        return { ok: true, planModel: 'MODEL_X' };
      },
      nowFn: () => nowMs,
    });

    await ctrl.tick();
    assert.equal(ctrl.getFooterSnapshot('conv-a').detectOnly, false);

    nowMs += 61_000;
    await ctrl.tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'conv-a');
    let ev = eventLog.list()[0];
    assert.equal(ev.type, 'compact_ready');
    assert.equal(ev.outcome, 'pending');
    assert.equal(ev.planModel, 'MODEL_X');

    // DB now shows the fresh CHECKPOINT -> audit resolves to executed
    convA = makeConv({
      conversationId: 'conv-a',
      title: 'Tail 92% Session',
      justCompacted: true,
      contextTokens: 0,
      contextPct: 0,
      latestCheckpointIdx: 40,
      lastRealBoundaryIdx: 41,
      lastCompletedAtMs: nowMs,
    });
    await ctrl.tick();
    ev = eventLog.list()[0];
    assert.equal(ev.outcome, 'executed');
    assert.equal(ev.checkpointIdx, 40);

    // Must not fire again on the compacted turn
    nowMs += 5_000;
    await ctrl.tick();
    assert.equal(calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Execute mode under dryRun records dry_run and never invokes the executor hook', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ch-dry-'));
  try {
    let nowMs = 1_700_000_000_000;
    const settingsStore = createSettingsStore(join(dir, 'settings.json'));
    settingsStore.update({ compactExecuteMode: 'execute', dryRun: true });
    const eventLog = createEventLog(join(dir, 'events.json'));
    const calls = [];

    const convA = makeConv({
      conversationId: 'conv-a',
      lastCompletedAtMs: nowMs - 5_000,
      lastRealBoundaryIdx: 10,
    });

    const ctrl = createPingController({
      readCandidates: () => [convA],
      sendPing: async () => ({ ok: true }),
      settingsStore,
      eventLog,
      executeCompact: async conv => { calls.push(conv.conversationId); return { ok: true }; },
      nowFn: () => nowMs,
    });

    await ctrl.tick();
    assert.equal(ctrl.getFooterSnapshot('conv-a').detectOnly, true);

    nowMs += 61_000;
    await ctrl.tick();
    assert.equal(calls.length, 0);
    const ev = eventLog.list()[0];
    assert.equal(ev.type, 'compact_ready');
    assert.equal(ev.outcome, 'dry_run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Execute mode retries after executor failure and gives up after 3 consecutive errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ch-err-'));
  try {
    let nowMs = 1_700_000_000_000;
    const settingsStore = createSettingsStore(join(dir, 'settings.json'));
    settingsStore.update({ compactExecuteMode: 'execute' });
    const eventLog = createEventLog(join(dir, 'events.json'));
    const calls = [];

    const convA = makeConv({
      conversationId: 'conv-a',
      lastCompletedAtMs: nowMs - 5_000,
      lastRealBoundaryIdx: 10,
    });

    const ctrl = createPingController({
      readCandidates: () => [convA],
      sendPing: async () => ({ ok: true }),
      settingsStore,
      eventLog,
      executeCompact: async conv => { calls.push(conv.conversationId); throw new Error('boom'); },
      nowFn: () => nowMs,
    });

    await ctrl.tick(); // arm countdown

    for (const attempt of [1, 2, 3]) {
      nowMs += 61_000;
      await ctrl.tick(); // fires attempt N
      assert.equal(calls.length, attempt);
      const ev = eventLog.list().filter(e => e.type === 'compact_ready').at(-1);
      assert.equal(ev.outcome, 'error');
      assert.equal(ev.error, 'boom');
      if (attempt < 3) {
        nowMs += 1_000;
        await ctrl.tick(); // countdown restarts immediately after the failure
      }
    }

    // 3 consecutive failures -> stays suppressed for the rest of the turn
    nowMs += 61_000;
    await ctrl.tick();
    assert.equal(calls.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Footer runtime bundle compiles cleanly as valid JavaScript', () => {
  const { code, hash } = buildFooterRuntimeBundle(123456);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 16);
  assert.doesNotThrow(() => new Function(code));
});
