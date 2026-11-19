import { execFile } from 'node:child_process';

export function runAgentApi(args, { projectId, env = process.env, execFileImpl = execFile, timeoutMs = 30000 } = {}) {
  const childEnv = { ...env };
  if (projectId) childEnv.ANTIGRAVITY_PROJECT_ID = projectId;
  const exe = env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;
  return new Promise((resolve, reject) => {
    execFileImpl(
      file,
      execArgs,
      {
        encoding: 'utf-8',
        env: childEnv,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message || 'agentapi failed';
          reject(new Error(msg));
          return;
        }
        try {
          const out = String(stdout ?? '').trim();
          resolve(out ? JSON.parse(out) : {});
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

export function sendKeepAliveMessage(conversationId, message, options = {}) {
  return runAgentApi(['send-message', conversationId, message], options);
}

export function installAsyncHostRoutes(app, options = {}) {
  const run = (args, extra) => runAgentApi(args, { ...options, ...extra });
  app.api('/_sidecar/send-message', (data = {}) => {
    const args = ['send-message'];
    if (data.title) args.push('--title', data.title);
    args.push(data.conversationId, data.message);
    return run(args, { projectId: data.projectId });
  });
  app.api('/_sidecar/new-conversation', (data = {}) =>
    run(['new-conversation', '--model', data.model || 'flash', data.message], { projectId: data.projectId }));
  app.api('/_sidecar/get-conversation-metadata', (data = {}) =>
    run(['get-conversation-metadata', data.conversationId]));
}

export function installEpipeGuard(proc = process) {
  const isEpipe = err => err?.code === 'EPIPE';
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on?.('error', err => { if (!isEpipe(err)) throw err; });
  }
  const fatal = err => {
    if (isEpipe(err)) return;
    try { console.error('[agy-cache-helper] fatal:', err); } catch {}
    proc.exit(1);
  };
  proc.on('uncaughtException', fatal);
  proc.on('unhandledRejection', fatal);
}
