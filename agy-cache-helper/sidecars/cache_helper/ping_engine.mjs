import { DEFAULT_SETTINGS } from './settings.mjs';
import { evaluateCompact } from './compact_engine.mjs';

export function resolveMaxPingsGroup(conv) {
  const fam = conv.modelFamily || '';
  const text = `${conv.modelStr || ''} ${conv.modelDisplay || ''}`.toLowerCase();
  if (fam === 'claude' || text.includes('claude')) return 'claude';
  if (fam === 'carbon' || fam === 'hydrogen' || text.includes('gemini')) return 'gemini';
  return 'other';
}

export function resolveIntervalAndLimit(conv, settings = DEFAULT_SETTINGS) {
  if (conv.isSubagent) {
    return {
      intervalSec: settings.subagentIntervalSec,
      maxPings: settings.subagentMaxPings,
    };
  }
  const fam = conv.modelFamily || 'other';
  const intervalSec = settings.modelIntervalsSec?.[fam] ?? settings.modelIntervalsSec?.other ?? 175;
  const pingGroup = resolveMaxPingsGroup(conv);
  const maxPings =
    settings.modelMaxPings?.[pingGroup] ??
    settings.maxPingsPerTurn ??
    DEFAULT_SETTINGS.modelMaxPings[pingGroup] ??
    2;
  return {
    intervalSec,
    maxPings,
  };
}

/**
 * Evaluates whether a conversation is eligible for a mid-context keep-alive ping.
 * Timing is anchored to the latest generation start (prefill) timestamp when available.
 * Returns { action: 'ping' | 'wait' | 'skip', reason, idleSec, cacheAgeSec, nextPingInSec, intervalSec, maxPings, pingNumber }.
 */
export function evaluateConversation(conv, settings, nowMs, runtime = {}) {
  const { intervalSec, maxPings } = resolveIntervalAndLimit(conv, settings);
  const idleSec = conv.lastCompletedAtMs > 0 ? Math.max(0, (nowMs - conv.lastCompletedAtMs) / 1000) : null;
  const cacheAnchorMs = conv.lastGenStartedAtMs > 0 ? conv.lastGenStartedAtMs : conv.lastCompletedAtMs;
  const cacheAgeSec = cacheAnchorMs > 0 ? Math.max(0, (nowMs - cacheAnchorMs) / 1000) : null;

  const base = {
    conversationId: conv.conversationId,
    intervalSec,
    maxPings,
    idleSec,
    cacheAgeSec,
    nextPingInSec: null,
    pingNumber: conv.consecutivePings + 1,
  };

  if ((runtime.inFlightUntilMs && nowMs < runtime.inFlightUntilMs) || conv.isPingRunning) {
    return { ...base, action: 'wait', reason: 'ping_in_flight' };
  }

  if (runtime.retryCooldownUntilMs && nowMs < runtime.retryCooldownUntilMs) {
    return { ...base, action: 'skip', reason: 'ping_error_cooldown' };
  }

  if (!settings.enabled) {
    return { ...base, action: 'skip', reason: 'global_disabled' };
  }

  if (Array.isArray(settings.disabledConversations) && settings.disabledConversations.includes(conv.conversationId)) {
    return { ...base, action: 'skip', reason: 'conversation_muted' };
  }

  if (conv.isRunning) {
    return { ...base, action: 'skip', reason: 'running' };
  }

  if (conv.justCompacted) {
    return { ...base, action: 'skip', reason: 'just_compacted_no_cache' };
  }

  if (conv.justReverted) {
    return { ...base, action: 'skip', reason: 'just_reverted_no_cache' };
  }

  if (cacheAgeSec === null) {
    return { ...base, action: 'skip', reason: 'no_timestamp' };
  }

  // Context window bounds
  const hasMax = conv.maxContextTokens > 0 && conv.contextPct !== null;
  if (conv.isSubagent) {
    if (!settings.enableSubagentBgPing) {
      return { ...base, action: 'skip', reason: 'subagent_disabled' };
    }
    if (!conv.notFullyIdle) {
      return { ...base, action: 'skip', reason: 'subagent_idle_no_bg_cmd' };
    }
    if (conv.contextTokens < settings.subagentMinTokens) {
      return { ...base, action: 'skip', reason: 'subagent_context_too_small' };
    }
    if (hasMax && conv.contextPct >= settings.maxContextPct) {
      return { ...base, action: 'skip', reason: 'context_above_tail_threshold' };
    }
  } else {
    if (hasMax) {
      if (conv.contextPct < settings.minContextPct) {
        return { ...base, action: 'skip', reason: 'context_below_min' };
      }
      if (conv.contextPct >= settings.maxContextPct) {
        return { ...base, action: 'skip', reason: 'context_tail_compact_zone' };
      }
    } else {
      if (conv.contextTokens < settings.minContextTokensFallback) {
        return { ...base, action: 'skip', reason: 'context_below_min' };
      }
      if (conv.contextTokens >= settings.maxContextTokensFallback) {
        return { ...base, action: 'skip', reason: 'context_tail_compact_zone' };
      }
    }

    // Main conversation gate: either actively waiting on background subagent/command, OR short discussion turn (<= 5m)
    const isShortTurn =
      conv.lastRealTurnDurationSec === null || conv.lastRealTurnDurationSec <= settings.shortTurnMaxSec;
    if (!conv.hasActiveBackground && !isShortTurn) {
      return { ...base, action: 'skip', reason: 'long_turn_likely_away' };
    }
  }

  // Enforce the per-turn ping limit using both DB step counts and in-memory dispatches
  const effectivePings = Math.max(conv.consecutivePings || 0, runtime.localPingCountForBoundary || 0);
  if (effectivePings >= maxPings) {
    return { ...base, pingNumber: effectivePings, action: 'skip', reason: 'max_pings_reached' };
  }

  // Skip stale conversations whose cache has already expired.
  // Cap grace on first observation of a boundary to avoid firing immediately after a restart, wake-from-sleep, or revert.
  const effectiveGraceSec = runtime.sawCountdownForBoundary
    ? (settings.staleGraceSec ?? 20)
    : Math.min(settings.staleGraceSec ?? 20, 20);
  const maxStaleSec = intervalSec + effectiveGraceSec;
  if (cacheAgeSec > maxStaleSec) {
    return { ...base, action: 'skip', reason: 'stale_already_expired' };
  }

  if (cacheAgeSec < intervalSec) {
    return {
      ...base,
      pingNumber: effectivePings + 1,
      action: 'wait',
      reason: 'counting_down',
      nextPingInSec: Math.max(0, intervalSec - cacheAgeSec),
    };
  }

  return {
    ...base,
    pingNumber: effectivePings + 1,
    action: 'ping',
    reason: conv.isSubagent
      ? 'subagent_bg_command'
      : conv.hasActiveBackground
        ? 'waiting_background'
        : 'discussion_short_turn',
    nextPingInSec: 0,
  };
}

export function createPingController({
  readCandidates,
  sendPing,
  settingsStore,
  eventLog,
  onCompactReady = null,
  executeCompact = null,
  pollMs = 2000,
  nowFn = () => Date.now(),
}) {
  // cid -> { inFlightUntilMs, retryCooldownUntilMs, boundaryIdx, localPingCount, pendingAudit, compactAudit, compact: { ... } }
  const runtimeByCid = new Map();
  // pageId -> { conversationId, hasDraft, updatedAtMs }
  const frontendPages = new Map();
  let lastEvaluated = [];
  let timer = null;
  let ticking = false;
  let needsRetick = false;

  function makeCompactRuntime() {
    return {
      cancelled: false,
      triggered: false,
      triggeredAtMs: 0,
      deadlineMs: null,
      remainingOnPauseSec: null,
      previewMode: false,
      previewStartedAtMs: null,
      errorCount: 0,
    };
  }

  function getRuntime(cid, convOrBoundaryIdx) {
    const isObj = convOrBoundaryIdx && typeof convOrBoundaryIdx === 'object';
    const boundaryIdx = isObj ? convOrBoundaryIdx.lastRealBoundaryIdx : convOrBoundaryIdx;
    const genIdx = isObj ? (convOrBoundaryIdx.latestGenIdx ?? -1) : -1;

    let rt = runtimeByCid.get(cid);
    if (!rt) {
      rt = {
        inFlightUntilMs: 0,
        retryCooldownUntilMs: 0,
        boundaryIdx,
        maxBoundaryIdx: boundaryIdx,
        maxGenIdx: genIdx,
        revertedAt: null,
        sawCountdownForBoundary: false,
        localPingCount: 0,
        pendingAudit: null,
        compactAudit: null,
        compact: makeCompactRuntime(),
      };
      runtimeByCid.set(cid, rt);
      return rt;
    }

    // Detect history rollback when step or generation indices decrease, independent of trajectory_id rotation
    const rolledBack =
      boundaryIdx < rt.maxBoundaryIdx ||
      (genIdx >= 0 && rt.maxGenIdx >= 0 && genIdx < rt.maxGenIdx);

    if (rolledBack) {
      rt.revertedAt = { boundaryIdx, genIdx };
      rt.boundaryIdx = boundaryIdx;
      rt.maxBoundaryIdx = boundaryIdx;
      rt.maxGenIdx = genIdx;
      rt.sawCountdownForBoundary = false;
      rt.localPingCount = 0;
      rt.inFlightUntilMs = 0;
      rt.retryCooldownUntilMs = 0;
      rt.pendingAudit = null;
      rt.compactAudit = null;
      rt.compact = makeCompactRuntime();
      return rt;
    }

    if (rt.revertedAt) {
      const advanced =
        boundaryIdx > rt.revertedAt.boundaryIdx ||
        (genIdx >= 0 && rt.revertedAt.genIdx >= 0 && genIdx > rt.revertedAt.genIdx);
      if (advanced) {
        rt.revertedAt = null;
      }
    }

    if (rt.boundaryIdx !== boundaryIdx) {
      // Real new boundary arrived (user message / non-ping system message / checkpoint) -> reset per-turn state
      rt.boundaryIdx = boundaryIdx;
      rt.sawCountdownForBoundary = false;
      rt.localPingCount = 0;
      rt.inFlightUntilMs = 0;
      rt.retryCooldownUntilMs = 0;
      rt.compact = makeCompactRuntime();
    }

    if (boundaryIdx > rt.maxBoundaryIdx) rt.maxBoundaryIdx = boundaryIdx;
    if (genIdx > rt.maxGenIdx) rt.maxGenIdx = genIdx;
    return rt;
  }

  function getFrontendInfoForCid(cid, nowMs) {
    let isForeground = false;
    let hasDraft = false;
    for (const info of frontendPages.values()) {
      if (nowMs - info.updatedAtMs > 8_000) continue;
      if (info.conversationId === cid) {
        isForeground = true;
        if (info.hasDraft) hasDraft = true;
      }
    }
    return { isForeground, hasDraft };
  }

  function reportPageState(pageId, state) {
    if (!pageId) return;
    frontendPages.set(pageId, {
      conversationId: state?.conversationId || '',
      hasDraft: Boolean(state?.hasDraft),
      updatedAtMs: nowFn(),
    });
  }

  function removePageState(pageId) {
    frontendPages.delete(pageId);
  }

  const PENDING_AUDIT_MAX_AGE_MS = 120_000;
  const PENDING_COMPACT_AUDIT_MAX_AGE_MS = 90_000;

  function reconcilePendingCompactAudit(conv, rt, nowMs) {
    const p = rt.compactAudit;
    if (!p) return;
    if (conv.justCompacted || conv.latestCheckpointIdx > p.preCheckpointIdx) {
      eventLog.updateById(p.eventId, {
        outcome: 'executed',
        verifiedAtMs: nowMs,
        checkpointIdx: conv.latestCheckpointIdx,
      });
      rt.compactAudit = null;
      return;
    }
    if (p.sentAtMs && nowMs - p.sentAtMs > PENDING_COMPACT_AUDIT_MAX_AGE_MS) {
      eventLog.updateById(p.eventId, { outcome: 'unverified' });
      rt.compactAudit = null;
    }
  }

  function reconcilePendingAudit(conv, rt, nowMs) {
    const p = rt.pendingAudit;
    if (!p) return;
    if (conv.justCompacted || conv.justReverted || (p.sentAtMs && nowMs - p.sentAtMs > PENDING_AUDIT_MAX_AGE_MS)) {
      rt.pendingAudit = null;
      rt.inFlightUntilMs = 0;
      return;
    }
    if (conv.latestGenIdx > p.preGenIdx) {
      const hitRatio = p.preContextTokens > 0
        ? Math.min(100, (conv.cachedIn / p.preContextTokens) * 100)
        : conv.latestCacheHitPct;
      eventLog.updateById(p.eventId, {
        outcome: hitRatio >= 50 ? 'hit' : 'miss',
        actualCachedIn: conv.cachedIn,
        actualUncachedIn: conv.uncachedIn,
        actualOutTokens: conv.outTokens,
        actualHitPct: Number(hitRatio.toFixed(1)),
        verifiedAtMs: nowMs,
      });
      rt.pendingAudit = null;
      rt.inFlightUntilMs = 0;
    }
  }

  async function dispatchPing(conv, decision, settings, manual = false) {
    const nowMs = nowFn();
    const rt = getRuntime(conv.conversationId, conv.lastRealBoundaryIdx);
    rt.inFlightUntilMs = nowMs + 90_000;
    rt.retryCooldownUntilMs = 0;
    if (!manual) {
      rt.localPingCount = Math.max(rt.localPingCount, conv.consecutivePings) + 1;
    }

    const logItem = eventLog.record({
      type: manual ? 'manual_ping' : (settings.dryRun ? 'dry_run_ping' : 'ping'),
      conversationId: conv.conversationId,
      title: conv.title,
      role: conv.isSubagent ? 'subagent' : 'main',
      model: conv.modelStr || conv.modelDisplay,
      contextTokens: conv.contextTokens,
      contextPct: conv.contextPct !== null ? Number(conv.contextPct.toFixed(1)) : null,
      idleSec: decision.idleSec !== null ? Math.round(decision.idleSec) : null,
      cacheAgeSec: decision.cacheAgeSec !== null ? Math.round(decision.cacheAgeSec) : null,
      pingNumber: decision.pingNumber,
      maxPings: decision.maxPings,
      reason: manual ? 'manual_trigger' : decision.reason,
      outcome: settings.dryRun && !manual ? 'dry_run' : 'pending',
    });

    if (settings.dryRun && !manual) {
      rt.inFlightUntilMs = 0;
      rt.retryCooldownUntilMs = nowMs + 5_000;
      return { ok: true, dryRun: true, event: logItem };
    }

    try {
      await sendPing(conv.conversationId, settings.pingMessage, { projectId: conv.projectId });
      rt.pendingAudit = {
        eventId: logItem.id,
        preGenIdx: conv.latestGenIdx,
        preContextTokens: conv.contextTokens,
        sentAtMs: nowMs,
      };
      return { ok: true, dryRun: false, event: logItem };
    } catch (err) {
      rt.inFlightUntilMs = 0;
      rt.retryCooldownUntilMs = nowMs + 30_000;
      eventLog.updateById(logItem.id, {
        outcome: 'error',
        error: err?.message || String(err),
      });
      return { ok: false, error: err?.message || String(err), event: logItem };
    }
  }

  async function handleCompactReady(conv, compactDecision, settings, isForeground) {
    const nowMs = nowFn();
    const rt = getRuntime(conv.conversationId, conv.lastRealBoundaryIdx);
    rt.compact.triggered = true;
    rt.compact.triggeredAtMs = nowMs;
    rt.compact.deadlineMs = null;
    rt.compact.remainingOnPauseSec = null;

    const canExecute =
      settings.compactExecuteMode === 'execute' &&
      !settings.dryRun &&
      typeof executeCompact === 'function' &&
      !compactDecision.preview;
    const dryBlocked =
      settings.compactExecuteMode === 'execute' &&
      settings.dryRun &&
      !compactDecision.preview;

    const event = eventLog.record({
      type: compactDecision.preview ? 'compact_preview_ready' : 'compact_ready',
      conversationId: conv.conversationId,
      title: conv.title,
      role: conv.isSubagent ? 'subagent' : 'main',
      model: conv.modelStr || conv.modelDisplay,
      contextTokens: conv.contextTokens,
      contextPct: conv.contextPct !== null ? Number(conv.contextPct.toFixed(1)) : null,
      idleSec: compactDecision.idleSec !== null ? Math.round(compactDecision.idleSec) : null,
      turnDurationSec: conv.lastRealTurnDurationSec !== null ? Math.round(conv.lastRealTurnDurationSec) : null,
      tier: compactDecision.tier,
      reason: compactDecision.reason,
      foreground: isForeground,
      hasActiveBackground: Boolean(conv.hasActiveBackground),
      outcome: canExecute ? 'pending' : dryBlocked ? 'dry_run' : 'detect_only',
    });

    // onCompactReady observes every non-preview trigger; executeCompact runs only in execute mode outside dryRun
    if (typeof onCompactReady === 'function' && !compactDecision.preview) {
      try {
        await onCompactReady(conv, compactDecision, settings, event);
      } catch (err) {
        eventLog.updateById(event.id, {
          outcome: 'error',
          error: err?.message || String(err),
        });
      }
    }

    if (canExecute) {
      try {
        const res = await executeCompact(conv, compactDecision, settings, event);
        rt.compact.errorCount = 0;
        rt.compactAudit = {
          eventId: event.id,
          preCheckpointIdx: conv.latestCheckpointIdx,
          sentAtMs: nowMs,
        };
        if (res && res.planModel) {
          eventLog.updateById(event.id, { planModel: res.planModel });
        }
      } catch (err) {
        eventLog.updateById(event.id, {
          outcome: 'error',
          error: err?.message || String(err),
        });
        // Re-arm with a fresh deadline so a transient failure retries after
        // another countdown instead of silently disabling compaction for the
        // rest of the turn (clearing triggered alone would trip the
        // stale-missed-window guard). Give up after a few consecutive failures.
        rt.compact.errorCount = (rt.compact.errorCount || 0) + 1;
        if (rt.compact.errorCount < 3) {
          rt.compact.triggered = false;
          rt.compact.triggeredAtMs = 0;
          rt.compact.deadlineMs = nowMs + (settings.compactCountdownSec ?? 60) * 1000;
        }
      }
    }
  }

  async function tick() {
    if (ticking) {
      needsRetick = true;
      return lastEvaluated;
    }
    ticking = true;
    try {
      const nowMs = nowFn();
      const settings = settingsStore.read();
      const candidates = readCandidates(nowMs);
      const nextEvaluated = [];

      for (const conv of candidates) {
        const rt = getRuntime(conv.conversationId, conv);
        const effectiveConv = rt.revertedAt && !conv.justReverted
          ? { ...conv, justReverted: true }
          : conv;
        reconcilePendingAudit(effectiveConv, rt, nowMs);
        reconcilePendingCompactAudit(effectiveConv, rt, nowMs);

        if (effectiveConv.isRunning) {
          rt.compact.deadlineMs = null;
          rt.compact.remainingOnPauseSec = null;
          rt.compact.previewMode = false;
          rt.compact.previewStartedAtMs = null;
        }

        const { isForeground, hasDraft } = getFrontendInfoForCid(effectiveConv.conversationId, nowMs);
        let compact = evaluateCompact(effectiveConv, settings, nowMs, {
          ...rt.compact,
          hasDraft,
        });

        if (compact.nextState) {
          rt.compact.deadlineMs = compact.nextState.deadlineMs;
          rt.compact.remainingOnPauseSec = compact.nextState.remainingOnPauseSec;
        }

        if (compact.action === 'ready') {
          await handleCompactReady(effectiveConv, compact, settings, isForeground);
          compact = {
            ...compact,
            action: 'done',
            reason: compact.preview
              ? 'compact_preview_done'
              : settings.compactExecuteMode === 'execute' && !settings.dryRun
                ? 'compact_fired'
                : 'compact_ready_detect_only',
            triggeredAtMs: rt.compact.triggeredAtMs,
            active: false,
          };
        }

        let decision = evaluateConversation(effectiveConv, settings, nowMs, {
          inFlightUntilMs: rt.inFlightUntilMs,
          retryCooldownUntilMs: rt.retryCooldownUntilMs,
          localPingCountForBoundary: rt.localPingCount,
          sawCountdownForBoundary: rt.sawCountdownForBoundary,
        });

        if (decision.action === 'wait' && decision.reason === 'counting_down') {
          rt.sawCountdownForBoundary = true;
        }

        // Tail-end compaction countdown takes precedence over mid-context ping
        if (compact.active && !compact.preview && decision.action !== 'skip') {
          decision = {
            ...decision,
            action: 'skip',
            reason: 'context_tail_compact_zone',
            nextPingInSec: null,
          };
        }

        const entry = {
          ...effectiveConv,
          decision,
          compact,
          isForeground,
          hasDraft,
          muted: settings.disabledConversations.includes(effectiveConv.conversationId),
          compactMuted: settings.compactDisabledConversations.includes(effectiveConv.conversationId),
        };
        nextEvaluated.push(entry);

        if (decision.action === 'ping') {
          // Reflect in-flight status immediately in UI while agentapi runs
          entry.decision = { ...decision, action: 'wait', reason: 'ping_in_flight', nextPingInSec: null };
          // Fire sequentially to avoid bursting agentapi subprocesses simultaneously
          const res = await dispatchPing(effectiveConv, decision, settings, false);
          if (!res.ok) {
            entry.decision = { ...decision, action: 'skip', reason: 'ping_error_cooldown', nextPingInSec: null };
          }
        }
      }

      lastEvaluated = nextEvaluated;
      return lastEvaluated;
    } finally {
      ticking = false;
      if (needsRetick) {
        needsRetick = false;
        void tick();
      }
    }
  }

  function cancelCompact(conversationId, source = 'ui') {
    const nowMs = nowFn();
    const conv = lastEvaluated.find(c => c.conversationId === conversationId);
    const rt = conv ? getRuntime(conversationId, conv.lastRealBoundaryIdx) : runtimeByCid.get(conversationId);
    if (!rt) return { ok: false, error: 'Conversation not tracked' };

    const prevRem = rt.compact.remainingOnPauseSec !== null && rt.compact.remainingOnPauseSec !== undefined
      ? rt.compact.remainingOnPauseSec
      : (rt.compact.deadlineMs ? Math.max(0, (rt.compact.deadlineMs - nowMs) / 1000) : null);
    const wasPreview = rt.compact.previewMode;
    const prevTier = conv?.compact?.tier || (wasPreview ? 'preview_test' : null);

    // Cancelling a preview countdown must not suppress real tail-end compaction for the current turn
    if (!wasPreview) {
      rt.compact.cancelled = true;
    }
    rt.compact.deadlineMs = null;
    rt.compact.remainingOnPauseSec = null;
    rt.compact.previewMode = false;
    rt.compact.previewStartedAtMs = null;

    if (conv) {
      conv.compact = {
        ...conv.compact,
        action: 'skip',
        reason: wasPreview ? 'compact_below_threshold' : 'compact_cancelled_turn',
        remainingSec: null,
        deadlineMs: null,
        preview: false,
        active: false,
      };
      eventLog.record({
        type: wasPreview ? 'compact_preview_cancelled' : 'compact_cancelled',
        conversationId: conv.conversationId,
        title: conv.title,
        role: conv.isSubagent ? 'subagent' : 'main',
        model: conv.modelStr || conv.modelDisplay,
        contextTokens: conv.contextTokens,
        contextPct: conv.contextPct !== null ? Number(conv.contextPct.toFixed(1)) : null,
        remainingSec: prevRem !== null ? Math.round(prevRem) : null,
        tier: prevTier,
        reason: `cancelled_by_${source}`,
        outcome: 'cancelled',
      });
    }
    void tick();
    return { ok: true, remainingSec: prevRem !== null ? Math.round(prevRem) : null };
  }

  function resumeCompact(conversationId) {
    const nowMs = nowFn();
    const settings = settingsStore.read();
    const conv = lastEvaluated.find(c => c.conversationId === conversationId);
    const rt = conv ? getRuntime(conversationId, conv.lastRealBoundaryIdx) : runtimeByCid.get(conversationId);
    if (!rt) return { ok: false, error: 'Conversation not tracked' };
    const countdownSec = settings.compactCountdownSec ?? 60;
    const deadlineMs = nowMs + countdownSec * 1000;
    rt.compact.cancelled = false;
    rt.compact.triggered = false;
    rt.compact.triggeredAtMs = 0;
    rt.compact.errorCount = 0;
    rt.compact.remainingOnPauseSec = null;
    rt.compact.deadlineMs = deadlineMs;
    if (conv) {
      conv.compact = {
        ...conv.compact,
        action: 'countdown',
        remainingSec: countdownSec,
        deadlineMs,
        active: true,
      };
    }
    void tick();
    return { ok: true };
  }

  function startCompactPreview(conversationId) {
    const nowMs = nowFn();
    const settings = settingsStore.read();
    const candidates = readCandidates(nowMs);
    const conv = candidates.find(c => c.conversationId === conversationId);
    if (!conv) return { ok: false, error: 'Conversation not found in recent active list' };
    if (conv.isRunning) return { ok: false, error: 'Conversation is currently running' };
    const countdownSec = settings.compactCountdownSec ?? 60;
    const deadlineMs = nowMs + countdownSec * 1000;
    const rt = getRuntime(conv.conversationId, conv.lastRealBoundaryIdx);
    rt.compact = {
      cancelled: false,
      triggered: false,
      triggeredAtMs: 0,
      deadlineMs,
      remainingOnPauseSec: null,
      previewMode: true,
      previewStartedAtMs: nowMs,
      errorCount: 0,
    };
    const existing = lastEvaluated.find(c => c.conversationId === conversationId);
    if (existing) {
      existing.compact = {
        conversationId,
        tier: 'preview_test',
        idleSec: existing.compact?.idleSec ?? 0,
        countdownSec,
        remainingSec: countdownSec,
        deadlineMs,
        preview: true,
        active: true,
        action: 'countdown',
        reason: 'compact_preview_countdown',
      };
    }
    void tick();
    return { ok: true, countdownSec };
  }

  function getFooterSnapshot(activeConversationId = '') {
    const settings = settingsStore.read();
    if (!settings.enableFooterBadge) {
      return { current: null, background: [], detectOnly: true };
    }
    const nowMs = nowFn();
    let current = null;
    const background = [];

    for (const c of lastEvaluated) {
      const cmp = c.compact;
      if (!cmp || (cmp.action !== 'countdown' && cmp.action !== 'paused')) continue;
      const remainingSec = cmp.action === 'countdown' && cmp.deadlineMs
        ? Math.max(0, (cmp.deadlineMs - nowMs) / 1000)
        : (cmp.remainingSec ?? 0);
      const item = {
        conversationId: c.conversationId,
        title: c.title,
        contextPct: c.contextPct !== null ? Math.round(c.contextPct) : null,
        contextTokens: c.contextTokens,
        action: cmp.action,
        tier: cmp.tier,
        reason: cmp.reason,
        remainingSec: Math.ceil(remainingSec),
        deadlineMs: cmp.deadlineMs,
        preview: Boolean(cmp.preview),
        hasActiveBackground: Boolean(c.hasActiveBackground),
      };
      if (activeConversationId && c.conversationId === activeConversationId) {
        current = item;
      } else {
        background.push(item);
      }
    }

    background.sort((a, b) => a.remainingSec - b.remainingSec);
    return {
      current,
      background,
      detectOnly: settings.compactExecuteMode === 'detect_only' || settings.dryRun,
    };
  }

  async function triggerManualPing(conversationId) {
    const nowMs = nowFn();
    const settings = settingsStore.read();
    const candidates = readCandidates(nowMs);
    const conv = candidates.find(c => c.conversationId === conversationId);
    if (!conv) return { ok: false, error: 'Conversation not found in recent active list' };
    const decision = evaluateConversation(conv, settings, nowMs, {});
    const existing = lastEvaluated.find(c => c.conversationId === conversationId);
    if (existing) {
      existing.decision = { ...existing.decision, action: 'wait', reason: 'ping_in_flight', nextPingInSec: null };
    }
    const res = await dispatchPing(conv, decision, settings, true);
    void tick();
    return res;
  }

  function start() {
    if (timer) return;
    void tick();
    timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus(extra = {}) {
    return {
      nowMs: nowFn(),
      settings: settingsStore.read(),
      conversations: lastEvaluated,
      events: eventLog.list(60),
      ...extra,
    };
  }

  return {
    start,
    stop,
    tick,
    getStatus,
    triggerManualPing,
    cancelCompact,
    resumeCompact,
    startCompactPreview,
    reportPageState,
    removePageState,
    getFooterSnapshot,
  };
}
