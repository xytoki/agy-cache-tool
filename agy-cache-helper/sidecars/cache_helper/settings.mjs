import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PING_MARKER = '[agy-cache-ping]';

export const DEFAULT_PING_MESSAGE =
  `${PING_MARKER} Cache keep-alive heartbeat. Reply with "ok" only and do not call any tools.`;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  dryRun: false,
  minContextPct: 20,
  maxContextPct: 90,
  minContextTokensFallback: 100000,
  maxContextTokensFallback: 460000,
  shortTurnMaxSec: 300,
  maxPingsPerTurn: 2,
  modelMaxPings: {
    gemini: 2,
    claude: 6,
    other: 2,
  },
  staleGraceSec: 20,
  modelIntervalsSec: {
    carbon: 175,
    hydrogen: 235,
    claude: 265,
    other: 175,
  },
  enableSubagentBgPing: true,
  subagentMinTokens: 50000,
  subagentMaxPings: 1,
  subagentIntervalSec: 235,
  pingMessage: DEFAULT_PING_MESSAGE,
  disabledConversations: [],
  // Tail-end warm compaction
  compactEnabled: true,
  compactExecuteMode: 'execute',
  compactThresholdPct: 90,
  compactThresholdTokensFallback: 460000,
  compactLongTurnThresholdPct: 80,
  compactLongTurnTokensFallback: 410000,
  compactLongTurnMinSec: 300,
  compactCountdownSec: 60,
  compactStaleGraceSec: 60,
  enableFooterBadge: true,
  compactDisabledConversations: [],
});

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawIntervals = src.modelIntervalsSec && typeof src.modelIntervalsSec === 'object'
    ? src.modelIntervalsSec
    : {};
  const rawMaxPings = src.modelMaxPings && typeof src.modelMaxPings === 'object'
    ? src.modelMaxPings
    : {};
  const disabledRaw = Array.isArray(src.disabledConversations) ? src.disabledConversations : [];
  const disabledConversations = [...new Set(
    disabledRaw.filter(id => typeof id === 'string' && /^[0-9a-zA-Z_-]+$/.test(id))
  )].slice(-200);
  const compactDisabledRaw = Array.isArray(src.compactDisabledConversations) ? src.compactDisabledConversations : [];
  const compactDisabledConversations = [...new Set(
    compactDisabledRaw.filter(id => typeof id === 'string' && /^[0-9a-zA-Z_-]+$/.test(id))
  )].slice(-200);

  let pingMessage = typeof src.pingMessage === 'string' && src.pingMessage.trim()
    ? src.pingMessage.trim()
    : DEFAULT_PING_MESSAGE;
  if (!pingMessage.includes(PING_MARKER)) {
    pingMessage = `${PING_MARKER} ${pingMessage}`;
  }

  const minContextPct = clampInt(src.minContextPct, 0, 89, DEFAULT_SETTINGS.minContextPct);
  const maxContextPct = clampInt(src.maxContextPct, Math.max(minContextPct + 1, 10), 100, DEFAULT_SETTINGS.maxContextPct);
  const compactThresholdPct = clampInt(src.compactThresholdPct, 50, 99, DEFAULT_SETTINGS.compactThresholdPct);
  const compactLongTurnThresholdPct = clampInt(
    src.compactLongTurnThresholdPct,
    40,
    compactThresholdPct,
    DEFAULT_SETTINGS.compactLongTurnThresholdPct,
  );
  const compactExecuteMode =
    src.compactExecuteMode === 'execute' || src.compactExecuteMode === 'detect_only'
      ? src.compactExecuteMode
      : DEFAULT_SETTINGS.compactExecuteMode;

  const legacyMaxPings = clampInt(src.maxPingsPerTurn, 1, 15, DEFAULT_SETTINGS.maxPingsPerTurn);
  const hasLegacyMaxPings = src.maxPingsPerTurn !== undefined && src.modelMaxPings === undefined;

  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_SETTINGS.enabled,
    dryRun: typeof src.dryRun === 'boolean' ? src.dryRun : DEFAULT_SETTINGS.dryRun,
    minContextPct,
    maxContextPct,
    minContextTokensFallback: clampInt(src.minContextTokensFallback, 0, 500000, DEFAULT_SETTINGS.minContextTokensFallback),
    maxContextTokensFallback: clampInt(src.maxContextTokensFallback, 50000, 2000000, DEFAULT_SETTINGS.maxContextTokensFallback),
    shortTurnMaxSec: clampInt(src.shortTurnMaxSec, 30, 3600, DEFAULT_SETTINGS.shortTurnMaxSec),
    maxPingsPerTurn: clampInt(src.maxPingsPerTurn, 1, 5, DEFAULT_SETTINGS.maxPingsPerTurn),
    modelMaxPings: {
      gemini: clampInt(
        rawMaxPings.gemini,
        1,
        10,
        hasLegacyMaxPings ? Math.min(10, legacyMaxPings) : DEFAULT_SETTINGS.modelMaxPings.gemini,
      ),
      claude: clampInt(rawMaxPings.claude, 1, 15, DEFAULT_SETTINGS.modelMaxPings.claude),
      other: clampInt(
        rawMaxPings.other,
        1,
        10,
        hasLegacyMaxPings ? Math.min(10, legacyMaxPings) : DEFAULT_SETTINGS.modelMaxPings.other,
      ),
    },
    staleGraceSec: clampInt(src.staleGraceSec, 10, 600, DEFAULT_SETTINGS.staleGraceSec),
    modelIntervalsSec: {
      carbon: clampInt(rawIntervals.carbon, 60, 600, DEFAULT_SETTINGS.modelIntervalsSec.carbon),
      hydrogen: clampInt(rawIntervals.hydrogen, 60, 600, DEFAULT_SETTINGS.modelIntervalsSec.hydrogen),
      claude: clampInt(rawIntervals.claude, 60, 600, DEFAULT_SETTINGS.modelIntervalsSec.claude),
      other: clampInt(rawIntervals.other, 60, 600, DEFAULT_SETTINGS.modelIntervalsSec.other),
    },
    enableSubagentBgPing: typeof src.enableSubagentBgPing === 'boolean'
      ? src.enableSubagentBgPing
      : DEFAULT_SETTINGS.enableSubagentBgPing,
    subagentMinTokens: clampInt(src.subagentMinTokens, 10000, 500000, DEFAULT_SETTINGS.subagentMinTokens),
    subagentMaxPings: clampInt(src.subagentMaxPings, 1, 3, DEFAULT_SETTINGS.subagentMaxPings),
    subagentIntervalSec: clampInt(src.subagentIntervalSec, 60, 600, DEFAULT_SETTINGS.subagentIntervalSec),
    pingMessage,
    disabledConversations,
    compactEnabled: typeof src.compactEnabled === 'boolean' ? src.compactEnabled : DEFAULT_SETTINGS.compactEnabled,
    compactExecuteMode,
    compactThresholdPct,
    compactThresholdTokensFallback: clampInt(
      src.compactThresholdTokensFallback,
      100000,
      2000000,
      DEFAULT_SETTINGS.compactThresholdTokensFallback,
    ),
    compactLongTurnThresholdPct,
    compactLongTurnTokensFallback: clampInt(
      src.compactLongTurnTokensFallback,
      100000,
      2000000,
      DEFAULT_SETTINGS.compactLongTurnTokensFallback,
    ),
    compactLongTurnMinSec: clampInt(src.compactLongTurnMinSec, 60, 3600, DEFAULT_SETTINGS.compactLongTurnMinSec),
    compactCountdownSec: clampInt(src.compactCountdownSec, 15, 180, DEFAULT_SETTINGS.compactCountdownSec),
    compactStaleGraceSec: clampInt(src.compactStaleGraceSec, 15, 300, DEFAULT_SETTINGS.compactStaleGraceSec),
    enableFooterBadge: typeof src.enableFooterBadge === 'boolean' ? src.enableFooterBadge : DEFAULT_SETTINGS.enableFooterBadge,
    compactDisabledConversations,
  };
}

export function createSettingsStore(filePath = join(homedir(), '.gemini', 'config', 'agy-cache-helper', 'settings.json')) {
  let cached = normalizeSettings(DEFAULT_SETTINGS);
  let lastStat = '';

  function read() {
    try {
      const stat = statSync(filePath);
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (key !== lastStat) {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        cached = normalizeSettings(raw);
        lastStat = key;
      }
    } catch {
      cached = normalizeSettings(DEFAULT_SETTINGS);
      lastStat = '';
    }
    return structuredClone(cached);
  }

  function update(patch) {
    const current = read();
    const merged = {
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
      modelIntervalsSec: {
        ...current.modelIntervalsSec,
        ...(patch?.modelIntervalsSec && typeof patch.modelIntervalsSec === 'object' ? patch.modelIntervalsSec : {}),
      },
      modelMaxPings: {
        ...current.modelMaxPings,
        ...(patch?.modelMaxPings && typeof patch.modelMaxPings === 'object' ? patch.modelMaxPings : {}),
      },
    };
    const next = normalizeSettings(merged);
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
    lastStat = '';
    return read();
  }

  function toggleConversation(conversationId, allowed) {
    const current = read();
    const set = new Set(current.disabledConversations);
    if (allowed) set.delete(conversationId);
    else set.add(conversationId);
    return update({ disabledConversations: [...set] });
  }

  function toggleCompactConversation(conversationId, allowed) {
    const current = read();
    const set = new Set(current.compactDisabledConversations);
    if (allowed) set.delete(conversationId);
    else set.add(conversationId);
    return update({ compactDisabledConversations: [...set] });
  }

  return { filePath, read, update, toggleConversation, toggleCompactConversation };
}
