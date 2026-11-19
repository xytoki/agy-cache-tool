import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function createEventLog(
  filePath = join(homedir(), '.gemini', 'config', 'agy-cache-helper', 'events.json'),
  { maxEntries = 200 } = {},
) {
  let entries = [];
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) entries = parsed.slice(-maxEntries);
    }
  } catch {
    entries = [];
  }

  function persist() {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
      renameSync(tmp, filePath);
    } catch {
      // Non-fatal: keep in-memory entries even if disk write transiently fails.
    }
  }

  function record(entry) {
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestampMs: Date.now(),
      ...entry,
    };
    entries.push(item);
    if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
    persist();
    return item;
  }

  function updateById(id, patch) {
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0) return null;
    entries[idx] = { ...entries[idx], ...patch };
    persist();
    return entries[idx];
  }

  function list(limit = 50) {
    return entries.slice(-limit).reverse();
  }

  function clear() {
    entries = [];
    persist();
  }

  return { filePath, record, updateById, list, clear };
}
