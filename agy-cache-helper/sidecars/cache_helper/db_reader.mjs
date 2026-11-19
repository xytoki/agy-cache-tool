import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseGenRow, parseStepMeta } from './pb.mjs';
import { PING_MARKER } from './settings.mjs';

const PING_MARKER_BUF = Buffer.from(PING_MARKER, 'utf8');
const PING_CONTENT_MARKER_BUF = Buffer.from(`content=${PING_MARKER}`, 'utf8');
const MAX_PING_STEP_BYTES = 4096;
const MAX_PING_MARKER_OFFSET = 512;

function isPingSystemStep(row, markerBuf, contentMarkerBuf) {
  if (row.step_type !== 101 || !row.step_payload) return false;
  const buf = Buffer.isBuffer(row.step_payload) ? row.step_payload : Buffer.from(row.step_payload);
  if (buf.length > MAX_PING_STEP_BYTES) return false;
  if (buf.includes(contentMarkerBuf)) return true;
  const pos = buf.indexOf(markerBuf);
  return pos >= 0 && pos < MAX_PING_MARKER_OFFSET;
}

function fileStamp(dbPath) {
  try {
    const main = statSync(dbPath);
    let walKey = '';
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      const wal = statSync(walPath);
      walKey = `:${wal.mtimeMs}:${wal.size}`;
    }
    return `${main.mtimeMs}:${main.size}${walKey}`;
  } catch {
    return '';
  }
}

export function classifyModelFamily(modelStr = '', modelDisplay = '') {
  const s = `${modelStr} ${modelDisplay}`.toLowerCase();
  if (s.includes('claude')) return 'claude';
  if (s.includes('carbon')) return 'carbon';
  if (s.includes('hydrogen') || s.includes('flash')) return 'hydrogen';
  return 'other';
}

export function parseConversationDb(dbPath, { pingMarker = PING_MARKER } = {}) {
  const markerBuf = pingMarker === PING_MARKER ? PING_MARKER_BUF : Buffer.from(pingMarker, 'utf8');
  const contentMarkerBuf = pingMarker === PING_MARKER ? PING_CONTENT_MARKER_BUF : Buffer.from(`content=${pingMarker}`, 'utf8');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    const stepRows = db.prepare('SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx ASC').all();
    let trajectoryId = '';
    try {
      const metaRow = db.prepare('SELECT trajectory_id FROM trajectory_meta LIMIT 1').get();
      trajectoryId = metaRow?.trajectory_id ? String(metaRow.trajectory_id) : '';
    } catch {
      trajectoryId = '';
    }

    const gens = [];
    let maxContextTokens = 0;
    for (const row of genRows) {
      const parsed = parseGenRow(row.idx, row.data);
      if (!parsed) continue;
      if (parsed.maxContextTokens > 0) maxContextTokens = parsed.maxContextTokens;
      if (parsed.contextTokens > 0) gens.push(parsed);
    }

    const latestGen = gens.length > 0 ? gens[gens.length - 1] : null;
    const prevGen = gens.length > 1 ? gens[gens.length - 2] : null;

    const stepMetaByIdx = new Map();
    let latestUserStepIdx = -1;
    let latestUserCreatedAtMs = null;
    let latestCheckpointIdx = -1;
    let latestCheckpointCompletedMs = null;
    let lastRealBoundaryIdx = -1;
    let firstPingAfterBoundaryIdx = -1;
    let lastPingAfterBoundaryIdx = -1;
    let consecutivePings = 0;

    // First pass: find latest real boundary (USER_INPUT=14, CHECKPOINT=23, or non-ping SYSTEM_MESSAGE=101)
    for (const row of stepRows) {
      const isPingStep = isPingSystemStep(row, markerBuf, contentMarkerBuf);
      if (row.step_type === 14 && row.status !== 11) {
        latestUserStepIdx = row.idx;
        lastRealBoundaryIdx = row.idx;
      } else if (row.step_type === 23) {
        latestCheckpointIdx = row.idx;
        lastRealBoundaryIdx = row.idx;
      } else if (row.step_type === 101 && !isPingStep) {
        lastRealBoundaryIdx = row.idx;
      }
    }

    // Second pass: count consecutive ping steps after lastRealBoundaryIdx, parse timestamps around active tail
    let lastNonPingPlannerCompletedMs = null;
    let lastCompletedAtMs = null;
    let lastGenStartedAtMs = null;

    for (const row of stepRows) {
      const isPingStep = isPingSystemStep(row, markerBuf, contentMarkerBuf);
      if (row.idx > lastRealBoundaryIdx && isPingStep) {
        consecutivePings += 1;
        if (firstPingAfterBoundaryIdx < 0) firstPingAfterBoundaryIdx = row.idx;
        lastPingAfterBoundaryIdx = row.idx;
      }
      if (
        row.idx === latestUserStepIdx ||
        row.idx === latestCheckpointIdx ||
        row.step_type === 15 ||
        (latestGen && latestGen.stepIndices.includes(row.idx))
      ) {
        const meta = parseStepMeta(row.metadata);
        stepMetaByIdx.set(row.idx, meta);
        if (row.idx === latestUserStepIdx) {
          latestUserCreatedAtMs = meta.createdAtMs;
        }
        if (row.idx === latestCheckpointIdx) {
          latestCheckpointCompletedMs = meta.completedAtMs || meta.createdAtMs;
        }
        if (row.step_type === 15) {
          const doneMs = meta.completedAtMs || meta.createdAtMs;
          if (doneMs) {
            if (firstPingAfterBoundaryIdx < 0 || row.idx < firstPingAfterBoundaryIdx) {
              lastNonPingPlannerCompletedMs = doneMs;
            }
          }
        }
      }
    }

    const latestGenMaxStepIdx = latestGen
      ? Math.max(latestGen.lastStepIndex, ...(latestGen.stepIndices.length ? latestGen.stepIndices : [-1]))
      : -1;
    const justCompacted = latestCheckpointIdx >= 0 && latestCheckpointIdx > latestGenMaxStepIdx;
    const awaitingPingGen = lastPingAfterBoundaryIdx > lastRealBoundaryIdx && lastPingAfterBoundaryIdx > latestGenMaxStepIdx;
    const lastStepRow = stepRows.length > 0 ? stepRows[stepRows.length - 1] : null;
    // On Revert, Antigravity rotates trajectory_meta.trajectory_id to a fresh UUID and truncates steps,
    // which invalidates conversation-history KV cache (~15K system prompt only) and rolls lastCompletedAtMs back.
    const justReverted = Boolean(
      trajectoryId &&
      lastStepRow &&
      lastStepRow.step_payload &&
      !Buffer.from(lastStepRow.step_payload).includes(Buffer.from(trajectoryId, 'utf8')),
    );

    if (justCompacted && latestCheckpointCompletedMs) {
      lastCompletedAtMs = latestCheckpointCompletedMs;
      lastGenStartedAtMs = latestCheckpointCompletedMs;
    } else if (latestGen && latestGen.stepIndices.length > 0) {
      const firstS = Math.min(...latestGen.stepIndices);
      const meta = stepMetaByIdx.get(firstS);
      if (meta) {
        lastGenStartedAtMs = meta.createdAtMs || null;
        lastCompletedAtMs = meta.completedAtMs || (meta.createdAtMs && latestGen.durationSec ? meta.createdAtMs + latestGen.durationSec * 1000 : meta.createdAtMs);
      }
    }

    if (!lastCompletedAtMs && stepRows.length > 0) {
      const lastStep = stepRows[stepRows.length - 1];
      const meta = parseStepMeta(lastStep.metadata);
      lastCompletedAtMs = meta.completedAtMs || meta.createdAtMs;
    }
    if (!lastGenStartedAtMs) {
      lastGenStartedAtMs = lastCompletedAtMs;
    }

    let lastRealTurnDurationSec = null;
    if (!justCompacted && latestUserCreatedAtMs && lastNonPingPlannerCompletedMs && lastNonPingPlannerCompletedMs >= latestUserCreatedAtMs) {
      lastRealTurnDurationSec = (lastNonPingPlannerCompletedMs - latestUserCreatedAtMs) / 1000;
    }

    const contextTokens = justCompacted ? 0 : (latestGen ? latestGen.contextTokens : 0);
    const contextPct = justCompacted ? 0 : (maxContextTokens > 0 ? (contextTokens / maxContextTokens) * 100 : null);
    const latestCacheHitPct =
      latestGen && prevGen && prevGen.contextTokens > 0
        ? Math.min(100, (latestGen.cachedIn / prevGen.contextTokens) * 100)
        : latestGen && latestGen.contextTokens > 0
          ? (latestGen.cachedIn / latestGen.contextTokens) * 100
          : 0;

    return {
      latestGenIdx: latestGen ? latestGen.idx : -1,
      modelStr: latestGen?.modelStr || '',
      modelDisplay: latestGen?.modelDisplay || '',
      modelFamily: classifyModelFamily(latestGen?.modelStr, latestGen?.modelDisplay),
      contextTokens,
      maxContextTokens,
      contextPct,
      justCompacted,
      justReverted,
      trajectoryId,
      latestCheckpointIdx,
      cachedIn: latestGen?.cachedIn || 0,
      uncachedIn: latestGen?.uncachedIn || 0,
      outTokens: latestGen?.outTokens || 0,
      latestCacheHitPct,
      lastGenStartedAtMs: lastGenStartedAtMs || 0,
      lastCompletedAtMs: lastCompletedAtMs || 0,
      latestUserStepIdx,
      lastRealBoundaryIdx,
      consecutivePings,
      awaitingPingGen,
      lastRealTurnDurationSec,
    };
  } finally {
    db.close();
  }
}

export function createAntigravityReader({
  appDataDir = join(homedir(), '.gemini', 'antigravity'),
  recentWindowMs = 25 * 60 * 1000,
} = {}) {
  const summariesDbPath = join(appDataDir, 'conversation_summaries.db');
  const convDir = join(appDataDir, 'conversations');
  const dbCache = new Map(); // cid -> { stamp, parsed }

  function readSingleConversation(cid) {
    const dbPath = join(convDir, `${cid}.db`);
    if (!existsSync(dbPath)) return null;
    const stamp = fileStamp(dbPath);
    const cached = dbCache.get(cid);
    if (cached && cached.stamp === stamp) return cached.parsed;
    try {
      const parsed = parseConversationDb(dbPath);
      dbCache.set(cid, { stamp, parsed });
      if (dbCache.size > 100) {
        const oldestKey = dbCache.keys().next().value;
        dbCache.delete(oldestKey);
      }
      return parsed;
    } catch {
      return cached?.parsed || null;
    }
  }

  function readCandidates(nowMs = Date.now()) {
    if (!existsSync(summariesDbPath)) return [];
    let rows = [];
    const db = new DatabaseSync(summariesDbPath, { readOnly: true });
    try {
      rows = db.prepare(`
        SELECT
          conversation_id,
          title,
          status,
          project_id,
          parent_conversation_id,
          nesting_depth,
          agent_name,
          not_fully_idle,
          killed,
          last_modified_time
        FROM conversation_summaries
      `).all();
    } finally {
      db.close();
    }

    // Track which parent conversations currently have an active child subagent
    const activeChildrenByParent = new Map();
    for (const row of rows) {
      const parentId = row.parent_conversation_id || '';
      if (!parentId) continue;
      const childActive =
        row.status === 'CASCADE_RUN_STATUS_RUNNING' ||
        Number(row.not_fully_idle) === 1;
      if (childActive && Number(row.killed) !== 1) {
        activeChildrenByParent.set(parentId, (activeChildrenByParent.get(parentId) || 0) + 1);
      }
    }

    const cutoffMs = nowMs - recentWindowMs;
    const candidates = [];

    for (const row of rows) {
      if (Number(row.killed) === 1) continue;
      const cid = row.conversation_id;
      const modMs = Date.parse(row.last_modified_time || '') || 0;
      const isRunning = row.status === 'CASCADE_RUN_STATUS_RUNNING';
      const notFullyIdle = Number(row.not_fully_idle) === 1;
      const activeChildCount = activeChildrenByParent.get(cid) || 0;

      // Only scan conversations that are active, have active background/children, or modified recently
      if (!isRunning && !notFullyIdle && activeChildCount === 0 && modMs < cutoffMs) {
        continue;
      }

      const detail = readSingleConversation(cid);
      if (!detail || detail.latestGenIdx < 0) continue;

      const isSubagent = Boolean(row.parent_conversation_id) || Number(row.nesting_depth) > 0 || Boolean(row.agent_name);

      candidates.push({
        conversationId: cid,
        title: row.title || cid.slice(0, 8),
        projectId: row.project_id || '',
        status: row.status || '',
        // Use conversation_summaries.status as the authoritative run state:
        // backgrounded run_command/schedule steps stay status=2 even while the cascade itself is IDLE.
        isRunning,
        isPingRunning: isRunning && Boolean(detail.awaitingPingGen),
        isSubagent,
        parentConversationId: row.parent_conversation_id || '',
        notFullyIdle,
        activeChildCount,
        hasActiveBackground: notFullyIdle || activeChildCount > 0,
        lastModifiedMs: modMs,
        ...detail,
      });
    }

    candidates.sort((a, b) => (b.lastCompletedAtMs || b.lastModifiedMs) - (a.lastCompletedAtMs || a.lastModifiedMs));
    return candidates;
  }

  return { readCandidates, readSingleConversation };
}
