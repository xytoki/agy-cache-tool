import { DEFAULT_SETTINGS } from './settings.mjs';

export const DRAFT_RESUME_GRACE_SEC = 15;

/**
 * Evaluates whether an idle main conversation should enter, hold, or complete
 * a tail-end warm compaction countdown.
 *
 * Rules:
 * - Applies exclusively to main conversations (subagents are excluded).
 * - Tier 1 (`tail_90_pct`): main conversation is IDLE and context >= compactThresholdPct (default 90%).
 *   Triggers even when subagents or background run_command tasks are active, so warm compaction
 *   completes before returning subagents exhaust the remaining context window.
 * - Tier 2 (`long_turn_80_pct`): main conversation is IDLE with no active background tasks,
 *   last real turn duration > compactLongTurnMinSec (default 300s), and context >= compactLongTurnThresholdPct (default 80%).
 * - Returns `action: 'ready'` when the countdown expires so the controller can log or execute compaction.
 *
 * Returns:
 * {
 *   action: 'countdown' | 'paused' | 'ready' | 'done' | 'skip',
 *   reason,
 *   tier: 'tail_90_pct' | 'long_turn_80_pct' | 'preview_test' | null,
 *   idleSec,
 *   countdownSec,
 *   remainingSec,
 *   deadlineMs,
 *   preview: boolean,
 *   active: boolean,
 *   nextState?: { deadlineMs, remainingOnPauseSec }
 * }
 */
export function evaluateCompact(conv, settings = DEFAULT_SETTINGS, nowMs = Date.now(), runtime = {}) {
  const countdownSec = settings.compactCountdownSec ?? DEFAULT_SETTINGS.compactCountdownSec;
  const staleGraceSec = settings.compactStaleGraceSec ?? DEFAULT_SETTINGS.compactStaleGraceSec;
  const idleSec = conv.lastCompletedAtMs > 0 ? Math.max(0, (nowMs - conv.lastCompletedAtMs) / 1000) : null;

  const base = {
    conversationId: conv.conversationId,
    tier: null,
    idleSec,
    countdownSec,
    remainingSec: null,
    deadlineMs: null,
    preview: Boolean(runtime.previewMode),
    active: false,
  };

  if (conv.isRunning) {
    return { ...base, action: 'skip', reason: 'running' };
  }

  if (conv.justCompacted) {
    return { ...base, action: 'skip', reason: 'just_compacted' };
  }

  if (conv.justReverted && !runtime.previewMode) {
    return { ...base, action: 'skip', reason: 'just_reverted' };
  }

  // Preview mode runs a countdown on any idle main conversation without affecting real eligibility
  if (runtime.previewMode) {
    const tier = 'preview_test';
    if (runtime.cancelled) {
      return { ...base, tier, action: 'skip', reason: 'compact_cancelled_turn' };
    }
    if (runtime.triggered) {
      return {
        ...base,
        tier,
        action: 'done',
        reason: 'compact_preview_done',
        triggeredAtMs: runtime.triggeredAtMs || nowMs,
      };
    }

    const startMs = runtime.previewStartedAtMs || nowMs;
    const baseDeadlineMs = runtime.deadlineMs ?? (startMs + countdownSec * 1000);

    if (runtime.hasDraft) {
      const frozenRem = runtime.remainingOnPauseSec !== null && runtime.remainingOnPauseSec !== undefined
        ? runtime.remainingOnPauseSec
        : Math.max(0, (baseDeadlineMs - nowMs) / 1000);
      return {
        ...base,
        tier,
        action: 'paused',
        reason: 'compact_paused_draft',
        remainingSec: frozenRem,
        deadlineMs: null,
        active: true,
        nextState: { deadlineMs: null, remainingOnPauseSec: frozenRem },
      };
    }

    let deadlineMs = baseDeadlineMs;
    if (runtime.remainingOnPauseSec !== null && runtime.remainingOnPauseSec !== undefined) {
      const resumedRem = Math.max(DRAFT_RESUME_GRACE_SEC, Math.min(countdownSec, runtime.remainingOnPauseSec));
      deadlineMs = nowMs + resumedRem * 1000;
    }

    const remainingSec = Math.max(0, (deadlineMs - nowMs) / 1000);
    if (remainingSec <= 0) {
      return {
        ...base,
        tier,
        action: 'ready',
        reason: 'compact_preview_ready',
        remainingSec: 0,
        deadlineMs,
        active: true,
        nextState: { deadlineMs, remainingOnPauseSec: null },
      };
    }
    return {
      ...base,
      tier,
      action: 'countdown',
      reason: 'compact_preview_countdown',
      remainingSec,
      deadlineMs,
      active: true,
      nextState: { deadlineMs, remainingOnPauseSec: null },
    };
  }

  if (!settings.compactEnabled) {
    return { ...base, action: 'skip', reason: 'compact_disabled' };
  }

  if (conv.isSubagent) {
    return { ...base, action: 'skip', reason: 'compact_subagent_excluded' };
  }

  if (
    Array.isArray(settings.compactDisabledConversations) &&
    settings.compactDisabledConversations.includes(conv.conversationId)
  ) {
    return { ...base, action: 'skip', reason: 'compact_conversation_muted' };
  }

  if (idleSec === null) {
    return { ...base, action: 'skip', reason: 'no_timestamp' };
  }

  const hasMax = conv.maxContextTokens > 0 && conv.contextPct !== null;
  const hitTail90 = hasMax
    ? conv.contextPct >= settings.compactThresholdPct
    : conv.contextTokens >= settings.compactThresholdTokensFallback;

  const isLongTurn =
    conv.lastRealTurnDurationSec !== null &&
    conv.lastRealTurnDurationSec > settings.compactLongTurnMinSec;

  const hitLongTurn80 =
    isLongTurn &&
    !conv.hasActiveBackground &&
    (hasMax
      ? conv.contextPct >= settings.compactLongTurnThresholdPct
      : conv.contextTokens >= settings.compactLongTurnTokensFallback);

  const tier = hitTail90 ? 'tail_90_pct' : hitLongTurn80 ? 'long_turn_80_pct' : null;
  if (!tier) {
    return { ...base, action: 'skip', reason: 'compact_below_threshold' };
  }

  if (runtime.cancelled) {
    return { ...base, tier, action: 'skip', reason: 'compact_cancelled_turn' };
  }

  if (runtime.triggered) {
    return {
      ...base,
      tier,
      action: 'done',
      reason: 'compact_ready_detect_only',
      triggeredAtMs: runtime.triggeredAtMs || nowMs,
      active: false,
    };
  }

  const hasTrackedCountdown = Boolean(runtime.deadlineMs) || runtime.remainingOnPauseSec !== null && runtime.remainingOnPauseSec !== undefined;
  if (!hasTrackedCountdown && idleSec > countdownSec) {
    // Skip conversations already past the warm window on first observation to avoid compacting cold sessions on startup.
    return { ...base, tier, action: 'skip', reason: 'compact_stale_missed_window' };
  }

  const baseDeadlineMs = runtime.deadlineMs ?? (conv.lastCompletedAtMs + countdownSec * 1000);

  if (runtime.hasDraft) {
    const frozenRem =
      runtime.remainingOnPauseSec !== null && runtime.remainingOnPauseSec !== undefined
        ? runtime.remainingOnPauseSec
        : Math.max(0, (baseDeadlineMs - nowMs) / 1000);
    return {
      ...base,
      tier,
      action: 'paused',
      reason: 'compact_paused_draft',
      remainingSec: frozenRem,
      deadlineMs: null,
      active: true,
      nextState: { deadlineMs: null, remainingOnPauseSec: frozenRem },
    };
  }

  let deadlineMs = baseDeadlineMs;
  if (runtime.remainingOnPauseSec !== null && runtime.remainingOnPauseSec !== undefined) {
    // Resumed after user cleared draft. Skip if cache has already gone cold during a very long pause.
    const maxPauseWarmSec = Math.max(countdownSec + staleGraceSec, 180);
    if (idleSec > maxPauseWarmSec) {
      return {
        ...base,
        tier,
        action: 'skip',
        reason: 'compact_stale_after_pause',
        nextState: { deadlineMs: null, remainingOnPauseSec: null },
      };
    }
    const resumedRem = Math.max(DRAFT_RESUME_GRACE_SEC, Math.min(countdownSec, runtime.remainingOnPauseSec));
    deadlineMs = nowMs + resumedRem * 1000;
  }

  const remainingSec = Math.max(0, (deadlineMs - nowMs) / 1000);
  if (remainingSec <= 0) {
    return {
      ...base,
      tier,
      action: 'ready',
      reason: tier === 'tail_90_pct' ? 'compact_ready_tail_90' : 'compact_ready_long_turn_80',
      remainingSec: 0,
      deadlineMs,
      active: true,
      nextState: { deadlineMs, remainingOnPauseSec: null },
    };
  }

  return {
    ...base,
    tier,
    action: 'countdown',
    reason: tier === 'tail_90_pct' ? 'compact_countdown_tail_90' : 'compact_countdown_long_turn_80',
    remainingSec,
    deadlineMs,
    active: true,
    nextState: { deadlineMs, remainingOnPauseSec: null },
  };
}
