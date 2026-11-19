// Minimal zero-dependency protobuf wire-format decoder for Antigravity SQLite blobs.

export function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(val), i];
    shift += 7n;
    if (i - offset >= 10) break;
  }
  throw new Error('truncated varint');
}

export function parsePbMap(buf) {
  const fields = new Map();
  if (!buf || buf.length === 0) return fields;
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let i = 0;
  while (i < data.length) {
    try {
      const [tag, next] = readVarint(data, i);
      i = next;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, nI] = readVarint(data, i);
        i = nI;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(data, i);
        i = nI;
        if (len < 0 || i + len > data.length) break;
        fields.get(fn).push(data.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        if (i + 4 > data.length) break;
        fields.get(fn).push(data.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        if (i + 8 > data.length) break;
        fields.get(fn).push(data.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

export function decodePackedVarints(values = []) {
  const out = [];
  for (const v of values) {
    if (typeof v === 'number') {
      out.push(v);
    } else if (Buffer.isBuffer(v)) {
      let off = 0;
      while (off < v.length) {
        try {
          const [n, next] = readVarint(v, off);
          out.push(n);
          off = next;
        } catch {
          break;
        }
      }
    }
  }
  return out;
}

export function parseTimestampMs(buf) {
  if (!buf || buf.length === 0) return null;
  const fields = parsePbMap(buf);
  if (!fields.has(1)) return null;
  const sec = Number(fields.get(1)[0] || 0);
  const nanos = Number(fields.get(2)?.[0] || 0);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000 + nanos / 1e6;
}

export function parseDurationSec(buf) {
  if (!buf || buf.length === 0) return null;
  const fields = parsePbMap(buf);
  const sec = Number(fields.get(1)?.[0] || 0);
  const nanos = Number(fields.get(2)?.[0] || 0);
  return sec + nanos / 1e9;
}

export function parseGenRow(idx, data) {
  if (!data) return null;
  const top = parsePbMap(data);
  if (!top.has(1)) return null;
  const stepIndices = decodePackedVarints(top.get(2) || []);
  const m1 = parsePbMap(top.get(1)[0]);
  const modelEnum = m1.get(3)?.[0] ?? 0;
  const modelStr = m1.get(19)?.[0]?.toString('utf8') || '';
  const modelDisplay = m1.get(21)?.[0]?.toString('utf8') || '';
  const ttftSec = parseDurationSec(m1.get(11)?.[0]);
  const streamingSec = parseDurationSec(m1.get(12)?.[0]);
  const durationSec = ttftSec !== null || streamingSec !== null
    ? (ttftSec || 0) + (streamingSec || 0)
    : null;

  const usageBuf = m1.get(4)?.[0];
  const usage = usageBuf ? parsePbMap(usageBuf) : new Map();
  const uncachedIn = Number(usage.get(2)?.[0] || 0);
  const outTokens = Number(usage.get(3)?.[0] || 0);
  const cachedIn = Number(usage.get(5)?.[0] || 0);
  const contextTokens = uncachedIn + cachedIn;

  let maxContextTokens = 0;
  const m9Buf = m1.get(9)?.[0];
  if (m9Buf) {
    const m9 = parsePbMap(m9Buf);
    const m10Buf = m9.get(10)?.[0];
    if (m10Buf) {
      const m10 = parsePbMap(m10Buf);
      maxContextTokens = Number(m10.get(4)?.[0] || 0);
    }
  }

  let lastStepIndex = -1;
  let trajectoryId = '';
  for (const kvBuf of m1.get(20) || []) {
    const kv = parsePbMap(kvBuf);
    const k = kv.get(1)?.[0]?.toString('utf8') || '';
    const v = kv.get(2)?.[0]?.toString('utf8') || '';
    if (k === 'last_step_index') {
      const n = Number(v);
      if (Number.isFinite(n)) lastStepIndex = n;
    } else if (k === 'trajectory_id') {
      trajectoryId = v;
    }
  }

  return {
    idx,
    stepIndices,
    modelEnum,
    modelStr,
    modelDisplay,
    durationSec,
    uncachedIn,
    cachedIn,
    contextTokens,
    outTokens,
    maxContextTokens,
    lastStepIndex,
    trajectoryId,
  };
}

export function parseStepMeta(buf) {
  if (!buf || buf.length === 0) {
    return { createdAtMs: null, completedAtMs: null, toolName: '' };
  }
  const fields = parsePbMap(buf);
  const createdAtMs = parseTimestampMs(fields.get(1)?.[0]);
  const completedAtMs =
    parseTimestampMs(fields.get(8)?.[0]) ||
    parseTimestampMs(fields.get(7)?.[0]) ||
    parseTimestampMs(fields.get(6)?.[0]);
  let toolName = '';
  const m4Buf = fields.get(4)?.[0];
  if (m4Buf) {
    const m4 = parsePbMap(m4Buf);
    toolName = m4.get(2)?.[0]?.toString('utf8') || '';
  }
  return { createdAtMs, completedAtMs, toolName };
}
