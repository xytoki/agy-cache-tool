import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompactSender, createLsRpcClient } from '../agy-cache-helper/sidecars/cache_helper/compact_rpc.mjs';

function mockFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const method = url.split('/').pop();
    const handler = handlers[method];
    if (!handler) {
      return { status: 404, text: async () => JSON.stringify({ code: 'not_found', message: 'no mock' }) };
    }
    return { status: 200, text: async () => JSON.stringify(handler(calls.length - 1, JSON.parse(opts.body || '{}'))) };
  };
  fn.calls = calls;
  return fn;
}

test('hub discovery: env vars win, daemon dir picks newest hub_*.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-rpc-'));
  try {
    writeFileSync(join(dir, 'hub_1000.json'), JSON.stringify({ pid: 1, httpPort: 1000, httpsPort: 999, csrfToken: 'old', lsVersion: '2.30.0' }));
    writeFileSync(join(dir, 'hub_2000.json'), JSON.stringify({ pid: 2, httpPort: 2000, httpsPort: 1999, csrfToken: 'new', lsVersion: '2.33.0' }));
    writeFileSync(join(dir, 'not_a_hub.txt'), '{}');
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'hub_1000.json'), past, past);

    const fromDaemon = createLsRpcClient({ env: {}, daemonDir: dir, fetchImpl: async () => { throw new Error('unused'); } });
    const hub = fromDaemon.getHub();
    assert.equal(hub.port, 2000);
    assert.equal(hub.csrfToken, 'new');

    const fromEnv = createLsRpcClient({
      env: { ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:3000', ANTIGRAVITY_CSRF_TOKEN: 'envtok' },
      daemonDir: dir,
      fetchImpl: async () => { throw new Error('unused'); },
    });
    assert.equal(fromEnv.getHub().port, 3000);
    assert.equal(fromEnv.getHub().csrfToken, 'envtok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc posts Connect-style JSON with csrf header and throws on error code', async () => {
  const fetchImpl = mockFetch({
    Heartbeat: () => ({ ok: true }),
    Failing: () => ({ code: 'invalid_argument', message: 'bad field' }),
  });
  const client = createLsRpcClient({
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5555', ANTIGRAVITY_CSRF_TOKEN: 'tok123' },
    daemonDir: join(tmpdir(), 'definitely-missing'),
    fetchImpl,
  });

  const res = await client.rpc('Heartbeat', {});
  assert.equal(res.ok, true);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:5555/exa.language_server_pb.LanguageServerService/Heartbeat');
  assert.equal(call.opts.headers['x-codeium-csrf-token'], 'tok123');
  assert.equal(call.opts.headers['Content-Type'], 'application/json');

  await assert.rejects(() => client.rpc('Failing', {}), /bad field/);
});

test('sendCompact replays last USER_INPUT userConfig from the trajectory', async () => {
  const fetchImpl = mockFetch({
    GetCascadeTrajectory: () => ({
      trajectory: {
        steps: [
          { type: 'CORTEX_STEP_TYPE_CHECKPOINT' },
          {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            userInput: {
              items: [{ text: 'hi' }],
              userConfig: {
                plannerConfig: {
                  planModel: 'MODEL_PLACEHOLDER_M532',
                  toolConfig: {
                    runCommand: { autoCommandConfig: { autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_SAFE' } },
                  },
                  useAiCredits: true,
                  supportsLatexRendering: false,
                },
                executorConfig: { useCoreDirect: true },
                conversationHistoryConfig: {},
              },
            },
          },
          { type: 'CORTEX_STEP_TYPE_GENERATOR_RESPONSE' },
        ],
      },
    }),
    SendUserCascadeMessage: () => ({}),
  });
  const client = createLsRpcClient({
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5555', ANTIGRAVITY_CSRF_TOKEN: 'tok123' },
    daemonDir: join(tmpdir(), 'definitely-missing'),
    fetchImpl,
  });
  const sender = createCompactSender({ client });
  const res = await sender.sendCompact('conv-xyz');
  assert.equal(res.ok, true);
  assert.equal(res.planModel, 'MODEL_PLACEHOLDER_M532');

  assert.equal(fetchImpl.calls.length, 2);
  const traj = fetchImpl.calls[0];
  assert.ok(traj.url.endsWith('/GetCascadeTrajectory'));
  assert.equal(JSON.parse(traj.opts.body).cascadeId, 'conv-xyz');

  const send = fetchImpl.calls[1];
  assert.ok(send.url.endsWith('/SendUserCascadeMessage'));
  const body = JSON.parse(send.opts.body);
  assert.equal(body.cascadeId, 'conv-xyz');
  assert.deepEqual(body.items, [
    { item: { slashCommand: { info: { name: 'compact', type: 'SLASH_COMMAND_TYPE_SYSTEM', icon: 'collapse_all' } } } },
    { text: ' ' },
  ]);
  const pc = body.cascadeConfig.plannerConfig;
  assert.equal(pc.planModel, 'MODEL_PLACEHOLDER_M532');
  assert.equal(pc.toolConfig.runCommand.autoCommandConfig.autoExecutionPolicy, 'CASCADE_COMMANDS_AUTO_EXECUTION_SAFE');
  assert.equal(pc.useAiCredits, true);
  assert.equal(pc.supportsLatexRendering, false);
  assert.equal(body.cascadeConfig.executorConfig.useCoreDirect, true);
  assert.equal(body.customAgentSpec.builtinAgent.defaultAgent.surface, 'AGENT_SURFACE_HUB');
  assert.equal(body.deliveryStrategy, 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION');
  assert.match(body.clientMessageId, /^[0-9a-f-]{36}$/);
});

test('sendCompact falls back to metadata staticConfig when trajectory has no usable plannerConfig', async () => {
  const fetchImpl = mockFetch({
    GetCascadeTrajectory: () => ({
      trajectory: {
        steps: [
          { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: 'hi' }] } },
          { type: 'CORTEX_STEP_TYPE_CHECKPOINT' },
        ],
      },
    }),
    GetConversationMetadata: () => ({
      metadata: { staticConfig: { cascadeConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M198' } } } },
    }),
    SendUserCascadeMessage: () => ({}),
  });
  const client = createLsRpcClient({
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5555', ANTIGRAVITY_CSRF_TOKEN: 'tok123' },
    daemonDir: join(tmpdir(), 'definitely-missing'),
    fetchImpl,
  });
  const sender = createCompactSender({ client });
  const res = await sender.sendCompact('conv-xyz');
  assert.equal(res.ok, true);
  assert.equal(res.planModel, 'MODEL_PLACEHOLDER_M198');
  assert.equal(fetchImpl.calls.length, 3);

  const body = JSON.parse(fetchImpl.calls[2].opts.body);
  const pc = body.cascadeConfig.plannerConfig;
  assert.equal(pc.planModel, 'MODEL_PLACEHOLDER_M198');
  assert.equal(pc.toolConfig.runCommand.autoCommandConfig.autoExecutionPolicy, 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER');
  assert.equal(pc.useAiCredits, false);
});

test('sendCompact passes requestedModel through when planModel is unspecified', async () => {
  const fetchImpl = mockFetch({
    GetCascadeTrajectory: () => ({
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            userInput: {
              userConfig: {
                plannerConfig: {
                  planModel: 'MODEL_UNSPECIFIED',
                  requestedModel: { choice: { case: 'alias', value: 'MODEL_ALIAS_RECOMMENDED' } },
                },
              },
            },
          },
        ],
      },
    }),
    SendUserCascadeMessage: () => ({}),
  });
  const client = createLsRpcClient({
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5555', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    daemonDir: join(tmpdir(), 'definitely-missing'),
    fetchImpl,
  });
  const sender = createCompactSender({ client });
  await sender.sendCompact('conv-xyz');
  const pc = JSON.parse(fetchImpl.calls[1].opts.body).cascadeConfig.plannerConfig;
  assert.equal(pc.planModel, undefined);
  assert.equal(pc.requestedModel.choice.value, 'MODEL_ALIAS_RECOMMENDED');
});

test('sendCompact rejects when no planner model can be resolved', async () => {
  const fetchImpl = mockFetch({
    GetCascadeTrajectory: () => ({ trajectory: { steps: [] } }),
    GetConversationMetadata: () => ({ metadata: {} }),
  });
  const client = createLsRpcClient({
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5555', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    daemonDir: join(tmpdir(), 'definitely-missing'),
    fetchImpl,
  });
  const sender = createCompactSender({ client });
  await assert.rejects(() => sender.sendCompact('conv-xyz'), /planner model not found/);
});

test('hub cache is invalidated and re-resolved after a transport failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-rpc-'));
  try {
    writeFileSync(join(dir, 'hub_1111.json'), JSON.stringify({ pid: 1, httpPort: 1111, csrfToken: 'stale' }));
    let failures = 0;
    const fetchImpl = mockFetch({
      Heartbeat: () => {
        if (failures++ === 0) {
          writeFileSync(join(dir, 'hub_2222.json'), JSON.stringify({ pid: 2, httpPort: 2222, csrfToken: 'fresh' }));
          throw new Error('connection refused');
        }
        return { ok: true };
      },
    });
    const client = createLsRpcClient({ env: {}, daemonDir: dir, fetchImpl });
    const res = await client.rpc('Heartbeat', {});
    assert.equal(res.ok, true);
    assert.equal(fetchImpl.calls[1].url.includes(':2222/'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
