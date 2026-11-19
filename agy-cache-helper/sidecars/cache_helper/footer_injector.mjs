// CDP injector for the agy-cache-helper tail-end compaction countdown badge.
// Remains hidden (0px) when no conversation has an active compaction countdown.
// Communicates bidirectionally with the sidecar via Runtime.evaluate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const INTERVAL_MS = 1000;
const INSTANCE_TS = Date.now();
const PORT_FILE =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')
    : process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');

function installFooterRuntime(owner, hash) {
  const prev = globalThis.__agyCacheHelperFooter;
  if (prev?.owner > owner) return 'superseded';
  prev?.dispose();

  let disposed = false;
  let data = null;
  let dataPath = '';
  let pinnedKey = null; // 'cur' | 'bg' | null
  let lastStructKey = '';
  const pendingActions = [];
  const optimisticCancelled = new Map(); // cid -> expireAtMs

  const TIER_LABEL = {
    tail_90_pct: '尾段热压缩 (≥90%)',
    long_turn_80_pct: '长任务结束 (≥80%)',
    preview_test: '模拟倒计时测试',
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function detectHasDraft() {
    const footer = document.querySelector('.agy-composer-footer');
    if (!footer) return false;
    let container = footer.parentElement;
    for (let depth = 0; depth < 6 && container && container !== document.body; depth++) {
      const inputs = container.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
      if (inputs.length > 0) {
        for (const el of inputs) {
          if (el.tagName === 'TEXTAREA') {
            if ((el.value || '').trim().length > 0) return true;
          } else {
            const raw = (el.innerText || el.textContent || '').replace(/[\u200B-\u200D\uFEFF\s]/g, '');
            if (raw.length > 0) return true;
          }
        }
        return false;
      }
      container = container.parentElement;
    }
    return false;
  }

  function ensureHost() {
    const footerLeft = document.querySelector('.agy-composer-footer > div:first-child');
    if (!footerLeft) return null;
    let host = document.getElementById('agy-cache-helper-host');
    let root = host?.shadowRoot?.getElementById('ch-footer-root');
    if (!root) {
      host?.remove();
      host = document.createElement('div');
      host.id = 'agy-cache-helper-host';
      host.style.cssText = 'display:none;align-items:center;flex-shrink:0;margin-left:4px;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        #ch-footer-root, #ch-footer-root * { box-sizing: border-box; }
        #ch-footer-root {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 12px;
          line-height: 1;
          user-select: none;
          position: relative;
          font-variant-numeric: tabular-nums;
          color: var(--foreground, #ececef);
        }
        .ch-grp {
          position: relative;
          display: inline-flex;
          align-items: center;
        }
        .ch-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 22px;
          padding: 0 7px;
          border-radius: 6px;
          border: 1px solid rgba(245, 158, 11, 0.42);
          background: rgba(245, 158, 11, 0.14);
          color: #fcd34d;
          font-weight: 500;
          white-space: nowrap;
          cursor: pointer;
          transition: background .14s ease, border-color .14s ease, color .14s ease;
        }
        .ch-pill:hover {
          background: rgba(245, 158, 11, 0.22);
          border-color: rgba(245, 158, 11, 0.65);
        }
        .ch-pill.urgent {
          border-color: rgba(248, 113, 113, 0.58);
          background: rgba(248, 113, 113, 0.18);
          color: #fca5a5;
          animation: ch-pulse 1.2s ease-in-out infinite;
        }
        .ch-pill.paused {
          border-color: rgba(148, 163, 184, 0.4);
          background: rgba(148, 163, 184, 0.14);
          color: var(--foreground, #e2e8f0);
          padding: 0 6px;
        }
        .ch-pill.bg {
          border-color: rgba(96, 165, 250, 0.42);
          background: rgba(96, 165, 250, 0.14);
          color: #93c5fd;
        }
        .ch-pill.bg.urgent {
          border-color: rgba(248, 113, 113, 0.58);
          background: rgba(248, 113, 113, 0.18);
          color: #fca5a5;
        }
        @keyframes ch-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.72; }
        }
        .ch-icon-wrap {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 13px;
          height: 13px;
          flex-shrink: 0;
        }
        .ch-svg {
          width: 12px;
          height: 12px;
          display: block;
        }
        .ch-count {
          position: absolute;
          top: -5px;
          right: -6px;
          min-width: 12px;
          height: 12px;
          padding: 0 2px;
          border-radius: 99px;
          background: #3b82f6;
          color: #ffffff;
          font-size: 9px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          line-height: 1;
        }
        .ch-x {
          border: 0;
          background: transparent;
          color: inherit;
          padding: 0 1px 0 3px;
          margin: 0;
          font-size: 14px;
          line-height: 1;
          cursor: pointer;
          opacity: 0.8;
          display: inline-flex;
          align-items: center;
        }
        .ch-x:hover {
          opacity: 1;
        }
        .ch-pop {
          display: none;
          position: absolute;
          bottom: calc(100% + 8px);
          left: 0;
          min-width: 230px;
          max-width: 300px;
          padding: 10px 11px;
          border-radius: 9px;
          background: var(--card, #1c1c20);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36);
          color: var(--foreground, #ececef);
          z-index: 999999;
          line-height: 1.4;
        }
        .ch-pop::after {
          content: "";
          position: absolute;
          left: 0;
          right: 0;
          top: 100%;
          height: 10px;
        }
        .ch-grp:hover .ch-pop,
        .ch-grp[data-pinned="true"] .ch-pop {
          display: block;
        }
        .ch-pop-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-weight: 600;
          font-size: 12px;
          margin-bottom: 5px;
        }
        .ch-pop-sub {
          font-size: 11.5px;
          opacity: 0.78;
          margin-bottom: 8px;
        }
        .ch-pop-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 5px 0;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        .ch-pop-row:first-of-type {
          border-top: 0;
          padding-top: 2px;
        }
        .ch-pop-title {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
        }
        .ch-pop-meta {
          font-size: 11px;
          opacity: 0.78;
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }
        .ch-btn {
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: rgba(255, 255, 255, 0.08);
          color: var(--foreground, #ececef);
          border-radius: 5px;
          padding: 3px 8px;
          font-size: 11.5px;
          cursor: pointer;
          white-space: nowrap;
        }
        .ch-btn:hover {
          background: rgba(255, 255, 255, 0.16);
        }
        .ch-pop-actions {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
        }
      `;
      root = document.createElement('div');
      root.id = 'ch-footer-root';
      shadow.appendChild(style);
      shadow.appendChild(root);

      root.addEventListener('mouseover', (e) => {
        const grp = e.target.closest('.ch-grp');
        if (grp) positionPopover(grp);
      });

      root.addEventListener('click', (e) => {
        const cancelBtn = e.target.closest('[data-cancel-cid]');
        if (cancelBtn) {
          e.stopPropagation();
          e.preventDefault();
          const cid = cancelBtn.getAttribute('data-cancel-cid');
          if (cid) {
            optimisticCancelled.set(cid, Date.now() + 10_000);
            pendingActions.push({ type: 'cancel_compact', conversationId: cid });
            pinnedKey = null;
            render();
          }
          return;
        }
        const pill = e.target.closest('[data-pin-key]');
        if (pill) {
          e.stopPropagation();
          const k = pill.getAttribute('data-pin-key');
          pinnedKey = pinnedKey === k ? null : k;
          render();
          const grp = pill.closest('.ch-grp');
          if (grp) positionPopover(grp);
        }
      });
    }
    if (!footerLeft.contains(host)) {
      footerLeft.appendChild(host);
    }
    return { host, root };
  }

  function positionPopover(grp) {
    const pop = grp?.querySelector('.ch-pop');
    if (!pop) return;
    const grpRect = grp.getBoundingClientRect();
    const popW = Math.max(pop.offsetWidth || 0, 240);
    const spaceRight = window.innerWidth - 8 - grpRect.left;
    if (spaceRight < popW && grpRect.right >= popW) {
      pop.style.left = 'auto';
      pop.style.right = '0';
    } else {
      pop.style.left = '0';
      pop.style.right = 'auto';
    }
  }

  const onOutsideClick = (e) => {
    if (!pinnedKey) return;
    const host = document.getElementById('agy-cache-helper-host');
    if (host && !e.composedPath().includes(host)) {
      pinnedKey = null;
      render();
    }
  };
  document.addEventListener('click', onOutsideClick);

  const PAUSE_SVG = '<svg class="ch-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="9" y1="6" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="18"/></svg>';

  function liveRemaining(item, now) {
    if (!item) return 0;
    if (item.action === 'paused' || !item.deadlineMs) return Math.max(0, Math.ceil(item.remainingSec || 0));
    return Math.max(0, Math.ceil((item.deadlineMs - now) / 1000));
  }

  function isOptimisticallyCancelled(cid, now) {
    const exp = optimisticCancelled.get(cid);
    if (!exp) return false;
    if (now > exp) {
      optimisticCancelled.delete(cid);
      return false;
    }
    return true;
  }

  function render() {
    if (disposed) return;
    const mounted = ensureHost();
    if (!mounted) return;
    const { host, root } = mounted;
    if (!data || location.pathname !== dataPath) {
      host.style.display = 'none';
      if (lastStructKey) {
        root.innerHTML = '';
        lastStructKey = '';
      }
      return;
    }

    const now = Date.now();
    const cur = data.current && !isOptimisticallyCancelled(data.current.conversationId, now) ? data.current : null;
    const bgList = (data.background || []).filter(item => !isOptimisticallyCancelled(item.conversationId, now));

    if (!cur && bgList.length === 0) {
      host.style.display = 'none';
      if (lastStructKey) {
        root.innerHTML = '';
        lastStructKey = '';
      }
      pinnedKey = null;
      return;
    }

    host.style.display = 'inline-flex';
    // Keep our badge after agy-capsule if both are mounted in footerLeft
    if (host.nextElementSibling && host.parentElement) {
      host.parentElement.appendChild(host);
    }

    const enrichedBg = bgList
      .map(item => ({ ...item, rem: liveRemaining(item, now) }))
      .sort((a, b) => a.rem - b.rem);

    const structKey = JSON.stringify({
      cur: cur ? [cur.conversationId, cur.action, cur.tier, cur.contextPct, data.detectOnly] : null,
      bg: enrichedBg.map(b => [b.conversationId, b.action, b.contextPct, b.title]),
      pinnedKey,
    });

    if (structKey !== lastStructKey) {
      const parts = [];

      if (cur) {
        const rem = liveRemaining(cur, now);
        const isPaused = cur.action === 'paused';
        const urgent = !isPaused && rem <= 15;
        const tierText = TIER_LABEL[cur.tier] || '尾段热压缩';
        const pctText = cur.contextPct !== null && cur.contextPct !== undefined ? `${cur.contextPct}%` : '';
        const modeNote = data.detectOnly ? '仅检测模式，倒计时结束仅记录日志' : '倒计时结束后自动执行压缩';

        if (isPaused) {
          parts.push(
            `<div class="ch-grp" data-pinned="${pinnedKey === 'cur'}">` +
              `<div class="ch-pill paused" data-pin-key="cur" title="输入框存在未发送草稿，已暂停倒计时">${PAUSE_SVG}<span>暂停压缩</span></div>` +
              `<div class="ch-pop">` +
                `<div class="ch-pop-head"><span>压缩倒计时已暂停</span><span>${esc(pctText)}</span></div>` +
                `<div class="ch-pop-sub">输入框存在未发送草稿，清空或发送后恢复。${esc(modeNote)}</div>` +
                `<div class="ch-pop-actions"><button type="button" class="ch-btn" data-cancel-cid="${esc(cur.conversationId)}">取消本轮</button></div>` +
              `</div>` +
            `</div>`
          );
        } else {
          parts.push(
            `<div class="ch-grp" data-pinned="${pinnedKey === 'cur'}">` +
              `<div class="ch-pill${urgent ? ' urgent' : ''}" data-pin-key="cur" data-pill-cur="1">` +
                `<span data-rem-cur="1">${rem}s后压缩</span>` +
                `<button type="button" class="ch-x" data-cancel-cid="${esc(cur.conversationId)}" title="取消本轮压缩">×</button>` +
              `</div>` +
              `<div class="ch-pop">` +
                `<div class="ch-pop-head"><span>${esc(tierText)}</span><span>${esc(pctText)}</span></div>` +
                `<div class="ch-pop-sub"><span data-rem-cur-pop="1">${rem}</span> 秒后触发热压缩（${esc(modeNote)}）</div>` +
                `<div class="ch-pop-actions"><button type="button" class="ch-btn" data-cancel-cid="${esc(cur.conversationId)}">取消本轮</button></div>` +
              `</div>` +
            `</div>`
          );
        }
      }

      if (enrichedBg.length > 0) {
        const first = enrichedBg[0];
        const urgent = first.action !== 'paused' && first.rem <= 15;
        const bgPrefix = enrichedBg.length > 1 ? `后台(${enrichedBg.length}) ` : '后台 ';
        const bgLabel = first.action === 'paused' ? `${bgPrefix}压缩暂停` : `${bgPrefix}${first.rem}s后压缩`;
        const rowsHtml = enrichedBg.map(item => {
          const pct = item.contextPct !== null && item.contextPct !== undefined ? `${item.contextPct}%` : '';
          const statusTxt = item.action === 'paused' ? '暂停' : `${item.rem}s`;
          return (
            `<div class="ch-pop-row">` +
              `<span class="ch-pop-title" title="${esc(item.title)}">${esc(item.title)}</span>` +
              `<span class="ch-pop-meta">${esc(pct)} <span data-rem-bg="${esc(item.conversationId)}">${esc(statusTxt)}</span></span>` +
              `<button type="button" class="ch-btn" data-cancel-cid="${esc(item.conversationId)}">取消</button>` +
            `</div>`
          );
        }).join('');

        parts.push(
          `<div class="ch-grp" data-pinned="${pinnedKey === 'bg'}">` +
            `<div class="ch-pill bg${urgent ? ' urgent' : ''}" data-pin-key="bg" data-pill-bg="1">` +
              `<span data-rem-bg-first="1">${esc(bgLabel)}</span>` +
            `</div>` +
            `<div class="ch-pop">` +
              `<div class="ch-pop-head"><span>后台待压缩会话</span><span>${enrichedBg.length} 个</span></div>` +
              rowsHtml +
            `</div>` +
          `</div>`
        );
      }

      root.innerHTML = parts.join('');
      lastStructKey = structKey;
      return;
    }

    // Update countdown text and urgency classes in place to preserve hover popovers and button clicks
    if (cur && cur.action !== 'paused') {
      const rem = liveRemaining(cur, now);
      const pill = root.querySelector('[data-pill-cur="1"]');
      if (pill) pill.classList.toggle('urgent', rem <= 15);
      const t1 = root.querySelector('[data-rem-cur="1"]');
      if (t1) t1.textContent = `${rem}s后压缩`;
      const t2 = root.querySelector('[data-rem-cur-pop="1"]');
      if (t2) t2.textContent = String(rem);
    }
    if (enrichedBg.length > 0) {
      const first = enrichedBg[0];
      const bgPill = root.querySelector('[data-pill-bg="1"]');
      if (bgPill) bgPill.classList.toggle('urgent', first.action !== 'paused' && first.rem <= 15);
      const firstSpan = root.querySelector('[data-rem-bg-first="1"]');
      const bgPrefix = enrichedBg.length > 1 ? `后台(${enrichedBg.length}) ` : '后台 ';
      if (firstSpan) firstSpan.textContent = first.action === 'paused' ? `${bgPrefix}压缩暂停` : `${bgPrefix}${first.rem}s后压缩`;
      for (const item of enrichedBg) {
        const sp = root.querySelector(`[data-rem-bg="${CSS.escape(item.conversationId)}"]`);
        if (sp) sp.textContent = item.action === 'paused' ? '暂停' : `${item.rem}s`;
      }
    }
  }

  const timer = setInterval(render, 1000);
  const api = {
    owner,
    hash,
    readState(caller) {
      if (caller < owner) return 'superseded';
      const actions = pendingActions.splice(0, pendingActions.length);
      return {
        owner,
        hash,
        path: location.pathname,
        hasFooter: !!document.querySelector('.agy-composer-footer > div:first-child'),
        hasDraft: detectHasDraft(),
        actions,
      };
    },
    apply(next, path, caller) {
      if (caller < owner) return 'superseded';
      if (caller !== owner || disposed || path !== location.pathname) return false;
      data = next;
      dataPath = path;
      render();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('click', onOutsideClick);
      document.getElementById('agy-cache-helper-host')?.remove();
      if (globalThis.__agyCacheHelperFooter === api) {
        delete globalThis.__agyCacheHelperFooter;
      }
    },
  };
  globalThis.__agyCacheHelperFooter = api;
  return true;
}

export function buildFooterRuntimeBundle(owner = INSTANCE_TS) {
  const source = installFooterRuntime.toString();
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const code = `(()=>{const INSTANCE_TS=${Number(owner)};if(globalThis.__agyCacheHelperFooter?.owner>INSTANCE_TS)return 'superseded';${source}\nreturn installFooterRuntime(INSTANCE_TS,${JSON.stringify(hash)});})()`;
  return { code, hash };
}

export function startFooterInjector({
  getPayload,
  onPageState,
  onPageClosed,
  onAction,
  onSuperseded,
  portFile = PORT_FILE,
  instanceTs = INSTANCE_TS,
}) {
  const owner = instanceTs;
  const bundle = buildFooterRuntimeBundle(owner);
  const sockets = new Map();
  let cachedPages = [];
  let lastListAt = 0;
  let lastErr = '';
  let stopped = false;
  let busy = false;
  let cdpState = 'unknown';

  const logOnce = msg => {
    if (lastErr !== msg) {
      lastErr = msg;
      console.error('[cache-helper-footer]', msg);
    }
  };

  const retire = (entry, id) => {
    if (entry.closed) return;
    entry.closed = true;
    for (const cb of entry.pending.values()) cb(undefined);
    entry.pending.clear();
    try { entry.ws.close(); } catch {}
    if (sockets.get(id) === entry) sockets.delete(id);
    onPageClosed?.(id);
  };

  const connect = async target => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const entry = { ws, pending: new Map(), nextId: 1, lastPayload: '', lastPath: '' };
    await new Promise((resolve, reject) => {
      const fail = msg => { clearTimeout(t); retire(entry, target.id); reject(new Error(msg)); };
      const t = setTimeout(() => fail('ws timeout'), 3000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => fail('ws error');
    });
    if (stopped) { retire(entry, target.id); throw new Error('injector stopped'); }
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        const cb = entry.pending.get(msg.id);
        if (cb) { entry.pending.delete(msg.id); cb(msg); }
      } catch {}
    };
    ws.onclose = () => retire(entry, target.id);
    sockets.set(target.id, entry);
    return entry;
  };

  const evaluate = (entry, expression) => new Promise(resolve => {
    if (entry.ws.readyState !== 1) return resolve(undefined);
    const id = entry.nextId++;
    const t = setTimeout(() => { entry.pending.delete(id); resolve(undefined); }, 3000);
    entry.pending.set(id, msg => { clearTimeout(t); resolve(msg?.result?.result?.value); });
    try {
      entry.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    } catch {
      clearTimeout(t);
      entry.pending.delete(id);
      resolve(undefined);
    }
  });

  const listPages = async () => {
    if (cachedPages.length && Date.now() - lastListAt < 4000) return cachedPages;
    let port;
    try {
      port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
    } catch {
      cdpState = 'missing';
      return [];
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = await res.json();
      cachedPages = targets.filter(t => t.type === 'page' && /^https?:\/\/127\.0\.0\.1:\d+\//.test(t.url || '') && t.webSocketDebuggerUrl);
      lastListAt = Date.now();
      cdpState = 'ok';
      const ids = new Set(cachedPages.map(t => t.id));
      for (const [id, entry] of sockets) {
        if (!ids.has(id)) retire(entry, id);
      }
      return cachedPages;
    } catch (err) {
      cdpState = 'unreachable';
      logOnce('CDP list failed: ' + err.message);
      return [];
    }
  };

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const target of await listPages()) {
        if (stopped) break;
        try {
          const entry = sockets.get(target.id) || await connect(target);
          let state = await evaluate(entry, `globalThis.__agyCacheHelperFooter?.readState(${owner})??null`);
          if (state === undefined || stopped) continue;
          if (state === 'superseded') {
            await stop();
            onSuperseded?.();
            return;
          }
          if (state?.owner !== owner || state.hash !== bundle.hash) {
            const installed = await evaluate(entry, bundle.code);
            if (installed === 'superseded') {
              await stop();
              onSuperseded?.();
              return;
            }
            if (!installed || stopped) continue;
            entry.lastPayload = '';
            state = await evaluate(entry, `globalThis.__agyCacheHelperFooter?.readState(${owner})??null`);
          }
          if (state === 'superseded') {
            await stop();
            onSuperseded?.();
            return;
          }
          if (!state || state.owner !== owner) continue;

          const match = (state.path || '').match(/\/c\/([0-9a-f-]{36})/);
          const activeCid = match ? match[1] : '';
          onPageState?.(target.id, { conversationId: activeCid, hasDraft: Boolean(state.hasDraft) });

          if (Array.isArray(state.actions) && state.actions.length > 0) {
            for (const act of state.actions) {
              onAction?.(act, { pageId: target.id, activeConversationId: activeCid });
            }
          }

          if (!state.hasFooter) continue;
          const payloadObj = getPayload(activeCid);
          const payloadStr = JSON.stringify(payloadObj);
          if (entry.lastPayload !== payloadStr || entry.lastPath !== state.path) {
            const applied = await evaluate(
              entry,
              `globalThis.__agyCacheHelperFooter?.apply(${payloadStr},${JSON.stringify(state.path)},${owner})??false`,
            );
            if (applied) {
              entry.lastPayload = payloadStr;
              entry.lastPath = state.path;
            } else {
              entry.lastPayload = '';
            }
          }
          lastErr = '';
        } catch (err) {
          const entry = sockets.get(target.id);
          if (entry) retire(entry, target.id);
          logOnce('page ' + target.id + ': ' + err.message);
        }
      }
    } finally {
      busy = false;
    }
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await Promise.all([...sockets].map(async ([id, entry]) => {
      try {
        await evaluate(entry, `globalThis.__agyCacheHelperFooter?.owner===${owner}&&globalThis.__agyCacheHelperFooter.dispose()`);
      } finally {
        retire(entry, id);
      }
    }));
  };

  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  timer.unref?.();
  void tick();

  return { tick, stop, status: () => cdpState };
}
