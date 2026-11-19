import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, PING_MARKER } from '../agy-cache-helper/sidecars/cache_helper/settings.mjs';

test('Settings store preserves nested fields on partial updates, keeps PING_MARKER, and toggles conversation mute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-set-test-'));
  try {
    const store = createSettingsStore(join(dir, 'settings.json'));

    store.update({
      pingMessage: 'custom keep-alive text',
      modelIntervalsSec: { carbon: 170 },
      modelMaxPings: { claude: 10 },
    });
    const saved = store.read();
    assert.ok(saved.pingMessage.includes(PING_MARKER));
    assert.equal(saved.modelIntervalsSec.carbon, 170);
    assert.equal(saved.modelIntervalsSec.claude, 265);
    assert.equal(saved.modelMaxPings.claude, 10);
    assert.equal(saved.modelMaxPings.gemini, 2);

    store.toggleConversation('abc-123', false);
    assert.deepEqual(store.read().disabledConversations, ['abc-123']);
    store.toggleConversation('abc-123', true);
    assert.deepEqual(store.read().disabledConversations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
