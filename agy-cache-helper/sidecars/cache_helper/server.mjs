import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAntigravityReader } from './db_reader.mjs';
import { createPingController } from './ping_engine.mjs';
import { createSettingsStore } from './settings.mjs';
import { createEventLog } from './event_log.mjs';
import { installAsyncHostRoutes, installEpipeGuard, sendKeepAliveMessage } from './host_bridge.mjs';
import { createCompactSender } from './compact_rpc.mjs';
import { startSelfReloadWatcher } from './reload.mjs';
import { startFooterInjector } from './footer_injector.mjs';
import { buildUiHtml } from './ui.mjs';

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  installEpipeGuard();

  const settingsStore = createSettingsStore();
  const eventLog = createEventLog();
  const reader = createAntigravityReader();
  const compactSender = createCompactSender();
  const controller = createPingController({
    readCandidates: reader.readCandidates,
    sendPing: sendKeepAliveMessage,
    settingsStore,
    eventLog,
    executeCompact: conv => compactSender.sendCompact(conv.conversationId),
    pollMs: 2000,
  });

  controller.start();

  const footerInjector = startFooterInjector({
    getPayload: activeCid => controller.getFooterSnapshot(activeCid),
    onPageState: (pageId, st) => controller.reportPageState(pageId, st),
    onPageClosed: pageId => controller.removePageState(pageId),
    onAction: act => {
      if (act?.type === 'cancel_compact' && act.conversationId) {
        controller.cancelCompact(act.conversationId, 'footer');
      }
    },
    onSuperseded: () => void shutdown('superseded by newer instance'),
  });

  let app = null;
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    const { SidecarApp } = await import('sidecar_sdk');
    app = new SidecarApp();
    const uiHtml = buildUiHtml();
    app.page('/', () => uiHtml);
    app.page('/ui.html', () => uiHtml);
    app.api('/api/status', () => controller.getStatus({ cdpStatus: footerInjector.status() }), 'GET');
    app.api('/api/settings', () => settingsStore.read(), 'GET');
    app.api('/api/settings', data => settingsStore.update(data), 'POST');
    app.api('/api/conversation/toggle', data => {
      if (!data?.conversationId) return { ok: false, error: 'missing conversationId' };
      return { ok: true, settings: settingsStore.toggleConversation(data.conversationId, Boolean(data.allowed)) };
    }, 'POST');
    app.api('/api/compact/toggle', data => {
      if (!data?.conversationId) return { ok: false, error: 'missing conversationId' };
      return { ok: true, settings: settingsStore.toggleCompactConversation(data.conversationId, Boolean(data.allowed)) };
    }, 'POST');
    app.api('/api/compact/cancel', data => {
      if (!data?.conversationId) return { ok: false, error: 'missing conversationId' };
      return controller.cancelCompact(data.conversationId, 'sidebar');
    }, 'POST');
    app.api('/api/compact/resume', data => {
      if (!data?.conversationId) return { ok: false, error: 'missing conversationId' };
      return controller.resumeCompact(data.conversationId);
    }, 'POST');
    app.api('/api/compact/preview', data => {
      if (!data?.conversationId) return { ok: false, error: 'missing conversationId' };
      return controller.startCompactPreview(data.conversationId);
    }, 'POST');
    app.api('/api/ping-now', data => controller.triggerManualPing(data?.conversationId), 'POST');
    app.api('/api/events/clear', () => { eventLog.clear(); return { ok: true }; }, 'POST');
    await app.run();
    installAsyncHostRoutes(app);
  }

  let stopping = false;
  const shutdown = async reason => {
    if (stopping) return;
    stopping = true;
    stopWatching();
    controller.stop();
    console.log('[agy-cache-helper] stopping:', reason);
    try {
      await footerInjector.stop();
      await app?.close?.();
    } finally {
      process.exit(0);
    }
  };

  const stopWatching = startSelfReloadWatcher(
    dirname(fileURLToPath(import.meta.url)),
    () => void shutdown('plugin files changed'),
  );
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => void shutdown(sig));
  }
}
