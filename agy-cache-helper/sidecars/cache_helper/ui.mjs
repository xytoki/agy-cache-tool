export function buildUiHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agy-cache-helper</title>
  <script src="/preload.js"></script>
  <style>
    :root {
      color-scheme: dark light;
      --ch-bg: var(--background, #141416);
      --ch-fg: var(--foreground, #ececef);
      --ch-dim: color-mix(in srgb, var(--ch-fg) 72%, var(--ch-bg));
      --ch-surface: color-mix(in srgb, var(--ch-fg) 5%, var(--ch-bg));
      --ch-surface-hover: color-mix(in srgb, var(--ch-fg) 11%, var(--ch-bg));
      --ch-border: color-mix(in srgb, var(--ch-fg) 16%, transparent);
      --ch-border-strong: color-mix(in srgb, var(--ch-fg) 26%, transparent);
      --ch-green: #4ade80;
      --ch-amber: #f59e0b;
      --ch-red: #f87171;
      --ch-blue: #60a5fa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12.5px;
      line-height: 1.45;
      background: var(--ch-bg);
      color: var(--ch-fg);
    }
    .app { padding: 12px; }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 12px;
    }
    .tabs {
      display: flex;
      gap: 4px;
      background: var(--ch-surface);
      padding: 3px;
      border-radius: 7px;
      border: 1px solid var(--ch-border);
    }
    .tab {
      border: 0;
      background: transparent;
      color: var(--ch-dim);
      padding: 5px 11px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background .12s ease, color .12s ease;
    }
    .tab:hover {
      color: var(--ch-fg);
      background: color-mix(in srgb, var(--ch-fg) 7%, transparent);
    }
    .tab.active {
      background: color-mix(in srgb, var(--ch-fg) 14%, transparent);
      color: var(--ch-fg);
      font-weight: 600;
    }
    .master-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--ch-fg);
      opacity: 0.9;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--ch-dim);
      display: inline-block;
    }
    .dot.on { background: var(--ch-green); }
    .dot.dry { background: var(--ch-amber); }
    .card {
      background: var(--ch-surface);
      border: 1px solid var(--ch-border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .row-right {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .icon-btn {
      width: 22px;
      height: 22px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      border: 1px solid var(--ch-border-strong);
      background: color-mix(in srgb, var(--ch-fg) 6%, var(--ch-bg));
      color: var(--ch-fg);
      cursor: pointer;
      flex-shrink: 0;
      transition: background .12s ease, border-color .12s ease;
    }
    .icon-btn:hover { background: var(--ch-surface-hover); border-color: color-mix(in srgb, var(--ch-fg) 38%, transparent); }
    .icon-btn:disabled { opacity: 0.35; cursor: default; }
    .icon-btn svg { width: 10px; height: 10px; display: block; }
    .mini-switch {
      appearance: none;
      -webkit-appearance: none;
      position: relative;
      width: 28px;
      height: 16px;
      margin: 0;
      border-radius: 99px;
      background: color-mix(in srgb, var(--ch-fg) 18%, transparent);
      border: 1px solid var(--ch-border-strong);
      cursor: pointer;
      flex-shrink: 0;
      transition: background .16s ease, border-color .16s ease;
    }
    .mini-switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--ch-fg);
      opacity: 0.72;
      transition: transform .16s ease, background .16s ease, opacity .16s ease;
    }
    .mini-switch:checked {
      background: rgba(74, 222, 128, 0.28);
      border-color: rgba(74, 222, 128, 0.7);
    }
    .mini-switch:checked::after {
      transform: translateX(12px);
      background: var(--ch-green);
      opacity: 1;
    }
    .bg-hint { color: var(--ch-blue); }
    .title {
      flex: 1;
      min-width: 0;
      font-weight: 600;
      color: var(--ch-fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta-line {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--ch-dim);
      margin-top: 4px;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
    }
    .meta-line .truncate {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 10px;
      color: var(--ch-dim);
      margin-top: 5px;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      background: color-mix(in srgb, var(--ch-fg) 10%, transparent);
      color: var(--ch-fg);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .badge.wait { background: rgba(96, 165, 250, 0.2); color: #93c5fd; }
    .badge.hit { background: rgba(74, 222, 128, 0.18); color: #86efac; }
    .badge.miss { background: rgba(248, 113, 113, 0.2); color: #fca5a5; }
    .badge.warn { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
    .btn {
      border: 1px solid var(--ch-border-strong);
      background: color-mix(in srgb, var(--ch-fg) 7%, var(--ch-bg));
      color: var(--ch-fg);
      border-radius: 5px;
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: background .12s ease, border-color .12s ease;
    }
    .btn:hover { background: var(--ch-surface-hover); border-color: color-mix(in srgb, var(--ch-fg) 38%, transparent); }
    .btn:disabled { opacity: 0.45; cursor: default; }
    .btn-primary {
      border-color: rgba(74, 222, 128, 0.55);
      background: rgba(74, 222, 128, 0.16);
      color: var(--ch-fg);
      font-weight: 500;
    }
    .btn-primary:hover { background: rgba(74, 222, 128, 0.26); }
    .btn-warn {
      border-color: rgba(245, 158, 11, 0.55);
      background: rgba(245, 158, 11, 0.16);
      color: #fcd34d;
      font-weight: 500;
    }
    .btn-warn:hover { background: rgba(245, 158, 11, 0.26); }
    .notice {
      font-size: 11.5px;
      color: #fcd34d;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 6px;
      padding: 6px 9px;
      margin-bottom: 8px;
    }
    .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px 12px;
      align-items: center;
    }
    .form-grid label {
      color: var(--ch-fg);
      font-size: 12.5px;
      cursor: pointer;
    }
    .form-grid input[type="number"] {
      width: 86px;
      background: var(--ch-bg);
      color: var(--ch-fg);
      border: 1px solid var(--ch-border-strong);
      border-radius: 5px;
      padding: 4px 7px;
      font-size: 12px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .form-grid input[type="number"]:focus {
      outline: 2px solid rgba(96, 165, 250, 0.6);
      outline-offset: 1px;
    }
    .form-grid input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      position: relative;
      width: 32px;
      height: 18px;
      margin: 0;
      border-radius: 99px;
      background: color-mix(in srgb, var(--ch-fg) 18%, transparent);
      border: 1px solid var(--ch-border-strong);
      cursor: pointer;
      transition: background .16s ease, border-color .16s ease;
    }
    .form-grid input[type="checkbox"]::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--ch-fg);
      opacity: 0.75;
      transition: transform .16s ease, background .16s ease, opacity .16s ease;
    }
    .form-grid input[type="checkbox"]:checked {
      background: rgba(74, 222, 128, 0.28);
      border-color: rgba(74, 222, 128, 0.7);
    }
    .form-grid input[type="checkbox"]:checked::after {
      transform: translateX(14px);
      background: var(--ch-green);
      opacity: 1;
    }
    .section-title {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--ch-dim);
      margin: 12px 0 6px;
      letter-spacing: 0.02em;
    }
    .empty {
      color: var(--ch-dim);
      text-align: center;
      padding: 28px 8px;
    }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="app">
    <div class="topbar">
      <div class="tabs">
        <button class="tab active" data-tab="monitor">监控</button>
        <button class="tab" data-tab="logs">日志</button>
        <button class="tab" data-tab="settings">设置</button>
      </div>
      <div class="master-pill" id="masterStatus">
        <span class="dot" id="masterDot"></span>
        <span id="masterText">加载中</span>
      </div>
    </div>

    <section id="pane-monitor"></section>
    <section id="pane-logs" hidden></section>
    <section id="pane-settings" hidden></section>
  </div>

  <script>
    const token = new URLSearchParams(location.search).get('token') || '';
    let activeTab = 'monitor';
    let latestState = null;

    const REASON_ZH = {
      global_disabled: '全局已关闭',
      conversation_muted: '本会话已静音',
      running: '运行中',
      just_compacted_no_cache: '刚压缩（待新轮）',
      just_reverted_no_cache: '刚撤回（待新轮）',
      just_reverted: '刚撤回（待新轮）',
      ping_in_flight: '正在 Ping',
      ping_error_cooldown: 'Ping 失败冷却中',
      no_timestamp: '无时间记录',
      subagent_disabled: 'Subagent 未启用',
      subagent_idle_no_bg_cmd: 'Subagent 无后台命令',
      subagent_context_too_small: 'Subagent 上下文不足',
      context_above_tail_threshold: '进入尾段阈值',
      context_below_min: '前段无需保活',
      context_tail_compact_zone: '尾段待压缩区',
      long_turn_likely_away: '长回合跳过',
      max_pings_reached: '已达本轮上限',
      stale_already_expired: '空闲过久已跳过',
      counting_down: '等待触发',
      waiting_background: '等待后台任务',
      discussion_short_turn: '短回合讨论',
      subagent_bg_command: 'Subagent 后台命令',
      manual_trigger: '手动触发',
      compact_countdown_tail_90: '尾段压缩倒计时',
      compact_countdown_long_turn_80: '长任务压缩倒计时',
      compact_preview_countdown: '模拟压缩倒计时',
      compact_paused_draft: '草稿暂停压缩',
      compact_cancelled_turn: '已取消本轮压缩',
      compact_ready_detect_only: '已到压缩点（仅判别）',
      compact_ready_tail_90: '已到压缩点',
      compact_ready_long_turn_80: '已到压缩点',
      compact_fired: '已触发热压缩',
      compact_preview_done: '模拟倒计时结束',
      compact_stale_missed_window: '尾段已过热窗',
      compact_stale_after_pause: '暂停过久已跳过',
      tail_90_pct: '尾段 ≥90%',
      long_turn_80_pct: '长任务结束 ≥80%',
      preview_test: '模拟测试',
      cancelled_by_footer: '底栏取消',
      cancelled_by_sidebar: '侧栏取消',
    };

    function api(path, method = 'GET', body = null) {
      if (window.sidecar && typeof window.sidecar.fetch === 'function') {
        const opts = { method };
        if (body !== null) opts.body = JSON.stringify(body);
        return window.sidecar.fetch(path, opts).then(r => r.json());
      }
      const headers = {};
      if (token) headers['x-sidecar-token'] = token;
      if (body !== null) headers['Content-Type'] = 'application/json';
      const sep = path.includes('?') ? '&' : '?';
      const url = token ? path + sep + 'token=' + encodeURIComponent(token) : path;
      return fetch(url, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
      }).then(r => r.json());
    }

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function fmtK(n) {
      if (!n) return '0';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return Math.round(n / 1e3) + 'K';
      return String(n);
    }

    function fmtSec(s) {
      if (s === null || s === undefined) return '--:--';
      s = Math.max(0, Math.round(s));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
      return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
    }

    function fmtTime(ms) {
      if (!ms) return '-';
      const d = new Date(ms);
      return d.toTimeString().slice(0, 8);
    }

    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('pane-monitor').hidden = activeTab !== 'monitor';
        document.getElementById('pane-logs').hidden = activeTab !== 'logs';
        document.getElementById('pane-settings').hidden = activeTab !== 'settings';
        if (latestState) render(latestState, activeTab === 'settings');
      });
    });

    let monitorStructKey = '';
    const monitorEl = document.getElementById('pane-monitor');
    monitorEl.addEventListener('change', async (e) => {
      const sw = e.target.closest('input[data-act="mute"]');
      if (!sw) return;
      sw.disabled = true;
      await api('/api/conversation/toggle', 'POST', {
        conversationId: sw.dataset.cid,
        allowed: sw.checked,
      });
      await refresh();
    });
    monitorEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      const cid = btn.dataset.cid;
      if (!cid) return;
      btn.disabled = true;
      if (act === 'ping') await api('/api/ping-now', 'POST', { conversationId: cid });
      else if (act === 'cancel-compact') await api('/api/compact/cancel', 'POST', { conversationId: cid });
      else if (act === 'resume-compact') await api('/api/compact/resume', 'POST', { conversationId: cid });
      else if (act === 'preview-compact') await api('/api/compact/preview', 'POST', { conversationId: cid });
      await refresh();
    });

    function computeCardView(c, state, now) {
      const d = c.decision || {};
      const cmp = c.compact || {};
      const liveIdleSec = c.lastCompletedAtMs > 0
        ? Math.max(0, (now - c.lastCompletedAtMs) / 1000)
        : d.idleSec;
      const cacheAnchorMs = c.lastGenStartedAtMs > 0 ? c.lastGenStartedAtMs : c.lastCompletedAtMs;
      const liveCacheAgeSec = cacheAnchorMs > 0
        ? Math.max(0, (now - cacheAnchorMs) / 1000)
        : (d.cacheAgeSec ?? d.idleSec);
      const liveNextPingSec = d.action === 'wait' && d.nextPingInSec !== null && d.intervalSec
        ? (liveCacheAgeSec !== null ? Math.max(0, d.intervalSec - liveCacheAgeSec) : d.nextPingInSec)
        : d.nextPingInSec;

      const ctxLabel = c.justCompacted
        ? '已压缩'
        : (c.contextPct !== null ? Math.round(c.contextPct) + '% (' + fmtK(c.contextTokens) + ')' : fmtK(c.contextTokens));
      const roleTag = c.isSubagent ? 'Subagent' : '主对话';
      let badgeCls = '';
      let badgeText = REASON_ZH[d.reason] || d.reason || '-';

      // Prioritize tail-end compaction status when active or recently resolved
      if (cmp.action === 'countdown') {
        const rem = cmp.deadlineMs ? Math.max(0, Math.ceil((cmp.deadlineMs - now) / 1000)) : Math.ceil(cmp.remainingSec || 0);
        badgeCls = rem <= 15 ? 'miss' : 'warn';
        badgeText = (cmp.preview ? '模拟压缩 ' : '压缩倒计时 ') + fmtSec(rem);
      } else if (cmp.action === 'paused') {
        badgeCls = 'warn';
        badgeText = '草稿暂停压缩';
      } else if (cmp.action === 'done') {
        badgeCls = 'hit';
        badgeText = cmp.preview
          ? '模拟倒计时结束'
          : (cmp.reason === 'compact_fired' ? '已触发热压缩' : '已到压缩点（未执行）');
      } else if (cmp.reason === 'compact_cancelled_turn') {
        badgeCls = '';
        badgeText = '已取消本轮压缩';
      } else if (cmp.reason === 'compact_stale_missed_window' && d.reason === 'context_tail_compact_zone') {
        badgeCls = '';
        badgeText = '尾段已过热窗';
      } else if (d.reason === 'ping_in_flight') {
        badgeCls = 'wait';
        badgeText = '正在 Ping';
      } else if (d.reason === 'ping_error_cooldown') {
        badgeCls = 'miss';
        badgeText = 'Ping 失败冷却中';
      } else if (d.action === 'wait' && liveNextPingSec !== null) {
        badgeCls = 'wait';
        badgeText = 'Ping ' + d.pingNumber + '/' + d.maxPings + ' 剩余 ' + fmtSec(liveNextPingSec);
      } else if (d.reason === 'context_tail_compact_zone') {
        badgeCls = 'warn';
      } else if (d.reason === 'just_compacted_no_cache') {
        badgeCls = 'hit';
      }

      let compactBtnKind = '';
      let compactBtnHtml = '';
      if (cmp.action === 'countdown' || cmp.action === 'paused') {
        compactBtnKind = 'cancel';
        compactBtnHtml = '<button class="btn btn-warn" data-act="cancel-compact" data-cid="' + esc(c.conversationId) + '">取消本轮压缩</button>';
      } else if (cmp.reason === 'compact_cancelled_turn') {
        compactBtnKind = 'resume';
        compactBtnHtml = '<button class="btn" data-act="resume-compact" data-cid="' + esc(c.conversationId) + '">恢复压缩倒计时</button>';
      } else if (state.settings?.dryRun && !c.isSubagent && !c.isRunning) {
        compactBtnKind = 'preview';
        compactBtnHtml = '<button class="btn" data-act="preview-compact" data-cid="' + esc(c.conversationId) + '">模拟压缩倒计时</button>';
      }

      return {
        cid: c.conversationId,
        title: c.title,
        roleTag,
        model: c.modelDisplay || c.modelStr || 'unknown',
        ctxLabel,
        badgeCls,
        badgeText,
        idleText: '空闲 ' + fmtSec(liveIdleSec),
        turnText: '本轮 ' + (c.lastRealTurnDurationSec !== null ? fmtSec(c.lastRealTurnDurationSec) : '--:--'),
        pingsText: '已Ping ' + (c.consecutivePings || 0) + '/' + (d.maxPings || 0),
        showBgHint: !c.isRunning && Boolean(c.hasActiveBackground),
        pingDisabled: Boolean(c.isRunning || d.reason === 'ping_in_flight'),
        muted: Boolean(c.muted),
        compactBtnKind,
        compactBtnHtml,
      };
    }

    function renderMonitor(state) {
      const el = monitorEl;
      const convs = state.conversations || [];
      let notice = '';
      if (state.settings?.enableFooterBadge && (state.cdpStatus === 'missing' || state.cdpStatus === 'unreachable')) {
        notice = '<div class="notice">底栏倒计时角标未连接 CDP（需使用 --remote-debugging-port=0 启动 Antigravity），侧栏监控功能不受影响。</div>';
      }
      if (!convs.length) {
        const emptyKey = 'EMPTY:' + notice;
        if (monitorStructKey !== emptyKey) {
          el.innerHTML = notice + '<div class="empty">最近 25 分钟内无活跃会话</div>';
          monitorStructKey = emptyKey;
        }
        return;
      }

      const now = Date.now();
      const views = convs.map(c => computeCardView(c, state, now));
      const structKey = JSON.stringify([
        notice,
        views.map(v => [v.cid, v.title, v.roleTag, v.muted, v.pingDisabled, v.compactBtnKind, v.showBgHint]),
      ]);

      if (structKey !== monitorStructKey) {
        const playSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
        el.innerHTML = notice + views.map(v =>
          '<div class="card" data-card-cid="' + esc(v.cid) + '">' +
            '<div class="row">' +
              '<div class="title" title="' + esc(v.title) + '">' + esc(v.title) + '</div>' +
              '<div class="row-right">' +
                '<span class="badge ' + v.badgeCls + '" data-f="badge">' + esc(v.badgeText) + '</span>' +
                '<button class="icon-btn" data-act="ping" data-cid="' + esc(v.cid) + '" title="立即 Ping"' + (v.pingDisabled ? ' disabled' : '') + '>' + playSvg + '</button>' +
                '<input type="checkbox" class="mini-switch" data-act="mute" data-cid="' + esc(v.cid) + '"' + (!v.muted ? ' checked' : '') + ' title="' + (v.muted ? '已静音 Ping（点击恢复）' : '允许 Ping（点击静音）') + '" />' +
              '</div>' +
            '</div>' +
            '<div class="meta-line">' +
              '<span>' + v.roleTag + '</span>' +
              '<span class="truncate" data-f="model">' + esc(v.model) + '</span>' +
              '<span data-f="ctx">' + esc(v.ctxLabel) + '</span>' +
            '</div>' +
            '<div class="meta-line">' +
              '<span data-f="idle">' + esc(v.idleText) + '</span>' +
              '<span data-f="turn">' + esc(v.turnText) + '</span>' +
              '<span data-f="pings">' + esc(v.pingsText) + '</span>' +
              (v.showBgHint ? '<span class="bg-hint">等后台</span>' : '') +
            '</div>' +
            (v.compactBtnHtml ? '<div class="actions">' + v.compactBtnHtml + '</div>' : '') +
          '</div>'
        ).join('');
        monitorStructKey = structKey;
        return;
      }

      // Update volatile card fields in place to preserve click targets and tooltip state
      for (const v of views) {
        const card = el.querySelector('[data-card-cid="' + CSS.escape(v.cid) + '"]');
        if (!card) continue;
        const badge = card.querySelector('[data-f="badge"]');
        if (badge) {
          const nextCls = 'badge ' + v.badgeCls;
          if (badge.className !== nextCls) badge.className = nextCls;
          if (badge.textContent !== v.badgeText) badge.textContent = v.badgeText;
        }
        const modelEl = card.querySelector('[data-f="model"]');
        if (modelEl && modelEl.textContent !== v.model) modelEl.textContent = v.model;
        const ctxEl = card.querySelector('[data-f="ctx"]');
        if (ctxEl && ctxEl.textContent !== v.ctxLabel) ctxEl.textContent = v.ctxLabel;
        const idleEl = card.querySelector('[data-f="idle"]');
        if (idleEl && idleEl.textContent !== v.idleText) idleEl.textContent = v.idleText;
        const turnEl = card.querySelector('[data-f="turn"]');
        if (turnEl && turnEl.textContent !== v.turnText) turnEl.textContent = v.turnText;
        const pingsEl = card.querySelector('[data-f="pings"]');
        if (pingsEl && pingsEl.textContent !== v.pingsText) pingsEl.textContent = v.pingsText;
      }
    }

    function renderLogs(state) {
      const el = document.getElementById('pane-logs');
      const events = state.events || [];
      if (!events.length) {
        el.innerHTML = '<div class="empty">暂无保活或压缩记录</div>';
        return;
      }
      const clearBar = '<div class="row" style="margin-bottom:8px"><span style="color:var(--ch-dim)">最近 ' + events.length + ' 条记录</span><button class="btn" id="clearLogsBtn">清空日志</button></div>';
      el.innerHTML = clearBar + events.map(ev => {
        const isCompact = String(ev.type || '').startsWith('compact_');
        let cls = '';
        let outText = ev.outcome || 'pending';
        if (ev.type === 'compact_ready') {
          if (ev.outcome === 'executed') {
            cls = 'hit';
            outText = '已执行热压缩';
          } else if (ev.outcome === 'error') {
            cls = 'miss';
            outText = '压缩失败: ' + (ev.error || '');
          } else if (ev.outcome === 'unverified') {
            cls = 'warn';
            outText = '已发送，未确认落库';
          } else if (ev.outcome === 'dry_run') {
            cls = 'warn';
            outText = '演练模式（未发送）';
          } else if (ev.outcome === 'pending') {
            cls = 'wait';
            outText = '已发送压缩指令…';
          } else {
            cls = 'warn';
            outText = '到达压缩点（仅判别）';
          }
        } else if (ev.type === 'compact_preview_ready') {
          cls = 'wait';
          outText = '模拟到达压缩点';
        } else if (ev.type === 'compact_cancelled' || ev.type === 'compact_preview_cancelled') {
          cls = 'hit';
          const remTxt = ev.remainingSec !== null && ev.remainingSec !== undefined ? ' 剩 ' + ev.remainingSec + 's' : '';
          outText = (ev.type === 'compact_preview_cancelled' ? '模拟取消' : '用户已取消') + remTxt;
        } else if (ev.outcome === 'hit') {
          cls = 'hit';
          outText = '命中 ' + ev.actualHitPct + '% (' + fmtK(ev.actualCachedIn) + ')';
        } else if (ev.outcome === 'miss') {
          cls = 'miss';
          outText = '未命中 ' + (ev.actualHitPct ?? 0) + '%';
        } else if (ev.outcome === 'dry_run') {
          cls = 'warn';
          outText = '演练模式';
        } else if (ev.outcome === 'error') {
          cls = 'miss';
          outText = '失败: ' + (ev.error || '');
        } else {
          cls = 'wait';
          outText = '等待验证';
        }
        const pctStr = ev.contextPct !== null && ev.contextPct !== undefined ? ev.contextPct + '%' : fmtK(ev.contextTokens);
        const detailSpans = isCompact
          ? '<span>' + fmtTime(ev.timestampMs) + '</span>' +
            '<span>' + esc(ev.model || '-') + '</span>' +
            '<span>' + pctStr + '</span>' +
            '<span>' + esc(REASON_ZH[ev.tier] || ev.tier || '尾段压缩') + '</span>' +
            (ev.turnDurationSec !== null && ev.turnDurationSec !== undefined ? '<span>本轮 ' + fmtSec(ev.turnDurationSec) + '</span>' : '') +
            (ev.foreground !== undefined ? '<span>' + (ev.foreground ? '前台窗口' : '后台会话') + '</span>' : '') +
            '<span>' + esc(REASON_ZH[ev.reason] || ev.reason || '') + '</span>'
          : '<span>' + fmtTime(ev.timestampMs) + '</span>' +
            '<span>' + esc(ev.model || '-') + '</span>' +
            '<span>' + pctStr + '</span>' +
            '<span>Ping ' + (ev.pingNumber || 1) + '/' + (ev.maxPings || 2) + '</span>' +
            '<span>空闲 ' + fmtSec(ev.idleSec) + '</span>' +
            (ev.cacheAgeSec !== null && ev.cacheAgeSec !== undefined ? '<span>请求间隔 ' + fmtSec(ev.cacheAgeSec) + '</span>' : '') +
            '<span>' + esc(REASON_ZH[ev.reason] || ev.reason || '') + '</span>';

        return '<div class="card">' +
          '<div class="row">' +
            '<div class="title">' + esc(ev.title || ev.conversationId) + '</div>' +
            '<span class="badge ' + cls + '">' + esc(outText) + '</span>' +
          '</div>' +
          '<div class="meta">' + detailSpans + '</div>' +
        '</div>';
      }).join('');
      const clr = document.getElementById('clearLogsBtn');
      if (clr) clr.onclick = async () => { await api('/api/events/clear', 'POST', {}); await refresh(); };
    }

    let settingsRendered = false;
    function renderSettings(state, force = false) {
      if (settingsRendered && !force) return;
      settingsRendered = true;
      const s = state.settings;
      const el = document.getElementById('pane-settings');
      el.innerHTML =
        '<div class="card"><div class="form-grid">' +
          '<label for="s_enabled">启用自动 Ping 保活</label><input id="s_enabled" type="checkbox"' + (s.enabled ? ' checked' : '') + ' />' +
          '<label for="s_dryRun">演练模式（仅记录日志，不发送 Ping 或压缩指令）</label><input id="s_dryRun" type="checkbox"' + (s.dryRun ? ' checked' : '') + ' />' +
        '</div></div>' +
        '<div class="section-title">尾段热压缩</div>' +
        '<div class="card"><div class="form-grid">' +
          '<label for="s_cmpEnable">启用尾段压缩倒计时</label><input id="s_cmpEnable" type="checkbox"' + (s.compactEnabled ? ' checked' : '') + ' />' +
          '<label for="s_cmpExec">倒计时归零后自动执行 /compact（内部 RPC）</label><input id="s_cmpExec" type="checkbox"' + (s.compactExecuteMode === 'execute' ? ' checked' : '') + ' />' +
          '<label for="s_footerBadge">在输入框底栏显示倒计时角标（CDP）</label><input id="s_footerBadge" type="checkbox"' + (s.enableFooterBadge ? ' checked' : '') + ' />' +
          '<label for="s_cmpPct">常规触发阈值（含后台运行中，%）</label><input id="s_cmpPct" type="number" min="50" max="99" value="' + s.compactThresholdPct + '" />' +
          '<label for="s_cmpLongPct">长任务结束放宽阈值（%）</label><input id="s_cmpLongPct" type="number" min="40" max="99" value="' + s.compactLongTurnThresholdPct + '" />' +
          '<label for="s_cmpLongMin">长任务判定时长（秒）</label><input id="s_cmpLongMin" type="number" min="60" max="3600" value="' + s.compactLongTurnMinSec + '" />' +
          '<label for="s_cmpCountdown">倒计时秒数</label><input id="s_cmpCountdown" type="number" min="15" max="180" value="' + s.compactCountdownSec + '" />' +
        '</div></div>' +
        '<div class="section-title">主对话中段 Ping 规则</div>' +
        '<div class="card"><div class="form-grid">' +
          '<label for="s_minPct">最低上下文占用 (%)</label><input id="s_minPct" type="number" min="0" max="89" value="' + s.minContextPct + '" />' +
          '<label for="s_maxPct">最高上下文占用（尾段停止 Ping，%）</label><input id="s_maxPct" type="number" min="10" max="100" value="' + s.maxContextPct + '" />' +
          '<label for="s_shortSec">短回合时长上限（秒，超时仅在等待后台任务时保活）</label><input id="s_shortSec" type="number" min="30" max="3600" value="' + s.shortTurnMaxSec + '" />' +
          '<label for="s_maxPingsGemini">Gemini* 每轮最多 Ping 次数</label><input id="s_maxPingsGemini" type="number" min="1" max="10" value="' + s.modelMaxPings.gemini + '" />' +
          '<label for="s_maxPingsClaude">Claude* 每轮最多 Ping 次数</label><input id="s_maxPingsClaude" type="number" min="1" max="15" value="' + s.modelMaxPings.claude + '" />' +
          '<label for="s_maxPingsOther">其他模型每轮最多 Ping 次数</label><input id="s_maxPingsOther" type="number" min="1" max="10" value="' + s.modelMaxPings.other + '" />' +
        '</div></div>' +
        '<div class="section-title">分模型触发间隔（秒，自上次请求开始计时）</div>' +
        '<div class="card"><div class="form-grid">' +
          '<label for="s_intCarbon">Gemini 4 Carbon</label><input id="s_intCarbon" type="number" min="60" max="600" value="' + s.modelIntervalsSec.carbon + '" />' +
          '<label for="s_intHydrogen">Gemini 4 Hydrogen</label><input id="s_intHydrogen" type="number" min="60" max="600" value="' + s.modelIntervalsSec.hydrogen + '" />' +
          '<label for="s_intClaude">Claude</label><input id="s_intClaude" type="number" min="60" max="600" value="' + s.modelIntervalsSec.claude + '" />' +
          '<label for="s_intOther">其他模型</label><input id="s_intOther" type="number" min="60" max="600" value="' + s.modelIntervalsSec.other + '" />' +
        '</div></div>' +
        '<div class="section-title">Subagent 后台命令保活</div>' +
        '<div class="card"><div class="form-grid">' +
          '<label for="s_subEnable">仅在运行后台命令时允许 Ping</label><input id="s_subEnable" type="checkbox"' + (s.enableSubagentBgPing ? ' checked' : '') + ' />' +
          '<label for="s_subMinTok">最低上下文 tokens</label><input id="s_subMinTok" type="number" min="10000" max="500000" step="10000" value="' + s.subagentMinTokens + '" />' +
          '<label for="s_subInt">触发间隔（秒）</label><input id="s_subInt" type="number" min="60" max="600" value="' + s.subagentIntervalSec + '" />' +
          '<label for="s_subMax">最多 Ping 次数</label><input id="s_subMax" type="number" min="1" max="3" value="' + s.subagentMaxPings + '" />' +
        '</div></div>' +
        '<div class="actions"><button class="btn btn-primary" id="saveSettingsBtn">保存设置</button><span id="saveMsg" style="color:var(--ch-green)"></span></div>';

      document.getElementById('saveSettingsBtn').onclick = async () => {
        const patch = {
          enabled: document.getElementById('s_enabled').checked,
          dryRun: document.getElementById('s_dryRun').checked,
          compactEnabled: document.getElementById('s_cmpEnable').checked,
          compactExecuteMode: document.getElementById('s_cmpExec').checked ? 'execute' : 'detect_only',
          enableFooterBadge: document.getElementById('s_footerBadge').checked,
          compactThresholdPct: Number(document.getElementById('s_cmpPct').value),
          compactLongTurnThresholdPct: Number(document.getElementById('s_cmpLongPct').value),
          compactLongTurnMinSec: Number(document.getElementById('s_cmpLongMin').value),
          compactCountdownSec: Number(document.getElementById('s_cmpCountdown').value),
          minContextPct: Number(document.getElementById('s_minPct').value),
          maxContextPct: Number(document.getElementById('s_maxPct').value),
          shortTurnMaxSec: Number(document.getElementById('s_shortSec').value),
          modelMaxPings: {
            gemini: Number(document.getElementById('s_maxPingsGemini').value),
            claude: Number(document.getElementById('s_maxPingsClaude').value),
            other: Number(document.getElementById('s_maxPingsOther').value),
          },
          modelIntervalsSec: {
            carbon: Number(document.getElementById('s_intCarbon').value),
            hydrogen: Number(document.getElementById('s_intHydrogen').value),
            claude: Number(document.getElementById('s_intClaude').value),
            other: Number(document.getElementById('s_intOther').value),
          },
          enableSubagentBgPing: document.getElementById('s_subEnable').checked,
          subagentMinTokens: Number(document.getElementById('s_subMinTok').value),
          subagentIntervalSec: Number(document.getElementById('s_subInt').value),
          subagentMaxPings: Number(document.getElementById('s_subMax').value),
        };
        await api('/api/settings', 'POST', patch);
        document.getElementById('saveMsg').textContent = '已保存';
        setTimeout(() => { const m = document.getElementById('saveMsg'); if (m) m.textContent = ''; }, 1500);
        await refresh();
      };
    }

    function render(state, forceSettings = false) {
      const dot = document.getElementById('masterDot');
      const txt = document.getElementById('masterText');
      if (!state.settings.enabled && !state.settings.compactEnabled) {
        dot.className = 'dot';
        txt.textContent = '已暂停';
      } else if (state.settings.dryRun) {
        dot.className = 'dot dry';
        txt.textContent = '演练模式';
      } else {
        dot.className = 'dot on';
        txt.textContent = '运行中';
      }
      if (activeTab === 'monitor') renderMonitor(state);
      else if (activeTab === 'logs') renderLogs(state);
      else if (activeTab === 'settings') renderSettings(state, forceSettings);
    }

    async function refresh() {
      try {
        latestState = await api('/api/status');
        render(latestState, false);
      } catch {}
    }

    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}
