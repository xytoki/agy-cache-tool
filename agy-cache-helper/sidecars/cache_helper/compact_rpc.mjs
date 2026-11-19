import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LS_SERVICE = 'exa.language_server_pb.LanguageServerService';
const HUB_FILE_RE = /^hub_\d+\.json$/;

/**
 * Minimal client for the local language_server Connect-RPC endpoint.
 * Verified against lsVersion 2.33.0 (see agy_cache_ttl_and_keepalive_research.md §5.4).
 *
 * Endpoint discovery order:
 *   1. ANTIGRAVITY_LS_ADDRESS + ANTIGRAVITY_CSRF_TOKEN env (what `agentapi` uses)
 *   2. newest ~/.gemini/antigravity/daemon/hub_<httpPort>.json ({httpPort, csrfToken})
 * The CSRF token rotates on every LS restart, so the hub is re-resolved after a failure.
 */
export function createLsRpcClient({
  env = process.env,
  daemonDir = join(homedir(), '.gemini', 'antigravity', 'daemon'),
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  let cachedHub = null;

  function hubFromEnv() {
    const addr = env.ANTIGRAVITY_LS_ADDRESS;
    const csrf = env.ANTIGRAVITY_CSRF_TOKEN;
    if (!addr || !csrf) return null;
    const port = Number(String(addr).replace(/^https?:\/\//, '').split(':').pop());
    if (!Number.isInteger(port) || port <= 0) return null;
    return { port, csrfToken: csrf, source: 'env' };
  }

  function hubFromDaemonDir() {
    let names;
    try {
      names = readdirSync(daemonDir);
    } catch {
      return null;
    }
    let best = null;
    for (const name of names) {
      if (!HUB_FILE_RE.test(name)) continue;
      try {
        const filePath = join(daemonDir, name);
        const mtimeMs = statSync(filePath).mtimeMs;
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        if (!data.httpPort || !data.csrfToken) continue;
        if (!best || mtimeMs > best.mtimeMs) {
          best = { port: data.httpPort, csrfToken: data.csrfToken, lsVersion: data.lsVersion, source: 'daemon', mtimeMs };
        }
      } catch {
        // Stale/corrupt hub file -> try the next one.
      }
    }
    return best;
  }

  function resolveHub() {
    if (!cachedHub) cachedHub = hubFromEnv() || hubFromDaemonDir();
    return cachedHub;
  }

  async function rpcOnce(hub, method, body) {
    const res = await fetchImpl(`http://127.0.0.1:${hub.port}/${LS_SERVICE}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': hub.csrfToken,
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`rpc ${method} returned non-JSON (status ${res.status})`);
    }
    if (data?.code) {
      const err = new Error(data.message || `rpc ${method} failed: ${data.code}`);
      err.rpcCode = data.code;
      throw err;
    }
    return data;
  }

  async function rpc(method, body) {
    let hub = resolveHub();
    if (!hub) {
      throw new Error('language server address unavailable (no ANTIGRAVITY_LS_ADDRESS env, no hub_*.json)');
    }
    try {
      return await rpcOnce(hub, method, body);
    } catch (err) {
      // Business errors are not retryable (and a blind retry could double-send
      // messages); only stale-hub transport failures get one re-resolve.
      if (err?.rpcCode) throw err;
      cachedHub = null;
      hub = resolveHub();
      if (!hub) throw err;
      return rpcOnce(hub, method, body);
    }
  }

  return { rpc, getHub: resolveHub };
}

/**
 * Resolves the cascadeConfig a /compact send should carry, in the shape the
 * frontend itself produces. GetConversationMetadata.staticConfig is absent on
 * newer conversations, so the primary source is GetCascadeTrajectory: every
 * USER_INPUT step stores the full userConfig the client sent. We replay the
 * last usable one. Metadata staticConfig is kept as a fallback.
 */
async function fetchCascadeConfig(client, conversationId) {
  try {
    const traj = await client.rpc('GetCascadeTrajectory', { cascadeId: conversationId });
    const steps = traj?.trajectory?.steps || [];
    for (let i = steps.length - 1; i >= 0; i--) {
      const uc = steps[i]?.userInput?.userConfig;
      const pc = uc?.plannerConfig;
      if (!pc) continue;
      const plannerConfig = {};
      if (pc.planModel && pc.planModel !== 'MODEL_UNSPECIFIED') plannerConfig.planModel = pc.planModel;
      if (pc.requestedModel) plannerConfig.requestedModel = pc.requestedModel;
      if (!plannerConfig.planModel && !plannerConfig.requestedModel) continue;
      if (pc.toolConfig) plannerConfig.toolConfig = pc.toolConfig;
      if (pc.useAiCredits !== undefined) plannerConfig.useAiCredits = pc.useAiCredits;
      if (pc.supportsLatexRendering !== undefined) plannerConfig.supportsLatexRendering = pc.supportsLatexRendering;
      const cascadeConfig = { plannerConfig };
      if (uc.executorConfig) cascadeConfig.executorConfig = uc.executorConfig;
      if (uc.conversationHistoryConfig) cascadeConfig.conversationHistoryConfig = uc.conversationHistoryConfig;
      return cascadeConfig;
    }
  } catch {
    // Trajectory lookup failed — fall through to the metadata route.
  }
  const meta = await client.rpc('GetConversationMetadata', { conversationId });
  const planModel = meta?.metadata?.staticConfig?.cascadeConfig?.plannerConfig?.planModel;
  if (planModel && planModel !== 'MODEL_UNSPECIFIED') {
    return { plannerConfig: { planModel } };
  }
  throw new Error(`planner model not found for ${conversationId}`);
}

/**
 * Builds a SendUserCascadeMessage body that mirrors a captured frontend /compact
 * request verbatim (lsVersion 2.33.0). Plain-text or scopeItem encodings are
 * accepted by the server but treated as regular user input — only the
 * structured item.slashCommand entry actually triggers compaction.
 */
export function buildCompactMessage(conversationId, cascadeConfig = {}, { randomUUID = () => crypto.randomUUID() } = {}) {
  const plannerConfig = {
    toolConfig: {
      runCommand: {
        autoCommandConfig: { autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER' },
      },
      antigravityBrowser: { enableBrowserSubagentWebview: false },
    },
    useAiCredits: false,
    supportsLatexRendering: true,
    ...(cascadeConfig.plannerConfig || {}),
  };
  if (!plannerConfig.planModel && !plannerConfig.requestedModel) {
    throw new Error('buildCompactMessage: cascadeConfig.plannerConfig has no model');
  }
  return {
    cascadeId: conversationId,
    items: [
      {
        item: {
          slashCommand: {
            info: { name: 'compact', type: 'SLASH_COMMAND_TYPE_SYSTEM', icon: 'collapse_all' },
          },
        },
      },
      { text: ' ' },
    ],
    cascadeConfig: {
      plannerConfig,
      executorConfig: { useCoreDirect: true, ...(cascadeConfig.executorConfig || {}) },
      conversationHistoryConfig: cascadeConfig.conversationHistoryConfig ?? {},
    },
    customAgentSpec: {
      builtinAgent: {
        defaultAgent: { isGoogle: false, isInteractive: true, surface: 'AGENT_SURFACE_HUB' },
      },
    },
    deliveryStrategy: 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION',
    clientMessageId: randomUUID(),
  };
}

/**
 * Sends "/compact" through the real user-input path (SendUserCascadeMessage),
 * producing a genuine USER_INPUT step + CHECKPOINT, identical to typing it in the UI.
 */
export function createCompactSender(deps = {}) {
  const client = deps.client || createLsRpcClient(deps);

  async function sendCompact(conversationId) {
    const cascadeConfig = await fetchCascadeConfig(client, conversationId);
    const planModel = cascadeConfig.plannerConfig?.planModel || cascadeConfig.plannerConfig?.requestedModel;
    await client.rpc('SendUserCascadeMessage', buildCompactMessage(conversationId, cascadeConfig, deps));
    return { ok: true, planModel };
  }

  return { sendCompact, getHub: client.getHub };
}
