import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConversationDb } from '../agy-cache-helper/sidecars/cache_helper/db_reader.mjs';
import { PING_MARKER } from '../agy-cache-helper/sidecars/cache_helper/settings.mjs';

function encodeVarint(n) {
  const bytes = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function fieldVarint(fn, val) {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(val)]);
}

function fieldBytes(fn, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(b.length), b]);
}

function encodeTimestamp(sec) {
  return fieldVarint(1, Math.floor(sec));
}

function encodeStepMeta(createdSec, completedSec = null) {
  const parts = [fieldBytes(1, encodeTimestamp(createdSec))];
  if (completedSec !== null) parts.push(fieldBytes(8, encodeTimestamp(completedSec)));
  return Buffer.concat(parts);
}

function encodeGenMeta({ stepIndices, modelStr, uncachedIn, cachedIn, outTokens, maxCtx }) {
  const packedSteps = Buffer.concat(stepIndices.map(encodeVarint));
  const usage = Buffer.concat([
    fieldVarint(2, uncachedIn),
    fieldVarint(3, outTokens),
    ...(cachedIn > 0 ? [fieldVarint(5, cachedIn)] : []),
  ]);
  const m10 = fieldVarint(4, maxCtx);
  const m9 = fieldBytes(10, m10);
  const m1 = Buffer.concat([
    fieldVarint(3, 1437),
    fieldBytes(4, usage),
    fieldBytes(9, m9),
    fieldBytes(19, modelStr),
    fieldBytes(21, 'Gemini 4 Carbon (Medium)'),
  ]);
  return Buffer.concat([fieldBytes(2, packedSteps), fieldBytes(1, m1)]);
}

test('parseConversationDb tracks consecutive pings, preserves real turn duration, and resets on real messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-db-test-'));
  const dbPath = join(dir, 'sample.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);

    const insStep = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)');
    const insGen = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');

    const t0 = 1_795_000_000;
    // Real user turn: t0 -> t0+40s (short 40s turn)
    insStep.run(0, 14, 3, encodeStepMeta(t0), Buffer.from('user question'));
    insStep.run(1, 15, 3, encodeStepMeta(t0 + 1, t0 + 40), Buffer.from('reply'));
    insGen.run(0, encodeGenMeta({ stepIndices: [1], modelStr: 'gemini-4-carbon', uncachedIn: 200_000, cachedIn: 0, outTokens: 300, maxCtx: 512_000 }));

    // Ping #1 at t0 + 215s
    insStep.run(2, 101, 3, encodeStepMeta(t0 + 215), Buffer.from(`${PING_MARKER} keep alive`));
    insStep.run(3, 15, 3, encodeStepMeta(t0 + 216, t0 + 220), Buffer.from('ok'));
    insGen.run(1, encodeGenMeta({ stepIndices: [3], modelStr: 'gemini-4-carbon', uncachedIn: 2000, cachedIn: 199_000, outTokens: 10, maxCtx: 512_000 }));
    db.close();

    const snap1 = parseConversationDb(dbPath);
    assert.equal(snap1.consecutivePings, 1);
    assert.equal(snap1.lastRealTurnDurationSec, 40); // Reflects real turn duration, excluding subsequent ping replies
    assert.equal(snap1.lastGenStartedAtMs, (t0 + 216) * 1000);
    assert.equal(snap1.lastCompletedAtMs, (t0 + 220) * 1000);
    assert.equal(snap1.modelFamily, 'carbon');
    assert.equal(snap1.contextTokens, 201_000);

    // Now a real non-ping SYSTEM_MESSAGE arrives (e.g. subagent completion) -> consecutivePings resets to 0
    const db2 = new DatabaseSync(dbPath);
    db2.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
      4, 101, 3, encodeStepMeta(t0 + 300), Buffer.from('[Message] subagent completed build'),
    );
    db2.close();

    const snap2 = parseConversationDb(dbPath);
    assert.equal(snap2.consecutivePings, 0);
    assert.equal(snap2.lastRealBoundaryIdx, 4);
    assert.equal(snap2.justCompacted, false);

    // Now manual /compact happens: USER_INPUT (idx 5) + CHECKPOINT step_type=23 (idx 6, done at t0+500) without new gen_metadata
    const db3 = new DatabaseSync(dbPath);
    db3.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
      5, 14, 3, encodeStepMeta(t0 + 450), Buffer.from('/compact'),
    );
    db3.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
      6, 23, 3, encodeStepMeta(t0 + 450, t0 + 500), Buffer.from('summary'),
    );
    db3.close();

    const snap3 = parseConversationDb(dbPath);
    assert.equal(snap3.justCompacted, true);
    assert.equal(snap3.lastCompletedAtMs, (t0 + 500) * 1000);
    assert.equal(snap3.contextTokens, 0);
    assert.equal(snap3.contextPct, 0);
    assert.equal(snap3.consecutivePings, 0);
    assert.equal(snap3.justReverted, false);

    // Simulate Revert: trajectory_meta.trajectory_id rotates to a new UUID while last step still has old payload
    const db4 = new DatabaseSync(dbPath);
    db4.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT);');
    db4.prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id) VALUES (?, ?)').run(
      '9784d833-206b-4059-98c5-8fa0f4b5113d',
      'conv-1',
    );
    db4.close();

    const snap4 = parseConversationDb(dbPath);
    assert.equal(snap4.justReverted, true);

    // Next real message under new trajectory_id clears justReverted
    const db5 = new DatabaseSync(dbPath);
    db5.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
      7, 14, 3, encodeStepMeta(t0 + 600), Buffer.from('revised prompt 9784d833-206b-4059-98c5-8fa0f4b5113d'),
    );
    db5.close();

    const snap5 = parseConversationDb(dbPath);
    assert.equal(snap5.justReverted, false);

    // Large non-ping SYSTEM_MESSAGE (e.g. post-compact rehydration quoting "[agy-cache-ping]") must NOT be misclassified as a ping
    const db6 = new DatabaseSync(dbPath);
    const largeRehydration = Buffer.from('A'.repeat(6000) + ` quoted ${PING_MARKER} inside docs ` + '9784d833-206b-4059-98c5-8fa0f4b5113d');
    db6.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
      8, 101, 3, encodeStepMeta(t0 + 620), largeRehydration,
    );
    db6.close();

    const snap6 = parseConversationDb(dbPath);
    assert.equal(snap6.consecutivePings, 0);
    assert.equal(snap6.awaitingPingGen, false);
    assert.equal(snap6.lastRealBoundaryIdx, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
