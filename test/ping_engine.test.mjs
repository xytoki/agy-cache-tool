import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateConversation, createPingController } from '../agy-cache-helper/sidecars/cache_helper/ping_engine.mjs';
import { DEFAULT_SETTINGS, createSettingsStore } from '../agy-cache-helper/sidecars/cache_helper/settings.mjs';
import { createEventLog } from '../agy-cache-helper/sidecars/cache_helper/event_log.mjs';

function makeConv(overrides = {}) {
  const nowMs = 1_700_000_000_000;
  return {
    conversationId: 'conv-1',
    title: 'Test Conv',
    projectId: 'proj-1',
    isRunning: false,
    isSubagent: false,
    notFullyIdle: false,
    activeChildCount: 0,
    hasActiveBackground: false,
    modelStr: 'gemini-4-carbon',
    modelDisplay: 'Gemini 4 Carbon (Medium)',
    modelFamily: 'carbon',
    contextTokens: 200_000,
    maxContextTokens: 512_000,
    contextPct: (200_000 / 512_000) * 100,
    cachedIn: 190_000,
    uncachedIn: 10_000,
    outTokens: 200,
    latestCacheHitPct: 95,
    latestGenIdx: 10,
    lastCompletedAtMs: nowMs - 180_000,
    lastRealBoundaryIdx: 20,
    consecutivePings: 0,
    lastRealTurnDurationSec: 45,
    ...overrides,
  };
}

test('Ping policy: gates long unattended turns, subagent bg exception, and Claude vs Gemini caps', () => {
  const nowMs = 1_700_000_000_000;

  // Long turn without background skips (likely away); waiting on background/subagent still pings
  assert.equal(
    evaluateConversation(makeConv({ lastRealTurnDurationSec: 620, hasActiveBackground: false }), DEFAULT_SETTINGS, nowMs).action,
    'skip',
  );
  assert.equal(
    evaluateConversation(makeConv({ lastRealTurnDurationSec: 620, hasActiveBackground: true, activeChildCount: 1 }), DEFAULT_SETTINGS, nowMs).action,
    'ping',
  );

  // Tail zone (>=90%), post-compact, and post-revert never ping
  assert.equal(evaluateConversation(makeConv({ contextTokens: 470_000, contextPct: 91.8 }), DEFAULT_SETTINGS, nowMs).action, 'skip');
  assert.equal(evaluateConversation(makeConv({ justCompacted: true, contextTokens: 0, contextPct: 0 }), DEFAULT_SETTINGS, nowMs).action, 'skip');
  assert.equal(evaluateConversation(makeConv({ justReverted: true }), DEFAULT_SETTINGS, nowMs).action, 'skip');

  // Subagent skips when idle, pings once at 235s only when running a bg command with >=50K context
  assert.equal(
    evaluateConversation(makeConv({ isSubagent: true, notFullyIdle: false, lastCompletedAtMs: nowMs - 240_000 }), DEFAULT_SETTINGS, nowMs).action,
    'skip',
  );
  assert.equal(
    evaluateConversation(makeConv({ isSubagent: true, notFullyIdle: true, contextTokens: 120_000, contextPct: 23.4, lastCompletedAtMs: nowMs - 240_000 }), DEFAULT_SETTINGS, nowMs).action,
    'ping',
  );
  assert.equal(
    evaluateConversation(makeConv({ isSubagent: true, notFullyIdle: true, consecutivePings: 1, contextTokens: 120_000, contextPct: 23.4, lastCompletedAtMs: nowMs - 240_000 }), DEFAULT_SETTINGS, nowMs).action,
    'skip',
  );

  // Per-model cap: Claude allows up to 6 pings, Gemini (incl. Neon) stops at 2
  assert.equal(
    evaluateConversation(makeConv({ modelFamily: 'claude', modelStr: 'claude-sonnet', consecutivePings: 5, lastCompletedAtMs: nowMs - 266_000 }), DEFAULT_SETTINGS, nowMs).action,
    'ping',
  );
  assert.equal(
    evaluateConversation(makeConv({ modelFamily: 'claude', modelStr: 'claude-sonnet', consecutivePings: 6, lastCompletedAtMs: nowMs - 266_000 }), DEFAULT_SETTINGS, nowMs).action,
    'skip',
  );
  assert.equal(
    evaluateConversation(makeConv({ modelFamily: 'other', modelStr: 'gemini-4-neon', consecutivePings: 2, lastCompletedAtMs: nowMs - 180_000 }), DEFAULT_SETTINGS, nowMs).action,
    'skip',
  );

  // Start-to-start anchor: long generation (started 180s ago, completed 90s ago) triggers ping based on start time
  const s2s = evaluateConversation(
    makeConv({ lastGenStartedAtMs: nowMs - 180_000, lastCompletedAtMs: nowMs - 90_000 }),
    DEFAULT_SETTINGS,
    nowMs,
  );
  assert.equal(s2s.action, 'ping');
  assert.equal(s2s.idleSec, 90);
  assert.equal(s2s.cacheAgeSec, 180);
});

test('Controller dispatches ping, avoids duplicates in-flight, and reconciles cache-hit audit log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ch-test-'));
  try {
    let nowMs = 1_700_000_000_000;
    const settingsStore = createSettingsStore(join(dir, 'settings.json'));
    const eventLog = createEventLog(join(dir, 'events.json'));
    const sent = [];
    let currentConv = makeConv({ lastCompletedAtMs: nowMs - 180_000, latestGenIdx: 10, contextTokens: 200_000 });

    const ctrl = createPingController({
      readCandidates: () => [currentConv],
      sendPing: async (cid, msg) => { sent.push({ cid, msg }); return { ok: true }; },
      settingsStore,
      eventLog,
      nowFn: () => nowMs,
    });

    await ctrl.tick();
    assert.equal(sent.length, 1);
    assert.equal(eventLog.list()[0].outcome, 'pending');

    // While ping is in-flight (and model reports isRunning=true), must NOT double-send and must show ping_in_flight
    nowMs += 5_000;
    currentConv = makeConv({ ...currentConv, isRunning: true });
    await ctrl.tick();
    assert.equal(sent.length, 1);
    assert.equal(ctrl.getStatus().conversations[0].decision.reason, 'ping_in_flight');

    // Ping response lands with 198K cached -> audit resolves as 'hit'
    nowMs += 10_000;
    currentConv = makeConv({
      latestGenIdx: 11,
      consecutivePings: 1,
      lastCompletedAtMs: nowMs - 2_000,
      cachedIn: 198_000,
      uncachedIn: 2_500,
      contextTokens: 200_500,
    });
    await ctrl.tick();
    const audited = eventLog.list()[0];
    assert.equal(audited.outcome, 'hit');
    assert.equal(audited.actualHitPct, 99);
    assert.equal(sent.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Failed ping enters cooldown (not ping_in_flight) and stale pendingAudit expires cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ch-err-'));
  try {
    let nowMs = 1_700_000_000_000;
    const settingsStore = createSettingsStore(join(dir, 'settings.json'));
    const eventLog = createEventLog(join(dir, 'events.json'));
    let shouldFail = true;
    let currentConv = makeConv({ lastCompletedAtMs: nowMs - 180_000, latestGenIdx: 10, contextTokens: 200_000 });

    const ctrl = createPingController({
      readCandidates: () => [currentConv],
      sendPing: async () => {
        if (shouldFail) throw new Error('agentapi error');
        return { ok: true };
      },
      settingsStore,
      eventLog,
      nowFn: () => nowMs,
    });

    await ctrl.tick();
    assert.equal(eventLog.list()[0].outcome, 'error');
    assert.equal(ctrl.getStatus().conversations[0].decision.reason, 'ping_error_cooldown');

    nowMs += 10_000;
    await ctrl.tick();
    assert.equal(ctrl.getStatus().conversations[0].decision.reason, 'ping_error_cooldown');

    // Next turn succeeds, then >120s pass with no response -> pendingAudit expires without misattribution
    shouldFail = false;
    nowMs += 40_000;
    currentConv = makeConv({
      lastRealBoundaryIdx: 21,
      lastCompletedAtMs: nowMs - 180_000,
      latestGenIdx: 12,
      contextTokens: 200_000,
    });
    await ctrl.tick();
    assert.equal(eventLog.list()[0].outcome, 'pending');

    nowMs += 130_000;
    currentConv = makeConv({
      lastRealBoundaryIdx: 21,
      lastCompletedAtMs: nowMs - 2_000,
      latestGenIdx: 13,
      cachedIn: 190_000,
      uncachedIn: 10_000,
      contextTokens: 200_000,
    });
    await ctrl.tick();
    assert.equal(eventLog.list()[0].outcome, 'pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Rollback (Revert without trajectory_id rotation) and sudden-stale jump never trigger unsolicited pings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ch-rev-'));
  try {
    let nowMs = 1_700_000_000_000;
    const settingsStore = createSettingsStore(join(dir, 'settings.json'));
    const eventLog = createEventLog(join(dir, 'events.json'));
    const sent = [];

    let currentConv = makeConv({
      lastRealBoundaryIdx: 108,
      latestGenIdx: 36,
      lastCompletedAtMs: nowMs - 10_000,
      justReverted: false,
    });

    const ctrl = createPingController({
      readCandidates: () => [currentConv],
      sendPing: async (cid) => { sent.push(cid); return { ok: true }; },
      settingsStore,
      eventLog,
      nowFn: () => nowMs,
    });

    await ctrl.tick();
    assert.equal(sent.length, 0);

    // Revert rolls DB back to boundary 95 / gen 34 (209s ago) without trajectory_id rotation
    nowMs += 2_000;
    currentConv = makeConv({
      lastRealBoundaryIdx: 95,
      latestGenIdx: 34,
      lastCompletedAtMs: nowMs - 209_000,
      justReverted: false,
    });
    await ctrl.tick();
    assert.equal(sent.length, 0);

    // New message advances past rolled-back snapshot -> latch clears
    nowMs += 5_000;
    currentConv = makeConv({
      lastRealBoundaryIdx: 108,
      latestGenIdx: 35,
      lastCompletedAtMs: nowMs - 5_000,
      justReverted: false,
    });
    await ctrl.tick();
    assert.equal(ctrl.getStatus().conversations[0].decision.action, 'wait');

    // Second revert back to 95 / 34 -> caught again
    nowMs += 2_000;
    currentConv = makeConv({
      lastRealBoundaryIdx: 95,
      latestGenIdx: 34,
      lastCompletedAtMs: nowMs - 180_000,
      justReverted: false,
    });
    await ctrl.tick();
    assert.equal(sent.length, 0);

    // Fresh controller after restart seeing an unseen boundary at idle=209s -> blocked
    const freshCtrl = createPingController({
      readCandidates: () => [makeConv({
        conversationId: 'conv-fresh',
        lastRealBoundaryIdx: 95,
        latestGenIdx: 34,
        lastCompletedAtMs: nowMs - 209_000,
        justReverted: false,
      })],
      sendPing: async (cid) => { sent.push(cid); return { ok: true }; },
      settingsStore,
      eventLog,
      nowFn: () => nowMs,
    });
    await freshCtrl.tick();
    assert.equal(sent.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
