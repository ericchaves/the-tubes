/**
 * HTML page generators for /tubes and /tubes/:tunnelId.
 * All CSS and JS are inline — zero external dependencies.
 *
 * XSS safety: all user-controlled values (tunnel IDs, request paths, headers)
 * are inserted via textContent or a DOM-level escapeHtml function. innerHTML
 * is used only with string literals that contain no external data.
 */

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
header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
header h1{font-size:16px;font-weight:600}
header .dim{color:var(--dim);font-size:12px}
.sse-dot{width:8px;height:8px;border-radius:50%;background:var(--gray);margin-left:auto;flex-shrink:0}
.sse-dot.ok{background:var(--green);box-shadow:0 0 6px var(--green)}
.sse-dot.err{background:var(--red)}
main{max-width:1400px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:20px}
section{background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden}
section h2{font-size:11px;font-weight:600;padding:9px 14px;border-bottom:1px solid var(--border);color:var(--dim);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:6px}
section h2.collapsible-trigger{cursor:pointer;user-select:none}
section h2 .toggle{margin-left:auto;color:var(--dim);font-size:10px}
.collapsible{overflow:hidden;transition:max-height .25s ease;max-height:9999px}
.collapsible.collapsed{max-height:0!important}
.kv{display:grid;grid-template-columns:220px 1fr;border-top:1px solid var(--border)}
.kv dt{padding:6px 14px;color:var(--dim);font-size:12px;border-bottom:1px solid var(--border)}
.kv dd{padding:6px 14px;border-bottom:1px solid var(--border)}
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
.t-disconnected,.t-aborted,.t-ws-closed{color:var(--orange)}
.t-expired,.t-destroyed,.t-failed,.t-ws-failed{color:var(--red)}
.t-received{color:var(--gray)}.t-delivered{color:var(--cyan)}.t-ws{color:var(--purple)}
.stats{display:flex;gap:20px;padding:10px 14px;font-size:12px;color:var(--dim);border-bottom:1px solid var(--border);flex-wrap:wrap}
.stats strong{color:var(--text)}
.actions{padding:10px 14px;display:flex;gap:8px;border-bottom:1px solid var(--border)}
button{padding:5px 14px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);cursor:pointer;font-size:13px;font-family:inherit}
button:hover{border-color:var(--blue);color:var(--blue)}
button.danger:hover{border-color:var(--red);color:var(--red)}
.empty{color:var(--dim);padding:20px;text-align:center;font-size:13px}
`;

// All client-side logic is in a single IIFE. No external data is passed via
// template literals — tunnel IDs and event data are handled through safe DOM APIs.
const CLIENT_SHARED_JS = `
function esc(s){const d=document.createElement('span');d.textContent=String(s??'');return d.textContent}
const TYPE_META={
  'tunnel.created':      ['t-created',    'CREATED'],
  'tunnel.connected':    ['t-connected',  'CONNECTED'],
  'tunnel.disconnected': ['t-disconnected','DISCONNECTED'],
  'tunnel.reconnected':  ['t-reconnected','RECONNECTED'],
  'tunnel.window_expired':['t-expired',   'WIN EXPIRED'],
  'tunnel.destroyed':    ['t-destroyed',  'DESTROYED'],
  'request.received':    ['t-received',   'REQ →'],
  'request.waiting':     ['t-received',   'WAITING'],
  'request.delivered':   ['t-delivered',  'DELIVERED'],
  'request.failed':      ['t-failed',     'FAILED'],
  'response.complete':   ['t-complete',   'RESPONSE'],
  'response.aborted':    ['t-aborted',    'ABORTED'],
  'ws.received':         ['t-ws',         'WS →'],
  'ws.delivered':        ['t-ws',         'WS ↑'],
  'ws.failed':           ['t-ws-failed',  'WS ERR'],
  'ws.closed':           ['t-ws-closed',  'WS END'],
  'server.error':        ['t-failed',     'SERVER ERR'],
};
function fmtBytes(n){if(!n)return'0 B';if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}
function fmtTime(ts){const d=new Date(ts);return d.toTimeString().slice(0,8)+'.'+String(d.getMilliseconds()).padStart(3,'0')}
function eventSummary(e){
  // Returns a plain-text summary of the event for display.
  // All values come from server-side data — sanitised via textContent below.
  switch(e.type){
    case'tunnel.created':return'port '+e.port+'  max '+e.maxConnections+' conns  token '+e.sessionTokenPrefix+'…';
    case'tunnel.connected':return e.socketCount+' socket'+(e.socketCount!==1?'s':'')+' in pool';
    case'tunnel.disconnected':return'reconnect window '+e.reconnectWindowMs+'ms';
    case'tunnel.reconnected':return e.socketCount+' socket'+(e.socketCount!==1?'s':'')+' in pool';
    case'tunnel.window_expired':return'no reconnect within window — tunnel closed';
    case'tunnel.destroyed':return'';
    case'request.received':return(e.method||'?')+' '+e.path+'  from '+(e.remoteAddr||'?');
    case'request.waiting':return(e.method||'?')+' '+e.path+'  waiting for socket…';
    case'request.delivered':return(e.method||'?')+' '+e.path+'  pool: '+e.socketPoolRemaining+' remaining';
    case'request.failed':return(e.method||'?')+' '+e.path+'  reason: '+e.reason+'  sent: '+e.statusSent;
    case'response.complete':return(e.method||'?')+' '+e.path+'  '+(e.status||'?')+'  '+e.durationMs+'ms  ↑'+fmtBytes(e.bytesIn)+' ↓'+fmtBytes(e.bytesOut);
    case'response.aborted':return(e.method||'?')+' '+e.path+'  '+(e.status||'?')+'  '+e.reason+'  '+e.durationMs+'ms  ↓'+fmtBytes(e.bytesOut);
    case'ws.received':return e.path+'  from '+(e.remoteAddr||'?');
    case'ws.delivered':return e.path+'  pool: '+e.socketPoolRemaining+' remaining';
    case'ws.failed':return e.path+'  reason: '+e.reason;
    case'ws.closed':return e.path+'  '+e.reason+'  '+e.durationMs+'ms  ↑'+fmtBytes(e.bytesIn)+' ↓'+fmtBytes(e.bytesOut);
    case'server.error':{
      const parts=[];
      if(e.method)parts.push(e.method);
      if(e.host)parts.push(e.host);
      if(e.path&&e.path!=='/')parts.push(e.path);
      if(e.reason)parts.push('reason: '+e.reason);
      if(e.statusSent)parts.push('→ '+e.statusSent);
      if(e.detail)parts.push('('+e.detail+')');
      return parts.join('  ');
    }
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
  const meta = TYPE_META[e.type] || ['','?'];
  const row = document.createElement('div');
  row.className = 'log-row';
  row.style.gridTemplateColumns = showTunnel ? '90px 130px 110px 1fr' : '90px 110px 1fr';
  row.title = JSON.stringify(e, null, 2); // tooltip — browser escapes this automatically

  // Timestamp
  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = fmtTime(e.ts);
  row.appendChild(ts);

  // Tunnel ID link (global log only)
  if (showTunnel) {
    if (e.tunnelId === '__global__') {
      // Server-level event — no per-tunnel page to link to
      const span = document.createElement('span');
      span.className = 'log-detail';
      span.textContent = 'server';
      row.appendChild(span);
    } else {
      const a = document.createElement('a');
      a.href = '/tubes/' + encodeURIComponent(e.tunnelId);
      a.textContent = e.tunnelId; // textContent escapes automatically
      row.appendChild(a);
    }
  }

  // Type badge
  const typeEl = document.createElement('span');
  typeEl.className = 'log-type ' + meta[0];
  typeEl.textContent = meta[1];
  row.appendChild(typeEl);

  // Detail (plain text — textContent is safe)
  const detail = document.createElement('span');
  detail.className = 'log-detail';
  detail.textContent = eventSummary(e);
  row.appendChild(detail);

  return row;
}
function prependRow(container, row, max) {
  container.insertBefore(row, container.firstChild);
  while(container.children.length > (max||300)) container.removeChild(container.lastChild);
}
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
    h2.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      h2.querySelector('.toggle').textContent = collapsed ? '▸' : '▾';
    });
  });
}
`;

/**
 * Generate the HTML for GET /tubes (overview page).
 * The config object is serialised via JSON — keys and values are
 * hardcoded strings from our own config module, not user input.
 *
 * @param {object} filteredConfig - server config with secrets removed
 * @returns {string}
 */
export function adminIndexPage(filteredConfig) {
  // Build config rows using DOM-safe data: config keys/values are always
  // controlled by our own code (not user-supplied at this point).
  const configEntries = JSON.stringify(Object.entries(filteredConfig));

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
  <span class="dim" id="uptime"></span>
  <span class="sse-dot" id="sse-dot"></span>
</header>
<main>
  <section>
    <h2 class="collapsible-trigger" data-collapse="tunnels-wrap">Active tunnels (<span id="tunnel-count">0</span>) <span class="toggle">▾</span></h2>
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
    <h2 class="collapsible-trigger" data-collapse="activity-wrap">Server activity <span class="toggle">▾</span></h2>
    <div id="activity-wrap" class="collapsible">
      <div class="log" id="event-log">
        <div class="empty">Waiting for events…</div>
      </div>
    </div>
  </section>
  <section>
    <h2 class="collapsible-trigger" data-collapse="config-wrap">Server configuration <span class="toggle">▸</span></h2>
    <div id="config-wrap" class="collapsible collapsed">
      <dl class="kv" id="config-kv"></dl>
    </div>
  </section>
</main>
<script>
${CLIENT_SHARED_JS}

// Populate config table using DOM APIs
;(function() {
  const entries = ${configEntries};
  const kv = document.getElementById('config-kv');
  for (const [k, v] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v == null ? '—' : String(v);
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
  tbody.innerHTML = ''; // safe — we rebuild with DOM below
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
      t.port ?? '—',
      (t.socketCount ?? 0) + ' / ' + (t.maxConnections ?? '?'),
      t.created ? new Date(t.created).toLocaleTimeString() : '—',
      t.reqCount ?? 0,
      t.failCount ?? 0,
      t.lastActivity ? new Date(t.lastActivity).toLocaleTimeString() : '—',
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
          status: t.connected ? 'connected' : 'disconnected',
          port: t.port, maxConnections: t.maxConnections,
          socketCount: t.availableConnections,
          created: t.createdAt,
          reqCount: 0, failCount: 0, lastActivity: null,
        });
      }
      renderTunnels();
      return;
    case 'tunnel.created':
      tunnels.set(e.tunnelId, {
        id: e.tunnelId, status: 'connected',
        port: e.port, maxConnections: e.maxConnections,
        socketCount: 0, created: e.ts,
        reqCount: 0, failCount: 0, lastActivity: null,
      });
      renderTunnels();
      break;
    case 'tunnel.connected':
      updateTunnel(e.tunnelId, { status: 'connected', socketCount: e.socketCount });
      break;
    case 'tunnel.disconnected':
      updateTunnel(e.tunnelId, { status: 'disconnected' });
      break;
    case 'tunnel.reconnected':
      updateTunnel(e.tunnelId, { status: 'connected', socketCount: e.socketCount });
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

  // Append to server activity log.
  // Shows: tunnel lifecycle events, delivery failures, and server-level errors.
  // Normal request/response traffic is available on each tunnel's detail page.
  const ADMIN_EVENTS = new Set([
    'tunnel.created','tunnel.connected','tunnel.disconnected',
    'tunnel.reconnected','tunnel.window_expired','tunnel.destroyed',
    'request.failed','response.aborted','ws.failed',
  ]);
  if (e.type === 'server.error' || (e.tunnelId !== '__global__' && ADMIN_EVENTS.has(e.type))) {
    const log = document.getElementById('event-log');
    const placeholder = log.querySelector('.empty');
    if (placeholder) log.removeChild(placeholder);
    prependRow(log, makeLogRow(e, true));
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
 * @returns {string}
 */
export function adminTunnelPage(tunnelId) {
  // Serialised for use in a JS string literal only — never injected raw into HTML.
  const tunnelIdJson = JSON.stringify(tunnelId);
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
  <a href="/tubes">← all tunnels</a>
  <span id="tunnel-title" style="font-weight:700;font-size:16px"></span>
  <span class="badge unknown" id="status-badge">unknown</span>
  <span class="sse-dot" id="sse-dot"></span>
</header>
<main>
  <section>
    <h2 class="collapsible-trigger" data-collapse="status-wrap">Status <span class="toggle">▾</span></h2>
    <div id="status-wrap" class="collapsible">
      <div class="stats">
        <span>Port: <strong id="tunnel-port">—</strong></span>
        <span>Sockets: <strong id="tunnel-sockets">—</strong></span>
        <span>Max: <strong id="tunnel-maxconn">—</strong></span>
        <span>Created: <strong id="tunnel-created">—</strong></span>
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
    <h2 class="collapsible-trigger" data-collapse="eventlog-wrap">Event log (<span id="event-count">0</span> events) <span class="toggle">▾</span></h2>
    <div id="eventlog-wrap" class="collapsible">
      <div class="log" id="event-log">
        <div class="empty">Waiting for events…</div>
      </div>
    </div>
  </section>
</main>
<script>
${CLIENT_SHARED_JS}

const tunnelId = ${tunnelIdJson};
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
        setField('tunnel-port', t.port ?? '—');
        setField('tunnel-sockets', t.availableConnections ?? 0);
        setField('tunnel-maxconn', t.maxConnections ?? '—');
        setField('tunnel-created', t.createdAt ? new Date(t.createdAt).toLocaleTimeString() : '—');
        updateStatus(t.connected ? 'connected' : 'disconnected');
      }
      return;
    }
    case 'tunnel.created':
      setField('tunnel-port', e.port ?? '—');
      setField('tunnel-maxconn', e.maxConnections ?? '—');
      updateStatus('connected');
      break;
    case 'tunnel.connected':
      setField('tunnel-sockets', e.socketCount);
      updateStatus('connected');
      break;
    case 'tunnel.disconnected':
      updateStatus('disconnected');
      break;
    case 'tunnel.reconnected':
      setField('tunnel-sockets', e.socketCount);
      updateStatus('connected');
      break;
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
  const placeholder = log.querySelector('.empty');
  if (placeholder) log.removeChild(placeholder);

  prependRow(log, makeLogRow(e, false));
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
</script>
</body>
</html>`;
}
