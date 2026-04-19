/**
 * HTML page generators for /tubes and /tubes/:tunnelId.
 * All CSS and JS are inline — zero external dependencies.
 *
 * XSS safety: all user-controlled values (tunnel IDs, request paths, headers)
 * are inserted via textContent or a DOM-level escapeHtml function. innerHTML
 * is used only with string literals that contain no external data.
 */

// ── Lucide SVG icons (inline, no external deps) ────────────────────────────
function icon(paths, size = 14) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;pointer-events:none">${paths}</svg>`;
}
const ICON = {
  eye:     icon('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff:  icon('<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>'),
  copy:    icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  clip:    icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  refresh: icon('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
  pencil:  icon('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  x:       icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  chevron: icon('<path d="m6 9 6 6 6-6"/>'),
};

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1117;--surface:#161b27;--surface2:#1e2438;--border:#2a3050;
  --text:#e2e8f0;--dim:#718096;--green:#48bb78;--red:#fc8181;
  --orange:#f6ad55;--blue:#63b3ed;--purple:#b794f4;--cyan:#76e4f7;
  --gray:#a0aec0;--yellow:#faf089;
}
body{background:var(--bg);color:var(--text);font:14px/1.5 'SF Mono',ui-monospace,monospace;min-height:100vh}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10;flex-wrap:wrap}
header h1{font-size:16px;font-weight:600}
header .dim{color:var(--dim);font-size:12px}
header nav{display:flex;gap:12px;font-size:12px;margin-left:8px}
.sse-dot{width:8px;height:8px;border-radius:50%;background:var(--gray);margin-left:auto;flex-shrink:0}
.sse-dot.ok{background:var(--green);box-shadow:0 0 6px var(--green)}
.sse-dot.err{background:var(--red)}
main{max-width:1400px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:20px}
section{background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden}
section h2{font-size:11px;font-weight:600;padding:9px 14px;border-bottom:1px solid var(--border);color:var(--dim);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:6px}
section h2.collapsible-trigger{cursor:pointer;user-select:none}
section h2 .toggle{margin-left:auto;color:var(--dim);display:inline-flex;align-items:center;transition:transform .25s ease;transform:rotate(-90deg)}
section h2.section-open .toggle{transform:rotate(0deg)}
.collapsible{overflow:hidden;transition:max-height .25s ease;max-height:9999px}
.collapsible.collapsed{max-height:0!important}
.kv{display:grid;grid-template-columns:220px 1fr;border-top:1px solid var(--border)}
.kv dt{padding:6px 14px;color:var(--dim);font-size:12px;border-bottom:1px solid var(--border)}
.kv dd{padding:6px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;word-break:break-all}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:7px 14px;font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)}
td{padding:7px 14px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--surface2)}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:700;letter-spacing:.04em}
.badge.connected{color:var(--green);background:#1a2e22}
.badge.disconnected{color:var(--orange);background:#2e1f0f}
.badge.window{color:var(--yellow);background:#2e2900}
.badge.expired,.badge.destroyed{color:var(--red);background:#2e1515}
.badge.unknown{color:var(--gray);background:var(--surface2)}
.log{overflow-y:auto;max-height:500px}
.log-row{display:grid;padding:5px 14px;gap:8px;border-bottom:1px solid #1a1f30;align-items:baseline;cursor:default}
.log-row:hover{background:var(--surface2)}
.log-ts{color:var(--dim);white-space:nowrap;font-size:12px}
.log-type{font-size:11px;font-weight:700;white-space:nowrap}
.log-detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.t-created{color:var(--blue)}.t-connected,.t-reconnected,.t-complete{color:var(--green)}
.t-disconnected,.t-aborted,.t-ws-closed,.t-ctrl-down{color:var(--orange)}
.t-expired,.t-destroyed,.t-failed,.t-ws-failed,.t-pair-refused{color:var(--red)}
.t-received{color:var(--gray)}.t-delivered{color:var(--cyan)}.t-ws{color:var(--purple)}
.t-ctrl{color:var(--green)}.t-ctrl-resume{color:var(--blue)}.t-pair{color:var(--cyan)}.t-pair-closed{color:var(--gray)}
.t-blocked{color:var(--red)}.t-unblocked{color:var(--gray)}.t-banned{color:var(--orange)}
.t-unbanned{color:var(--green)}.t-rotated{color:var(--blue)}
.stats{display:flex;gap:20px;padding:10px 14px;font-size:12px;color:var(--dim);border-bottom:1px solid var(--border);flex-wrap:wrap}
.stats strong{color:var(--text)}
.actions{padding:10px 14px;display:flex;gap:8px;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center}
button{padding:5px 14px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);cursor:pointer;font-size:13px;font-family:inherit}
button:hover{border-color:var(--blue);color:var(--blue)}
button.danger:hover{border-color:var(--red);color:var(--red)}
.btn-icon{padding:3px 7px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--dim);cursor:pointer;font-size:13px;font-family:inherit;line-height:1;display:inline-flex;align-items:center}
.btn-icon:hover{border-color:var(--blue);color:var(--blue)}
.btn-icon.danger:hover{border-color:var(--red);color:var(--red)}
.token-val{font-family:inherit;font-size:12px;color:var(--text);letter-spacing:.04em}
.token-feedback{font-size:11px;color:var(--green);opacity:0;transition:opacity .3s}
.token-feedback.show{opacity:1}
.input-row{display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid var(--border);align-items:center;flex-wrap:wrap}
.input-row input{flex:1;min-width:160px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font:13px 'SF Mono',ui-monospace,monospace;outline:none}
.input-row input:focus{border-color:var(--blue)}
.empty{color:var(--dim);padding:20px;text-align:center;font-size:13px}
.section-actions{display:flex;gap:4px;margin-left:auto}
section h2 .section-actions+.toggle{margin-left:4px}
/* Debug controls */
.debug-controls{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.debug-pattern{background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font:12px 'SF Mono',ui-monospace,monospace;width:200px;outline:none}
.debug-pattern:focus{border-color:var(--blue)}
.debug-log{overflow-y:auto;max-height:300px;display:flex;flex-direction:column}
.debug-row{display:grid;grid-template-columns:100px 160px 1fr;gap:8px;padding:3px 14px;border-bottom:1px solid #1a1f30;align-items:baseline}
.debug-row:hover{background:var(--surface2)}
.debug-ns{font-size:11px;color:var(--purple);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.debug-msg{font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:pre}
`;

// All client-side logic is in a single IIFE. No external data is passed via
// template literals — tunnel IDs and event data are handled through safe DOM APIs.
const CLIENT_SHARED_JS = `
function esc(s){const d=document.createElement('span');d.textContent=String(s??'');return d.textContent}
const TYPE_META={
  'tunnel.created':         ['t-created',    'CREATED'],
  'tunnel.window_expired':  ['t-expired',    'WIN EXPIRED'],
  'tunnel.destroyed':       ['t-destroyed',  'DESTROYED'],
  'control.connected':      ['t-ctrl',       'CTRL UP'],
  'control.resumed':        ['t-ctrl-resume','CTRL RESUME'],
  'control.disconnected':   ['t-ctrl-down',  'CTRL DOWN'],
  'control.heartbeat_timeout': ['t-ctrl-down','CTRL TIMEOUT'],
  'pair.requested':         ['t-pair',       'PAIR REQ'],
  'pair.opened':            ['t-pair',       'PAIR OPEN'],
  'pair.replaced':          ['t-ctrl-resume','PAIR REPLACE'],
  'pair.local_refused':     ['t-pair-refused','LOCAL REFUSED'],
  'pair.closed':            ['t-pair-closed','PAIR CLOSED'],
  'request.received':       ['t-received',   'REQ \u2192'],
  'request.waiting':        ['t-received',   'WAITING'],
  'request.delivered':      ['t-delivered',  'DELIVERED'],
  'request.failed':         ['t-failed',     'FAILED'],
  'response.complete':      ['t-complete',   'RESPONSE'],
  'response.aborted':       ['t-aborted',    'ABORTED'],
  'ws.received':            ['t-ws',         'WS \u2192'],
  'ws.delivered':           ['t-ws',         'WS \u2191'],
  'ws.failed':              ['t-ws-failed',  'WS ERR'],
  'ws.closed':              ['t-ws-closed',  'WS END'],
  'server.error':           ['t-failed',     'SERVER ERR'],
  'ip.blocked':             ['t-blocked',    'IP BLOCKED'],
  'ip.unblocked':           ['t-unblocked',  'IP UNBLOCKED'],
  'ip.added_permanent':     ['t-banned',     'IP BANNED'],
  'ip.removed_permanent':   ['t-unbanned',   'IP UNBANNED'],
  'server.token_rotated':   ['t-rotated',    'TOKEN ROTATED'],
  'server.request_blocked': ['t-blocked',    'BLOCKED'],
};
function fmtBytes(n){if(!n)return'0 B';if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}
function fmtTime(ts){const d=new Date(ts);return d.toTimeString().slice(0,8)+'.'+String(d.getMilliseconds()).padStart(3,'0')}
function eventSummary(e){
  switch(e.type){
    case'tunnel.created':return'port '+e.port+'  max '+e.maxConnections+' conns  token '+e.sessionTokenPrefix+'\u2026';
    case'tunnel.window_expired':return'no reconnect within window \u2014 tunnel closed';
    case'tunnel.destroyed':return'';
    case'control.connected':return(e.controlId||'').slice(0,8)+'\u2026  from '+(e.remoteAddr||'?');
    case'control.resumed':return(e.controlId||'').slice(0,8)+'\u2026 replaces '+(e.previousControlId||'').slice(0,8)+'\u2026  keep='+(e.keptPairs||0)+' drop='+(e.droppedPairs||0);
    case'control.disconnected':return'reason: '+e.reason+'  inflight: '+((e.inflightPairs||[]).length)+(e.durationMs?'  uptime: '+Math.round(e.durationMs/1000)+'s':'');
    case'control.heartbeat_timeout':return'last pong '+Math.round((e.lastPongAgoMs||0)/1000)+'s ago';
    case'pair.requested':return(e.kind||'?')+'  '+(e.method||'?')+' '+e.path+'  from '+(e.remoteAddr||'?');
    case'pair.opened':return e.pairId+'  req '+(e.requestId||'?').slice(0,6);
    case'pair.replaced':return e.pairId+'  was '+(e.previousControlId||'').slice(0,8)+'\u2026';
    case'pair.local_refused':return e.pairId+'  reason: '+e.reason;
    case'pair.closed':return e.pairId+'  '+e.reason+'  '+e.durationMs+'ms  \u2191'+fmtBytes(e.bytesIn||0)+' \u2193'+fmtBytes(e.bytesOut||0);
    case'request.received':return(e.method||'?')+' '+e.path;
    case'request.waiting':return(e.method||'?')+' '+e.path+'  waiting for socket\u2026';
    case'request.delivered':return(e.method||'?')+' '+e.path+'  pair: '+(e.pairId||'?');
    case'request.failed':return(e.method||'?')+' '+e.path+'  reason: '+e.reason+'  sent: '+e.statusSent;
    case'response.complete':return(e.method||'?')+' '+e.path+'  '+(e.status||'?')+'  '+e.durationMs+'ms  \u2191'+fmtBytes(e.bytesIn)+' \u2193'+fmtBytes(e.bytesOut);
    case'response.aborted':return(e.method||'?')+' '+e.path+'  '+(e.status||'?')+'  '+e.reason+'  '+e.durationMs+'ms  \u2193'+fmtBytes(e.bytesOut);
    case'ws.received':return e.path+'  from '+(e.remoteAddr||'?');
    case'ws.delivered':return e.path+'  pair: '+(e.pairId||'?');
    case'ws.failed':return e.path+'  reason: '+e.reason;
    case'ws.closed':return e.path+'  '+e.reason+'  '+e.durationMs+'ms  \u2191'+fmtBytes(e.bytesIn)+' \u2193'+fmtBytes(e.bytesOut);
    case'server.error':{
      const parts=[];
      if(e.method)parts.push(e.method);
      if(e.host)parts.push(e.host);
      if(e.path&&e.path!=='/')parts.push(e.path);
      if(e.clientIp)parts.push('from '+e.clientIp);
      if(e.reason)parts.push('reason: '+e.reason);
      if(e.statusSent)parts.push('\u2192 '+e.statusSent);
      if(e.detail)parts.push('('+e.detail+')');
      return parts.join('  ');
    }
    case'ip.blocked':return e.ip+'  threshold='+e.threshold+'  window='+Math.round((e.windowMs||0)/1000)+'s  until='+new Date(e.blockedUntil||0).toLocaleTimeString();
    case'ip.unblocked':return e.ip+'  reason='+e.reason;
    case'ip.added_permanent':return e.ip;
    case'ip.removed_permanent':return e.ip;
    case'server.token_rotated':return'new prefix: '+e.tokenPrefix+'\u2026';
    case'server.request_blocked':return e.ip+'  '+(e.method||'?')+' '+(e.host||'')+'  reason='+e.reason;
    default:return e.type;
  }
}
function makeTd(text,cls){const td=document.createElement('td');if(cls)td.className=cls;td.textContent=text;return td}
function makeSpan(text,cls){const s=document.createElement('span');if(cls)s.className=cls;s.textContent=text;return s}
/**
 * Build a log row element using DOM APIs (no innerHTML with external data).
 * @param {object} e - event object
 * @param {boolean} showTunnel - whether to show the tunnelId column
 */
function makeLogRow(e, showTunnel) {
  const meta = TYPE_META[e.type] || ['t-received','?'];
  const row = document.createElement('div');
  row.className = 'log-row';
  row.style.gridTemplateColumns = showTunnel ? '90px 130px 110px 1fr' : '90px 110px 1fr';
  row.title = JSON.stringify(e, null, 2);

  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = fmtTime(e.ts);
  row.appendChild(ts);

  if (showTunnel) {
    if (e.tunnelId === '__global__') {
      const span = document.createElement('span');
      span.className = 'log-detail';
      span.textContent = 'server';
      row.appendChild(span);
    } else {
      const a = document.createElement('a');
      a.href = '/tubes/' + encodeURIComponent(e.tunnelId);
      a.textContent = e.tunnelId;
      row.appendChild(a);
    }
  }

  const typeEl = document.createElement('span');
  typeEl.className = 'log-type ' + meta[0];
  typeEl.textContent = meta[1];
  row.appendChild(typeEl);

  const detail = document.createElement('span');
  detail.className = 'log-detail';
  detail.textContent = eventSummary(e);
  row.appendChild(detail);

  return row;
}
function appendRow(container, row, max) {
  const placeholder = container.querySelector('.empty');
  if(placeholder) container.removeChild(placeholder);
  container.appendChild(row);
  while(container.children.length > (max||300)) container.removeChild(container.firstChild);
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  if(wasAtBottom) container.scrollTop = container.scrollHeight;
}
function appendDebugRow(container, entry) {
  const placeholder = container.querySelector('.empty');
  if(placeholder) container.removeChild(placeholder);
  const row = document.createElement('div');
  row.className = 'debug-row';
  const ts = document.createElement('span'); ts.className = 'log-ts'; ts.textContent = fmtTime(entry.ts);
  const ns = document.createElement('span'); ns.className = 'debug-ns'; ns.textContent = entry.ns;
  const msg = document.createElement('span'); msg.className = 'debug-msg'; msg.textContent = entry.msg;
  row.appendChild(ts); row.appendChild(ns); row.appendChild(msg);
  container.appendChild(row);
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  if(wasAtBottom) container.scrollTop = container.scrollHeight;
}
function clearDebugDom(container) {
  while(container.firstChild) container.removeChild(container.firstChild);
  const ph = document.createElement('div'); ph.className = 'empty'; ph.textContent = 'No debug entries';
  container.appendChild(ph);
}
function copyContainerText(container, rowClass) {
  const lines = Array.from(container.querySelectorAll('.'+rowClass)).map(r =>
    Array.from(r.children).map(c => c.textContent.trim()).join('  ')
  );
  navigator.clipboard?.writeText(lines.join('\\n')).catch(() => {});
}
function setupDebugSection(logId, clearBtnId, copyBtnId, toggleUrl, clearUrl) {
  const logEl = document.getElementById(logId);
  if(!logEl) return;

  const btnClear = document.getElementById(clearBtnId);
  if(btnClear) btnClear.addEventListener('click', ev => {
    ev.stopPropagation();
    fetch(clearUrl, { method:'POST', headers: _adminHeaders() }).catch(() => {});
  });

  const btnCopy = document.getElementById(copyBtnId);
  if(btnCopy) btnCopy.addEventListener('click', ev => {
    ev.stopPropagation();
    copyContainerText(logEl, 'debug-row');
  });

  // Connect debug SSE
  let es;
  function connectDebugSse(){
    es = new EventSource('/tubes/debug/events');
    es.onmessage = ev => {
      try {
        const e = JSON.parse(ev.data);
        if(e.type === 'debug.state' || e.type === 'debug.changed') {
          _applyDebugState(e);
          if(e.type === 'debug.changed') appendDebugRow(logEl, { ts: e.ts, ns: 'debug', msg: (e.enabled ? 'enabled' : 'disabled') + ' pattern=' + e.pattern });
        } else if(e.type === 'debug.log') appendDebugRow(logEl, e);
        else if(e.type === 'debug.cleared') clearDebugDom(logEl);
      } catch {}
    };
    es.onerror = () => { es.close(); setTimeout(connectDebugSse, 3000); };
  }
  connectDebugSse();

  // Debug level controls
  const cb = document.getElementById('debug-enabled');
  const pi = document.getElementById('debug-pattern');
  function setLevel(){
    const enabled = cb ? cb.checked : false;
    const pattern = pi ? (pi.value.trim() || 'tt:*') : 'tt:*';
    fetch(toggleUrl, { method:'POST', headers:Object.assign({'Content-Type':'application/json'}, _adminHeaders()), body: JSON.stringify({ enabled, pattern }) }).catch(() => {});
  }
  if(cb) cb.addEventListener('change', setLevel);
  if(pi){ pi.addEventListener('change', setLevel); pi.addEventListener('keydown', e => { if(e.key==='Enter') setLevel(); }); }
}
function _applyDebugState(e) {
  const cb = document.getElementById('debug-enabled');
  const pi = document.getElementById('debug-pattern');
  if(cb && e.enabled != null) cb.checked = e.enabled;
  if(pi && e.pattern != null) pi.value = e.pattern;
}
// Overridden per page with actual token
let _getAdminToken = () => '';
function _adminHeaders(){ const t = _getAdminToken(); return t ? {'X-TT-Admin-Token': t} : {}; }
function setupSse(url, onEvent, dotEl) {
  const es = new EventSource(url);
  es.onmessage = ev => { try { onEvent(JSON.parse(ev.data)); } catch {} };
  es.onopen = () => { if(dotEl) dotEl.className = 'sse-dot ok'; };
  es.onerror = () => { if(dotEl) dotEl.className = 'sse-dot err'; };
  return es;
}
function setupCollapsible() {
  document.querySelectorAll('section h2.collapsible-trigger').forEach(h2 => {
    const body = document.getElementById(h2.dataset.collapse);
    if (!body) return;
    // Set initial open state based on whether body starts collapsed
    if (!body.classList.contains('collapsed')) h2.classList.add('section-open');
    h2.addEventListener('click', (ev) => {
      // Don't toggle if click was on an action button inside h2
      if (ev.target.closest('.section-actions')) return;
      const collapsed = body.classList.toggle('collapsed');
      h2.classList.toggle('section-open', !collapsed);
    });
  });
}
function setupClearLog(btnId, logId, placeholder, clearUrl) {
  const btn = document.getElementById(btnId);
  const log = document.getElementById(logId);
  if (!btn || !log) return;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (clearUrl) {
      // Server-side clear; DOM will be reset on events.cleared SSE event
      fetch(clearUrl, { method:'POST', headers: _adminHeaders() }).catch(() => {});
    } else {
      _clearLogDom(log, placeholder);
    }
  });
}
function _clearLogDom(log, placeholder) {
  while (log.firstChild) log.removeChild(log.firstChild);
  if (placeholder) {
    const el = document.createElement('div');
    el.className = 'empty'; el.textContent = placeholder;
    log.appendChild(el);
  }
  const countEl = log.closest('section')?.querySelector('[id$="-count"]');
  if (countEl) countEl.textContent = '0';
}
function setupCopyLog(btnId, logId) {
  const btn = document.getElementById(btnId);
  const log = document.getElementById(logId);
  if (!btn || !log) return;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    copyContainerText(log, 'log-row');
  });
}
`;

/**
 * Generate the HTML for GET /tubes (overview page).
 *
 * @param {object} filteredConfig - server config with secrets removed (adminToken excluded)
 * @param {string} adminToken     - the actual admin token (shown masked in the UI)
 * @returns {string}
 */
export function adminIndexPage(filteredConfig, adminToken) {
  const configEntries = JSON.stringify(Object.entries(filteredConfig));
  // Inject token safely via JSON — never as raw HTML
  const tokenJson = JSON.stringify(adminToken ?? '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>the tubes admin</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>the tubes</h1>
  <nav>
    <a href="/tubes">tunnels</a>
    <a href="/tubes/blocklist">blocklist</a>
  </nav>
  <span class="dim" id="uptime"></span>
  <span class="sse-dot" id="sse-dot"></span>
</header>
<main>
  <section>
    <h2 class="collapsible-trigger section-open" data-collapse="tunnels-wrap">Active tunnels (<span id="tunnel-count">0</span>) <span class="toggle">${ICON.chevron}</span></h2>
    <div id="tunnels-wrap" class="collapsible">
      <table>
        <thead><tr>
          <th>Tunnel ID</th><th>Status</th><th>Port</th>
          <th>Sockets</th><th>Created</th>
          <th>Requests</th><th>Failures</th><th>Last activity</th>
        </tr></thead>
        <tbody id="tunnels-body"></tbody>
      </table>
    </div>
  </section>
  <section>
    <h2 class="collapsible-trigger section-open" data-collapse="activity-wrap">
      Server activity
      <span class="section-actions">
        <button class="btn-icon" id="btn-copy-log" title="Copy events">${ICON.clip}</button>
        <button class="btn-icon danger" id="btn-clear-log" title="Clear events">${ICON.x}</button>
      </span>
      <span class="toggle">${ICON.chevron}</span>
    </h2>
    <div id="activity-wrap" class="collapsible">
      <div class="log" id="event-log">
        <div class="empty">Waiting for events\u2026</div>
      </div>
    </div>
  </section>
  <section>
    <h2 class="collapsible-trigger" data-collapse="debug-wrap">
      Debug
      <span class="section-actions">
        <button class="btn-icon" id="btn-copy-debug" title="Copy debug log">${ICON.clip}</button>
        <button class="btn-icon danger" id="btn-clear-debug" title="Clear debug log">${ICON.x}</button>
      </span>
      <span class="toggle">${ICON.chevron}</span>
    </h2>
    <div id="debug-wrap" class="collapsible collapsed">
      <div class="debug-controls">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="debug-enabled"> Enable
        </label>
        <input type="text" id="debug-pattern" class="debug-pattern" value="tt:*" placeholder="tt:*" title="Namespace pattern (e.g. tt:*, tt:server:*)">
      </div>
      <div id="debug-log" class="debug-log">
        <div class="empty">No debug entries</div>
      </div>
    </div>
  </section>
  <section>
    <h2 class="collapsible-trigger" data-collapse="config-wrap">Server configuration <span class="toggle">${ICON.chevron}</span></h2>
    <div id="config-wrap" class="collapsible collapsed">
      <dl class="kv" id="config-kv">
        <dt>Admin Token</dt>
        <dd>
          <span class="token-val" id="token-display"></span>
          <button class="btn-icon" id="btn-token-reveal" title="Reveal / hide token">
            <span id="icon-eye-show">${ICON.eye}</span>
            <span id="icon-eye-hide" style="display:none">${ICON.eyeOff}</span>
          </button>
          <button class="btn-icon" id="btn-token-copy" title="Copy token">${ICON.copy}</button>
          <button class="btn-icon" id="btn-token-rotate" title="Rotate to new random token">${ICON.refresh}</button>
          <button class="btn-icon" id="btn-token-set" title="Set specific token value">${ICON.pencil}</button>
          <span class="token-feedback" id="token-feedback"></span>
        </dd>
      </dl>
      <div class="input-row" id="set-token-row" style="display:none">
        <input type="text" id="set-token-input" placeholder="New token (min 8 chars, a-z A-Z 0-9 _ -)" autocomplete="off" spellcheck="false">
        <button id="btn-token-set-confirm">Set</button>
        <button id="btn-token-set-cancel">Cancel</button>
      </div>
      <dl class="kv" id="config-kv-rest"></dl>
    </div>
  </section>
</main>
<script>
${CLIENT_SHARED_JS}

// ── Admin token UI ────────────────────────────────────────────────────────────
;(function() {
  let token = ${tokenJson};
  _getAdminToken = () => token;
  let revealed = false;
  const display   = document.getElementById('token-display');
  const feedback  = document.getElementById('token-feedback');
  const iconShow  = document.getElementById('icon-eye-show');
  const iconHide  = document.getElementById('icon-eye-hide');

  function mask(t) { return t ? t.slice(0,8)+'\u2026'+t.slice(-4) : '(none)'; }
  function render() { display.textContent = revealed ? token : mask(token); }
  function syncRevealIcon() {
    iconShow.style.display = revealed ? 'none' : '';
    iconHide.style.display = revealed ? '' : 'none';
  }
  render();

  function showFeedback(msg, color) {
    feedback.textContent = msg;
    feedback.style.color = color || 'var(--green)';
    feedback.classList.add('show');
    setTimeout(() => feedback.classList.remove('show'), 2000);
  }

  document.getElementById('btn-token-reveal').addEventListener('click', (ev) => {
    ev.stopPropagation();
    revealed = !revealed;
    render();
    syncRevealIcon();
  });

  document.getElementById('btn-token-copy').addEventListener('click', (ev) => {
    ev.stopPropagation();
    navigator.clipboard?.writeText(token).then(
      () => showFeedback('Copied!'),
      () => showFeedback('Copy failed', 'var(--red)')
    );
  });

  document.getElementById('btn-token-rotate').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!confirm('Rotate the admin token?\\nAll existing sessions using the current token will stop working.')) return;
    try {
      const res = await fetch('/api/admin/rotate-token', {
        method: 'POST',
        headers: { 'X-TT-Admin-Token': token },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { showFeedback(body.error || 'Error', 'var(--red)'); return; }
      token = body.token;
      revealed = true;
      render();
      syncRevealIcon();
      showFeedback('Token rotated \u2014 copy it now!');
    } catch (err) {
      showFeedback(err.message, 'var(--red)');
    }
  });

  // ── Set specific token value ──────────────────────────────────────────────
  const setRow   = document.getElementById('set-token-row');
  const setInput = document.getElementById('set-token-input');

  document.getElementById('btn-token-set').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const visible = setRow.style.display !== 'none';
    setRow.style.display = visible ? 'none' : 'flex';
    if (!visible) setInput.focus();
  });

  document.getElementById('btn-token-set-cancel').addEventListener('click', (ev) => {
    ev.stopPropagation();
    setRow.style.display = 'none';
    setInput.value = '';
  });

  document.getElementById('btn-token-set-confirm').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const newToken = setInput.value.trim();
    if (!newToken) return;
    try {
      const res = await fetch('/api/admin/set-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TT-Admin-Token': token },
        body: JSON.stringify({ token: newToken }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { showFeedback(body.error || 'Error', 'var(--red)'); return; }
      token = body.token;
      revealed = true;
      render();
      syncRevealIcon();
      setRow.style.display = 'none';
      setInput.value = '';
      showFeedback('Token updated \u2014 copy it now!');
    } catch (err) {
      showFeedback(err.message, 'var(--red)');
    }
  });

  setInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') document.getElementById('btn-token-set-confirm').click();
    if (ev.key === 'Escape') document.getElementById('btn-token-set-cancel').click();
  });

  // Update token when server.token_rotated SSE arrives
  window._onTokenRotated = (newPrefix) => {
    showFeedback('Token rotated elsewhere \u2014 refresh to get new token', 'var(--orange)');
    display.textContent = newPrefix + '\u2026(rotated)';
  };
})();

// ── Config table (remaining entries) ─────────────────────────────────────────
;(function() {
  const entries = ${configEntries};
  const kv = document.getElementById('config-kv-rest');
  for (const [k, v] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v == null ? '\u2014' : String(v);
    kv.appendChild(dt);
    kv.appendChild(dd);
  }
})();

const tunnels = new Map();
let startedAt = null;

function badgeEl(status) {
  const s = document.createElement('span');
  s.className = 'badge ' + status;
  s.textContent = status;
  return s;
}

function renderTunnels() {
  const tbody = document.getElementById('tunnels-body');
  const active = [...tunnels.values()].filter(t => t.status !== 'destroyed' && t.status !== 'expired');
  document.getElementById('tunnel-count').textContent = active.length;
  tbody.textContent = ''; // safe clear
  if (!active.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8; td.className = 'empty';
    td.textContent = 'No active tunnels';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const t of active) {
    const tr = document.createElement('tr');
    // ID + link
    const tdId = document.createElement('td');
    const a = document.createElement('a');
    a.href = '/tubes/' + encodeURIComponent(t.id);
    a.textContent = t.id;
    tdId.appendChild(a);
    // Status badge
    const tdStatus = document.createElement('td');
    tdStatus.appendChild(badgeEl(t.status));
    // Plain text cells
    const cells = [
      t.port ?? '\u2014',
      (t.activeCount ?? 0) + ' / ' + (t.maxConnections ?? '?'),
      t.created ? new Date(t.created).toLocaleTimeString() : '\u2014',
      t.reqCount ?? 0,
      t.failCount ?? 0,
      t.lastActivity ? new Date(t.lastActivity).toLocaleTimeString() : '\u2014',
    ];
    tr.appendChild(tdId);
    tr.appendChild(tdStatus);
    for (const v of cells) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function updateTunnel(id, patch) {
  const t = tunnels.get(id);
  if (t) { Object.assign(t, patch); renderTunnels(); }
}

function handleEvent(e) {
  switch (e.type) {
    case 'server.state':
      startedAt = e.startedAt;
      for (const t of (e.tunnels ?? [])) {
        tunnels.set(t.tunnelId, {
          id: t.tunnelId,
          status: t.controlConnected ? 'connected' : 'disconnected',
          port: t.port, maxConnections: t.maxConnections,
          activeCount: t.activeConnections ?? 0,
          created: t.createdAt,
          reqCount: 0, failCount: 0, lastActivity: null,
        });
      }
      renderTunnels();
      return;
    case 'tunnel.created':
      tunnels.set(e.tunnelId, {
        id: e.tunnelId, status: 'disconnected',
        port: e.port, maxConnections: e.maxConnections,
        activeCount: 0, created: e.ts,
        reqCount: 0, failCount: 0, lastActivity: null,
      });
      renderTunnels();
      break;
    case 'control.connected':
    case 'control.resumed':
      updateTunnel(e.tunnelId, { status: 'connected' });
      break;
    case 'control.disconnected':
    case 'control.heartbeat_timeout':
      updateTunnel(e.tunnelId, { status: 'disconnected' });
      break;
    case 'pair.opened':
      updateTunnel(e.tunnelId, { activeCount: (tunnels.get(e.tunnelId)?.activeCount ?? 0) + 1 });
      break;
    case 'pair.closed':
    case 'pair.local_refused':
      updateTunnel(e.tunnelId, { activeCount: Math.max(0, (tunnels.get(e.tunnelId)?.activeCount ?? 0) - 1) });
      break;
    case 'tunnel.window_expired':
      updateTunnel(e.tunnelId, { status: 'expired' });
      break;
    case 'tunnel.destroyed':
      updateTunnel(e.tunnelId, { status: 'destroyed' });
      break;
    case 'request.received':
      updateTunnel(e.tunnelId, { lastActivity: e.ts });
      break;
    case 'request.failed':
      updateTunnel(e.tunnelId, {
        failCount: (tunnels.get(e.tunnelId)?.failCount ?? 0) + 1,
        lastActivity: e.ts,
      });
      break;
    case 'response.complete':
      updateTunnel(e.tunnelId, {
        reqCount: (tunnels.get(e.tunnelId)?.reqCount ?? 0) + 1,
        lastActivity: e.ts,
      });
      break;
  }

  // Security events always shown in server activity log
  const SECURITY_EVENTS = new Set([
    'ip.blocked','ip.unblocked','ip.added_permanent','ip.removed_permanent',
    'server.token_rotated','server.request_blocked',
  ]);
  // Tunnel lifecycle events shown in server activity log
  const ADMIN_EVENTS = new Set([
    'tunnel.created','tunnel.window_expired','tunnel.destroyed',
    'control.connected','control.resumed','control.disconnected','control.heartbeat_timeout',
    'request.failed','response.aborted','ws.failed','pair.local_refused',
  ]);
  const showInLog = e.type === 'server.error'
    || SECURITY_EVENTS.has(e.type)
    || (e.tunnelId !== '__global__' && ADMIN_EVENTS.has(e.type));

  if (e.type === 'events.cleared') {
    _clearLogDom(document.getElementById('event-log'), 'Waiting for events\u2026');
    return;
  }

  if (showInLog) {
    const log = document.getElementById('event-log');
    appendRow(log, makeLogRow(e, true));
  }

  // Notify token UI on rotation
  if (e.type === 'server.token_rotated') {
    window._onTokenRotated?.(e.tokenPrefix);
  }
}

// Uptime ticker
setInterval(() => {
  if (!startedAt) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const el = document.getElementById('uptime');
  if (el) el.textContent = 'up ' + h + 'h ' + String(m).padStart(2,'0') + 'm ' + String(sec).padStart(2,'0') + 's';
}, 1000);

setupSse('/tubes/events', handleEvent, document.getElementById('sse-dot'));
setupCollapsible();
setupClearLog('btn-clear-log', 'event-log', 'Waiting for events\u2026', '/tubes/events/clear');
setupCopyLog('btn-copy-log', 'event-log');
setupDebugSection('debug-log', 'btn-clear-debug', 'btn-copy-debug', '/tubes/debug', '/tubes/debug/clear');
</script>
</body>
</html>`;
}

/**
 * Generate the HTML for GET /tubes/:tunnelId (tunnel detail page).
 * The tunnelId is inserted only via JSON.stringify (safe for JS context)
 * and encodeURIComponent (safe for URL context).
 *
 * @param {string} tunnelId
 * @param {string} [adminToken]
 * @returns {string}
 */
export function adminTunnelPage(tunnelId, adminToken) {
  // Serialised for use in a JS string literal only — never injected raw into HTML.
  const tunnelIdJson = JSON.stringify(tunnelId);
  const tokenJson = JSON.stringify(adminToken ?? '');
  // Safe URL-encoded for href attributes
  const tunnelIdUrl = encodeURIComponent(tunnelId);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>the tubes admin</title>
<style>${CSS}
.log-row{grid-template-columns:90px 110px 1fr}
</style>
</head>
<body>
<header>
  <a href="/tubes">\u2190 all tunnels</a>
  <span id="tunnel-title" style="font-weight:700;font-size:16px"></span>
  <span class="badge unknown" id="status-badge">unknown</span>
  <span class="sse-dot" id="sse-dot"></span>
</header>
<main>
  <section>
    <h2 class="collapsible-trigger section-open" data-collapse="status-wrap">Status <span class="toggle">${ICON.chevron}</span></h2>
    <div id="status-wrap" class="collapsible">
      <div class="stats">
        <span>Port: <strong id="tunnel-port">\u2014</strong></span>
        <span>Active pairs: <strong id="tunnel-sockets">\u2014</strong></span>
        <span>Max: <strong id="tunnel-maxconn">\u2014</strong></span>
        <span>Created: <strong id="tunnel-created">\u2014</strong></span>
        <span>Requests ok: <strong id="tunnel-reqs">0</strong></span>
        <span>Failed: <strong id="tunnel-fails">0</strong></span>
        <span>Aborted: <strong id="tunnel-aborted">0</strong></span>
      </div>
      <div class="actions">
        <button class="danger" id="btn-disconnect">Force disconnect</button>
      </div>
    </div>
  </section>
  <section>
    <h2 class="collapsible-trigger section-open" data-collapse="eventlog-wrap">
      Event log (<span id="event-count">0</span> events)
      <span class="section-actions">
        <button class="btn-icon" id="btn-copy-log" title="Copy events">${ICON.clip}</button>
        <button class="btn-icon danger" id="btn-clear-log" title="Clear events">${ICON.x}</button>
      </span>
      <span class="toggle">${ICON.chevron}</span>
    </h2>
    <div id="eventlog-wrap" class="collapsible">
      <div class="log" id="event-log">
        <div class="empty">Waiting for events\u2026</div>
      </div>
    </div>
  </section>
  <section>
    <h2 class="collapsible-trigger" data-collapse="debug-wrap">
      Debug
      <span class="section-actions">
        <button class="btn-icon" id="btn-copy-debug" title="Copy debug log">${ICON.clip}</button>
        <button class="btn-icon danger" id="btn-clear-debug" title="Clear debug log">${ICON.x}</button>
      </span>
      <span class="toggle">${ICON.chevron}</span>
    </h2>
    <div id="debug-wrap" class="collapsible collapsed">
      <div class="debug-controls">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="debug-enabled"> Enable
        </label>
        <input type="text" id="debug-pattern" class="debug-pattern" value="tt:*" placeholder="tt:*" title="Namespace pattern">
      </div>
      <div id="debug-log" class="debug-log">
        <div class="empty">No debug entries</div>
      </div>
    </div>
  </section>
</main>
<script>
${CLIENT_SHARED_JS}

const tunnelId = ${tunnelIdJson};
_getAdminToken = () => ${tokenJson};
let reqCount = 0, failCount = 0, abortCount = 0, eventCount = 0;

// Set tunnel title via DOM (safe)
document.getElementById('tunnel-title').textContent = tunnelId;

function setField(id, val) {
  const el = document.getElementById(id);
  if (el && val != null) el.textContent = val;
}

function updateStatus(status) {
  const badge = document.getElementById('status-badge');
  badge.className = 'badge ' + status;
  badge.textContent = status;
}

function handleEvent(e) {
  switch (e.type) {
    case 'server.state': {
      const t = (e.tunnels ?? []).find(t => t.tunnelId === tunnelId);
      if (t) {
        setField('tunnel-port', t.port ?? '\u2014');
        setField('tunnel-sockets', t.activeConnections ?? 0);
        setField('tunnel-maxconn', t.maxConnections ?? '\u2014');
        setField('tunnel-created', t.createdAt ? new Date(t.createdAt).toLocaleTimeString() : '\u2014');
        updateStatus(t.controlConnected ? 'connected' : 'disconnected');
      }
      return;
    }
    case 'tunnel.created':
      setField('tunnel-port', e.port ?? '\u2014');
      setField('tunnel-maxconn', e.maxConnections ?? '\u2014');
      updateStatus('disconnected');
      break;
    case 'control.connected':
    case 'control.resumed':
      updateStatus('connected');
      break;
    case 'control.disconnected':
    case 'control.heartbeat_timeout':
      updateStatus('disconnected');
      break;
    case 'pair.opened': {
      const cur = parseInt(document.getElementById('tunnel-sockets')?.textContent || '0', 10) || 0;
      setField('tunnel-sockets', cur + 1);
      break;
    }
    case 'pair.closed':
    case 'pair.local_refused': {
      const cur = parseInt(document.getElementById('tunnel-sockets')?.textContent || '0', 10) || 0;
      setField('tunnel-sockets', Math.max(0, cur - 1));
      break;
    }
    case 'tunnel.window_expired':
      updateStatus('expired');
      break;
    case 'tunnel.destroyed':
      updateStatus('destroyed');
      break;
    case 'request.failed':
      failCount++;
      setField('tunnel-fails', failCount);
      break;
    case 'response.complete':
      reqCount++;
      setField('tunnel-reqs', reqCount);
      break;
    case 'response.aborted':
      abortCount++;
      setField('tunnel-aborted', abortCount);
      break;
  }

  const log = document.getElementById('event-log');

  if (e.type === 'events.cleared') {
    _clearLogDom(log, 'Waiting for events\u2026');
    eventCount = 0;
    setField('event-count', 0);
    return;
  }

  appendRow(log, makeLogRow(e, false));
  eventCount++;
  setField('event-count', eventCount);
}

// Disconnect action
document.getElementById('btn-disconnect').addEventListener('click', async () => {
  const name = tunnelId; // read from JS const, not DOM
  if (!confirm('Force disconnect tunnel "' + name + '"?\\nThe expose client will reconnect automatically if still running.')) return;
  try {
    const res = await fetch('/tubes/' + encodeURIComponent(name) + '/disconnect', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) alert('Error: ' + (body.error || res.statusText));
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
});

setupSse('/tubes/${tunnelIdUrl}/events', handleEvent, document.getElementById('sse-dot'));
setupCollapsible();
setupClearLog('btn-clear-log', 'event-log', 'Waiting for events\u2026', '/tubes/${tunnelIdUrl}/events/clear');
setupCopyLog('btn-copy-log', 'event-log');
setupDebugSection('debug-log', 'btn-clear-debug', 'btn-copy-debug', '/tubes/debug', '/tubes/debug/clear');
</script>
</body>
</html>`;
}

/**
 * Generate the HTML for GET /tubes/blocklist.
 *
 * @param {object} opts
 * @param {Array<{ip: string, blockedUntil: string}>} opts.tempBlocked
 * @param {string[]} opts.permBlocked
 * @returns {string}
 */
export function adminBlocklistPage({ tempBlocked = [], permBlocked = [] }) {
  const tempJson = JSON.stringify(tempBlocked);
  const permJson = JSON.stringify(permBlocked);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>the tubes \u2014 blocklist</title>
<style>${CSS}
.bl-table td:last-child{text-align:right}
</style>
</head>
<body>
<header>
  <a href="/tubes">\u2190 tunnels</a>
  <h1 style="margin-left:8px">Blocklist</h1>
  <nav style="margin-left:12px">
    <a href="/tubes">tunnels</a>
    <a href="/tubes/blocklist">blocklist</a>
  </nav>
  <span class="sse-dot" id="sse-dot" style="margin-left:auto"></span>
</header>
<main>

  <!-- Temporary blocks (rate-limiter) -->
  <section>
    <h2 class="collapsible-trigger section-open" data-collapse="temp-wrap">
      Temporary blocks (<span id="temp-count">0</span>)
      <span class="toggle">${ICON.chevron}</span>
    </h2>
    <div id="temp-wrap" class="collapsible">
      <table class="bl-table">
        <thead><tr><th>IP</th><th>Blocked until</th><th></th></tr></thead>
        <tbody id="temp-body"></tbody>
      </table>
    </div>
  </section>

  <!-- Permanent blocks -->
  <section>
    <h2 class="collapsible-trigger section-open" data-collapse="perm-wrap">
      Permanent blocks (<span id="perm-count">0</span>)
      <span class="toggle">${ICON.chevron}</span>
    </h2>
    <div id="perm-wrap" class="collapsible">
      <div class="input-row">
        <input id="perm-ip-input" type="text" placeholder="IP address to block (e.g. 1.2.3.4 or ::1)" autocomplete="off" spellcheck="false">
        <button id="btn-perm-add">Add</button>
        <span id="perm-feedback" class="token-feedback"></span>
      </div>
      <table class="bl-table">
        <thead><tr><th>IP</th><th></th></tr></thead>
        <tbody id="perm-body"></tbody>
      </table>
    </div>
  </section>

</main>
<script>
(function(){

let tempBlocked = ${tempJson};
let permBlocked = ${permJson};

function fmtUntil(iso) {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}

function showFeedback(id, msg, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || 'var(--green)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

function clearTbody(id) {
  const t = document.getElementById(id);
  while (t.firstChild) t.removeChild(t.firstChild);
  return t;
}

// ── Render temp ───────────────────────────────────────────────────────────────
function renderTemp() {
  const tbody = clearTbody('temp-body');
  document.getElementById('temp-count').textContent = tempBlocked.length;
  if (!tempBlocked.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3; td.className = 'empty'; td.textContent = 'None';
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  for (const b of tempBlocked) {
    const tr = document.createElement('tr');
    const tdIp = document.createElement('td'); tdIp.textContent = b.ip;
    const tdUntil = document.createElement('td'); tdUntil.textContent = fmtUntil(b.blockedUntil);
    const tdAct = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'btn-icon danger'; btn.textContent = 'Unblock';
    btn.addEventListener('click', () => unblockTemp(b.ip));
    tdAct.appendChild(btn);
    tr.appendChild(tdIp); tr.appendChild(tdUntil); tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
}

// ── Render perm ───────────────────────────────────────────────────────────────
function renderPerm() {
  const tbody = clearTbody('perm-body');
  document.getElementById('perm-count').textContent = permBlocked.length;
  if (!permBlocked.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2; td.className = 'empty'; td.textContent = 'None';
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  for (const ip of permBlocked) {
    const tr = document.createElement('tr');
    const tdIp = document.createElement('td'); tdIp.textContent = ip;
    const tdAct = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'btn-icon danger'; btn.textContent = 'Remove';
    btn.addEventListener('click', () => removePerm(ip));
    tdAct.appendChild(btn);
    tr.appendChild(tdIp); tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function unblockTemp(ip) {
  try {
    const res = await fetch('/api/blocklist/temp/' + encodeURIComponent(ip), { method: 'DELETE' });
    if (!res.ok) { showFeedback('temp-feedback', 'Error: ' + res.status, 'var(--red)'); return; }
    tempBlocked = tempBlocked.filter(b => b.ip !== ip);
    renderTemp();
  } catch (err) { showFeedback('temp-feedback', err.message, 'var(--red)'); }
}

async function removePerm(ip) {
  try {
    const res = await fetch('/api/blocklist/permanent/' + encodeURIComponent(ip), { method: 'DELETE' });
    if (!res.ok) { showFeedback('perm-feedback', 'Error: ' + res.status, 'var(--red)'); return; }
    permBlocked = permBlocked.filter(x => x !== ip);
    renderPerm();
  } catch (err) { showFeedback('perm-feedback', err.message, 'var(--red)'); }
}

document.getElementById('btn-perm-add').addEventListener('click', async () => {
  const input = document.getElementById('perm-ip-input');
  const ip = input.value.trim();
  if (!ip) return;
  try {
    const res = await fetch('/api/blocklist/permanent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { showFeedback('perm-feedback', body.error || 'Error', 'var(--red)'); return; }
    if (!body.ok) { showFeedback('perm-feedback', 'Already in list'); return; }
    if (!permBlocked.includes(ip)) permBlocked.push(ip);
    input.value = '';
    renderPerm();
    showFeedback('perm-feedback', ip + ' added');
  } catch (err) { showFeedback('perm-feedback', err.message, 'var(--red)'); }
});

document.getElementById('perm-ip-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') document.getElementById('btn-perm-add').click();
});

// ── Auto-refresh from SSE global stream ───────────────────────────────────────
function handleSse(e) {
  switch (e.type) {
    case 'ip.blocked':
      if (!tempBlocked.find(b => b.ip === e.ip)) {
        tempBlocked.push({ ip: e.ip, blockedUntil: e.blockedUntil });
        renderTemp();
      }
      break;
    case 'ip.unblocked':
      tempBlocked = tempBlocked.filter(b => b.ip !== e.ip);
      renderTemp();
      break;
    case 'ip.added_permanent':
      if (!permBlocked.includes(e.ip)) { permBlocked.push(e.ip); renderPerm(); }
      break;
    case 'ip.removed_permanent':
      permBlocked = permBlocked.filter(x => x !== e.ip);
      renderPerm();
      break;
  }
}

const es = new EventSource('/tubes/events');
es.onmessage = ev => { try { handleSse(JSON.parse(ev.data)); } catch {} };
es.onopen = () => { const d = document.getElementById('sse-dot'); if (d) d.className = 'sse-dot ok'; };
es.onerror = () => { const d = document.getElementById('sse-dot'); if (d) d.className = 'sse-dot err'; };

// ── Init ──────────────────────────────────────────────────────────────────────
renderTemp();
renderPerm();

document.querySelectorAll('section h2.collapsible-trigger').forEach(h2 => {
  const body = document.getElementById(h2.dataset.collapse);
  if (!body) return;
  if (!body.classList.contains('collapsed')) h2.classList.add('section-open');
  h2.addEventListener('click', () => {
    const collapsed = body.classList.toggle('collapsed');
    h2.classList.toggle('section-open', !collapsed);
  });
});

})();
</script>
</body>
</html>`;
}
