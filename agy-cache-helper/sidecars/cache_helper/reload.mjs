import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function startSelfReloadWatcher(directory, onChanged, { pollMs = 1000, settleMs = 1500 } = {}) {
  const pluginDirectory = resolve(directory, '../..');
  const snapshot = () => {
    try {
      if (existsSync(join(pluginDirectory, '.update-in-progress'))) return null;
      const files = readdirSync(directory).filter(name => /\.(mjs|js|json|html|css)$/.test(name)).sort();
      return JSON.stringify(
        [...files.map(name => join(directory, name)), join(pluginDirectory, 'plugin.json')].map(file => {
          const stat = statSync(file);
          return [file, stat.mtimeMs, stat.size];
        }),
      );
    } catch {
      return null;
    }
  };
  let baseline = snapshot();
  let pending = null;
  let changedAt = 0;
  const timer = setInterval(() => {
    const current = snapshot();
    if (current === null || current === baseline) { pending = null; return; }
    if (baseline === null) { baseline = current; return; }
    if (current !== pending) { pending = current; changedAt = Date.now(); return; }
    if (Date.now() - changedAt < settleMs) return;
    clearInterval(timer);
    onChanged();
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
