/**
 * Client admin HTML page generator.
 *
 * XSS safety: all dynamic values injected via JSON.stringify (configEntries,
 * reconnectLoopMax, hasCaptureDir) are numbers/booleans/safe strings.
 * All event data is handled client-side via textContent — never innerHTML
 * with untrusted data.
 */

// ── Lucide SVG icons (inline, no external deps) ────────────────────────────
function icon(paths, size = 14) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;pointer-events:none">${paths}</svg>`;
}
const ICON = {
  x:       icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  chevron: icon('<path d="m6 9 6 6 6-6"/>'),
  clip:    icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
};

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1117;--surface:#161b27;--surface2:#1e2438;--border:#2a3050;
  --text:#e2e8f0;--dim:#718096;--green:#48bb78;--red:#fc8181;
  --orange:#f6ad55;--blue:#63b3ed;--purple:#b794f4;--cyan:#76e4f7;
  --gray:#a0aec0;--yellow:#faf089;
}
body{background:var(--bg);color:var(--text);font:13px/1.5 'SF Mono',ui-monospace,monospace;min-height:100vh}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:12px;padding:10px 20px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
header h1{font-size:15px;font-weight:600}
.sse-dot{width:8px;height:8px;border-radius:50%;background:var(--gray);margin-left:auto;flex-shrink:0}
.sse-dot.ok{background:var(--green);box-shadow:0 0 6px var(--green)}
.sse-dot.err{background:var(--red)}
.pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;letter-spacing:.04em;margin-left:8px}
.pill.open{color:var(--green);background:#1a2e22}
.pill.closed{color:var(--orange);background:#2e1f0f}
.pill.error{color:var(--red);background:#2e1515}
main{max-width:1100px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:16px}
section{background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden}
section h2{font-size:11px;font-weight:600;padding:8px 14px;border-bottom:1px solid var(--border);color:var(--dim);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:8px}
section h2.collapsible-trigger{cursor:pointer;user-select:none}
section h2 .toggle{color:var(--dim);display:inline-flex;align-items:center;transition:transform .25s ease;transform:rotate(-90deg)}
section h2.section-open .toggle{transform:rotate(0deg)}
.kv{display:grid;grid-template-columns:220px 1fr}
.kv dt{padding:5px 14px;color:var(--dim);font-size:12px;border-bottom:1px solid var(--border)}
.kv dd{padding:5px 14px;border-bottom:1px solid var(--border);word-break:break-all;display:flex;align-items:center;gap:8px}
.kv dt:last-of-type,.kv dd:last-of-type{border-bottom:none}
.collapsible{overflow:hidden;transition:max-height .25s ease;max-height:9999px}
.collapsible.collapsed{max-height:0!important}
.stats-row{display:flex;gap:16px;padding:10px 14px;flex-wrap:wrap;border-bottom:1px solid var(--border)}
.stat{display:flex;flex-direction:column;gap:2px}
.stat-val{font-size:18px;font-weight:700;color:var(--text)}
.stat-lbl{font-size:11px;color:var(--dim)}
.health-bar-wrap{padding:8px 14px 12px}
.health-bar{height:6px;border-radius:3px;background:var(--surface2);overflow:hidden}
.health-fill{height:100%;border-radius:3px;background:var(--green);transition:width .4s ease,background .4s ease}
.health-fill.warn{background:var(--orange)}
.health-fill.danger{background:var(--red)}
.health-label{margin-top:4px;font-size:11px;color:var(--dim)}
.flows-ui{display:flex;flex-direction:column;gap:8px;padding:10px 14px}
.flows-top-row{display:flex;gap:8px;align-items:center}
.flows-listbox{flex:1;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;font:13px 'SF Mono',ui-monospace,monospace;padding:3px 6px;height:28px;outline:none;cursor:pointer}
.flows-listbox option{padding:3px 6px}
.flows-listbox option.invalid{color:var(--red)}
.flows-listbox:focus{border-color:var(--blue)}
.flows-detail{font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flows-actions-row{display:flex;align-items:center;gap:10px}
.btn-run{padding:4px 16px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap}
.btn-run:hover:not(:disabled){border-color:var(--green);color:var(--green)}
.btn-run:disabled{opacity:.4;cursor:not-allowed}
.flow-status{font-size:11px}
.flow-status.ok{color:var(--green)}.flow-status.err{color:var(--red)}.flow-status.running{color:var(--blue)}
.flow-progress{height:4px;border-radius:2px;background:var(--surface2);overflow:hidden;display:none;margin-top:2px}
.flow-progress.active{display:block}
.flow-progress-fill{height:100%;border-radius:2px;background:var(--blue);transition:width .3s ease}
.log-section{display:flex;flex-direction:column}
.log-filters{padding:8px 14px;display:flex;gap:6px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.filter-btn{padding:2px 10px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--dim);cursor:pointer;font-size:11px;font-family:inherit}
.filter-btn.active{border-color:var(--blue);color:var(--blue);background:#0d1f33}
.log{overflow-y:auto;max-height:420px;display:flex;flex-direction:column}
.log-row{display:grid;grid-template-columns:88px 130px 1fr;gap:8px;padding:4px 14px;border-bottom:1px solid #1a1f30;align-items:baseline}
.log-row:hover{background:var(--surface2)}
.log-ts{color:var(--dim);font-size:11px;white-space:nowrap}
.log-type{font-size:11px;font-weight:700;white-space:nowrap}
.log-detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dim)}
.t-expose{color:var(--green)}.t-tunnel{color:var(--blue)}.t-pair{color:var(--cyan)}
.t-request{color:var(--gray)}.t-capture{color:var(--purple)}.t-failure{color:var(--orange)}
.t-reconnect{color:var(--yellow)}.t-replay{color:var(--blue)}.t-error{color:var(--red)}
.t-local{color:var(--orange)}.t-exit{color:var(--red)}
.empty{color:var(--dim);padding:16px;text-align:center;font-size:12px}
/* Section header action buttons */
.section-actions{display:flex;gap:4px;margin-left:auto}
.btn-icon{padding:2px 6px;border-radius:3px;border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer;font-size:12px;font-family:inherit;line-height:1;display:inline-flex;align-items:center}
.btn-icon:hover{border-color:var(--border);color:var(--text)}
.btn-icon.danger:hover{color:var(--red)}
/* Toggle button (capture on/off) */
.btn-toggle{padding:2px 10px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--dim);cursor:pointer;font-size:11px;font-family:inherit}
.btn-toggle.on{border-color:var(--green);color:var(--green);background:#0f2218}
.btn-toggle.off{border-color:var(--orange);color:var(--orange);background:#1f1000}
.btn-toggle:disabled{opacity:.4;cursor:not-allowed}
/* Debug controls */
.debug-controls{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.debug-pattern{background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font:12px 'SF Mono',ui-monospace,monospace;width:200px;outline:none}
.debug-pattern:focus{border-color:var(--blue)}
.debug-log{overflow-y:auto;max-height:300px;display:flex;flex-direction:column}
.debug-row{display:grid;grid-template-columns:88px 140px 1fr;gap:8px;padding:3px 14px;border-bottom:1px solid #1a1f30;align-items:baseline}
.debug-row:hover{background:var(--surface2)}
.debug-ns{font-size:11px;color:var(--purple);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.debug-msg{font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:pre}
`;

function makeClientJs(configEntries, reconnectLoopMax, hasCaptureDir) {
  return `
(function(){
const CONFIG_ENTRIES = ${JSON.stringify(configEntries)};
const RECONNECT_LOOP_MAX = ${JSON.stringify(reconnectLoopMax)};
const HAS_CAPTURE_DIR = ${JSON.stringify(hasCaptureDir)};

// ── State ────────────────────────────────────────────────────────────────────
let state = { status:'closed', publicUrl:null, localAddress:'localhost', localPort:null,
  tunnelId:null, maxConnections:0, startedAt:null,
  totalFailures:0, recentFailures:0, lastReason:null };
let captureEnabled = false;
let debugState = { enabled: false, pattern: 'tt:*' };
let flows = [];
let replayRunning = false;
let startedAt = null;
let uptimeTimer = null;
let filterActive = 'all';
const MAX_ROWS = 300;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const sseDot        = document.getElementById('sse-dot');
const statusPill    = document.getElementById('status-pill');
const publicUrlEl   = document.getElementById('pub-url');
const localEl       = document.getElementById('local-addr');
const tunnelIdEl    = document.getElementById('tunnel-id');
const uptimeEl      = document.getElementById('uptime');
const maxConnEl     = document.getElementById('max-conn');
const totalFailEl   = document.getElementById('total-fail');
const recentFailEl  = document.getElementById('recent-fail');
const lastReasonEl  = document.getElementById('last-reason');
const healthFill    = document.getElementById('health-fill');
const healthLabel   = document.getElementById('health-label');
const flowsSelect   = document.getElementById('flows-select');
const flowsDetail   = document.getElementById('flows-detail');
const btnRunFlow    = document.getElementById('btn-run-flow');
const flowStatus    = document.getElementById('flow-run-status');
const flowProgress  = document.getElementById('flow-progress-bar');
const flowFill      = document.getElementById('flow-progress-fill');
const logEl         = document.getElementById('log');
const logCountEl    = document.getElementById('log-count');
const debugLogEl    = document.getElementById('debug-log');
const captureBtnEl  = document.getElementById('btn-capture-toggle');
const captureStatEl = document.getElementById('capture-status');

// ── Type metadata ────────────────────────────────────────────────────────────
const TYPE_META = {
  'expose.started':      ['t-expose',   'STARTED'],
  'tunnel.open':         ['t-tunnel',   'TUNNEL OPEN'],
  'tunnel.closed':       ['t-tunnel',   'TUNNEL CLOSED'],
  'control.connected':   ['t-tunnel',   'CTRL UP'],
  'control.resumed':     ['t-tunnel',   'CTRL RESUME'],
  'control.disconnected':['t-failure',  'CTRL DOWN'],
  'pair.open':           ['t-pair',     'PAIR OPEN'],
  'pair.dead':           ['t-pair',     'PAIR DEAD'],
  'local.down':          ['t-local',    'LOCAL DOWN'],
  'local.up':            ['t-local',    'LOCAL UP'],
  'request':             ['t-request',  'REQUEST'],
  'capture.saved':       ['t-capture',  'CAPTURE'],
  'capture.toggled':     ['t-capture',  'CAPTURE'],
  'failure.recorded':    ['t-failure',  'FAILURE'],
  'reconnect.scheduled': ['t-reconnect','RECONNECT'],
  'expose.exit':         ['t-exit',     'EXIT'],
  'replay.started':      ['t-replay',   'REPLAY START'],
  'replay.step':         ['t-replay',   'REPLAY STEP'],
  'replay.step.error':   ['t-error',    'STEP ERROR'],
  'replay.completed':    ['t-replay',   'REPLAY DONE'],
  'replay.error':        ['t-error',    'REPLAY ERR'],
  'auth.rejected':       ['t-error',    'AUTH REJECTED'],
  'tunnel.token_missing':['t-failure',  'TOKEN MISSING'],
};

const EVENT_GROUPS = {
  'expose.started':'expose','tunnel.open':'tunnel','tunnel.closed':'tunnel',
  'control.connected':'tunnel','control.resumed':'tunnel','control.disconnected':'tunnel',
  'pair.open':'pairs','pair.dead':'pairs',
  'local.down':'local','local.up':'local',
  'request':'requests','capture.saved':'requests','capture.toggled':'requests',
  'failure.recorded':'health','reconnect.scheduled':'health',
  'expose.exit':'expose',
  'replay.started':'replay','replay.step':'replay','replay.step.error':'replay',
  'replay.completed':'replay','replay.error':'replay',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function setText(el, val){ if(el) el.textContent = val ?? '—'; }
function fmtUptime(ms){
  const s = Math.floor(ms/1000);
  if(s < 60) return s+'s';
  if(s < 3600) return Math.floor(s/60)+'m '+(s%60)+'s';
  return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
}
function fmtTs(iso){ return iso ? iso.slice(11,19) : ''; }

function eventSummary(ev){
  switch(ev.type){
    case 'expose.started':    return ev.publicUrl ?? '';
    case 'tunnel.open':       return (ev.publicUrl??'') + (ev.maxConnections ? ' max='+ev.maxConnections : '');
    case 'tunnel.closed':     return ev.reason ?? '';
    case 'control.connected': return 'controlId='+(ev.controlId??'').slice(0,8)+'…';
    case 'control.resumed':   return (ev.controlId??'').slice(0,8)+'… replaces '+(ev.previousControlId??'').slice(0,8)+'… keep='+(ev.keptPairs??0)+' drop='+(ev.droppedPairs??0);
    case 'control.disconnected': return ev.reason ?? '';
    case 'pair.open':         return (ev.pairId??'')+(ev.requestId?' req '+ev.requestId.slice(0,6):'');
    case 'pair.dead':         return (ev.pairId??'')+' '+(ev.reason??'')+(ev.retriable?' [retry]':' [final]');
    case 'local.down':        return (ev.address??'')+(ev.port?':'+ev.port:'');
    case 'local.up':          return (ev.address??'')+(ev.port?':'+ev.port:'');
    case 'request':           return (ev.method??'')+' '+(ev.path??'')+(ev.status?' → '+ev.status:'');
    case 'capture.saved':     return (ev.method??'')+' '+(ev.path??'')+' → '+(ev.file??'');
    case 'capture.toggled':   return ev.enabled ? 'enabled' : 'disabled';
    case 'failure.recorded':  return 'kind='+ev.kind+' total='+ev.totalFailures+' recent='+ev.recentFailures;
    case 'reconnect.scheduled': return 'in '+ev.delayMs+'ms';
    case 'expose.exit':       return 'code='+ev.code+' '+(ev.reason??'');
    case 'replay.started':    return (ev.manifest??'')+' ('+ev.steps+' steps → '+(ev.target??'')+')';
    case 'replay.step':       return '['+(ev.stepIndex+1)+'/'+ev.total+'] '+ev.method+' '+ev.url+' → '+ev.status+' ('+ev.durationMs+'ms)';
    case 'replay.step.error': return '['+(ev.stepIndex+1)+'/'+ev.total+'] '+ev.method+' '+ev.url+': '+ev.error;
    case 'replay.completed':  return (ev.manifest??'')+' done in '+ev.durationMs+'ms';
    case 'replay.error':      return (ev.manifest??'')+': '+ev.error;
    case 'auth.rejected':     return 'code='+(ev.code??'?')+' '+(ev.reason??'');
    case 'tunnel.token_missing': return 'server requires authentication (check --hmac-secret or server config)';
    default: return JSON.stringify(ev).slice(0,80);
  }
}

// ── Log rendering ─────────────────────────────────────────────────────────────
function makeLogRow(ev){
  const [cls, label] = TYPE_META[ev.type] ?? ['t-request', ev.type];
  const group = EVENT_GROUPS[ev.type] ?? 'other';
  const row = document.createElement('div');
  row.className = 'log-row';
  row.dataset.group = group;
  if(filterActive !== 'all' && filterActive !== group) row.style.display = 'none';

  const ts = document.createElement('span');
  ts.className = 'log-ts'; ts.textContent = fmtTs(ev.ts);
  const type = document.createElement('span');
  type.className = 'log-type '+cls; type.textContent = label;
  const detail = document.createElement('span');
  detail.className = 'log-detail'; detail.textContent = eventSummary(ev);

  row.appendChild(ts); row.appendChild(type); row.appendChild(detail);
  return row;
}

function appendLogRow(ev){
  if(logEl.children.length === 1 && logEl.firstElementChild?.classList.contains('empty')){
    logEl.removeChild(logEl.firstChild);
  }
  const row = makeLogRow(ev);
  logEl.appendChild(row);
  while(logEl.children.length > MAX_ROWS) logEl.removeChild(logEl.firstChild);
  const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  if(wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
  updateLogCount();
}

function clearLogDom(){
  while(logEl.firstChild) logEl.removeChild(logEl.firstChild);
  const ph = document.createElement('div');
  ph.className = 'empty'; ph.textContent = 'No events yet';
  logEl.appendChild(ph);
  filterActive = 'all';
  document.querySelectorAll('.filter-btn[data-filter]').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === 'all');
  });
  updateLogCount();
}

function updateLogCount(){
  const total = logEl.children.length;
  const visible = Array.from(logEl.children).filter(r => r.style.display !== 'none').length;
  setText(logCountEl, filterActive === 'all' ? total+' events' : visible+'/'+total+' events');
}

// ── Debug log rendering ───────────────────────────────────────────────────────
function appendDebugRow(entry){
  if(!debugLogEl) return;
  if(debugLogEl.children.length === 1 && debugLogEl.firstElementChild?.classList.contains('empty')){
    debugLogEl.removeChild(debugLogEl.firstChild);
  }
  const row = document.createElement('div');
  row.className = 'debug-row';

  const ts = document.createElement('span');
  ts.className = 'log-ts'; ts.textContent = fmtTs(entry.ts);

  const ns = document.createElement('span');
  ns.className = 'debug-ns'; ns.textContent = entry.ns;

  const msg = document.createElement('span');
  msg.className = 'debug-msg'; msg.textContent = entry.msg;

  row.appendChild(ts); row.appendChild(ns); row.appendChild(msg);
  debugLogEl.appendChild(row);
  const wasAtBottom = debugLogEl.scrollHeight - debugLogEl.scrollTop - debugLogEl.clientHeight < 60;
  if(wasAtBottom) debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

function clearDebugDom(){
  if(!debugLogEl) return;
  while(debugLogEl.firstChild) debugLogEl.removeChild(debugLogEl.firstChild);
  const ph = document.createElement('div');
  ph.className = 'empty'; ph.textContent = 'No debug entries';
  debugLogEl.appendChild(ph);
}

// ── Capture toggle ────────────────────────────────────────────────────────────
function applyCaptureState(enabled){
  captureEnabled = enabled;
  if(captureBtnEl){
    captureBtnEl.textContent = enabled ? 'ON' : 'OFF';
    captureBtnEl.className = 'btn-toggle '+(enabled ? 'on' : 'off');
  }
  if(captureStatEl) captureStatEl.textContent = enabled ? 'on' : 'off';
}

function toggleCapture(){
  const next = !captureEnabled;
  fetch('/tubes/capture', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ enabled: next }),
  }).catch(() => {});
}

// ── Debug controls ────────────────────────────────────────────────────────────
function applyDebugState(d){
  if(!d) return;
  debugState = { enabled: d.enabled, pattern: d.pattern ?? 'tt:*' };
  const cb = document.getElementById('debug-enabled');
  const pi = document.getElementById('debug-pattern');
  if(cb) cb.checked = debugState.enabled;
  if(pi) pi.value   = debugState.pattern;
}

function setDebugLevel(){
  const cb = document.getElementById('debug-enabled');
  const pi = document.getElementById('debug-pattern');
  const enabled = cb ? cb.checked : debugState.enabled;
  const pattern = pi ? pi.value.trim() || 'tt:*' : debugState.pattern;
  fetch('/tubes/debug', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ enabled, pattern }),
  }).catch(() => {});
}

// ── Copy helpers ──────────────────────────────────────────────────────────────
function copyEvents(){
  const lines = Array.from(logEl.querySelectorAll('.log-row')).map(row => {
    const parts = Array.from(row.children).map(c => c.textContent.trim());
    return parts.join('  ');
  });
  navigator.clipboard?.writeText(lines.join('\\n')).catch(() => {});
}

function copyDebug(){
  if(!debugLogEl) return;
  const lines = Array.from(debugLogEl.querySelectorAll('.debug-row')).map(row => {
    const parts = Array.from(row.children).map(c => c.textContent.trim());
    return parts.join('  ');
  });
  navigator.clipboard?.writeText(lines.join('\\n')).catch(() => {});
}

// ── State rendering ───────────────────────────────────────────────────────────
function renderStatus(){
  const s = state;
  const isOpen = s.status === 'open';
  statusPill.textContent = s.status;
  statusPill.className = 'pill '+(isOpen ? 'open' : s.status === 'error' ? 'error' : 'closed');
  if(s.publicUrl){
    publicUrlEl.textContent = s.publicUrl;
    publicUrlEl.href = s.publicUrl;
  } else {
    publicUrlEl.textContent = '—';
    publicUrlEl.removeAttribute('href');
  }
  setText(localEl, s.localAddress && s.localPort
    ? (s.localTls?'https://':'http://')+s.localAddress+':'+s.localPort : null);
  setText(tunnelIdEl, s.tunnelId);
  setText(maxConnEl, s.maxConnections || null);
}

function renderHealth(){
  const total = state.totalFailures ?? 0;
  const recent = state.recentFailures ?? 0;
  setText(totalFailEl, total);
  setText(recentFailEl, recent);
  setText(lastReasonEl, state.lastReason);
  const pct = RECONNECT_LOOP_MAX > 0 ? Math.min(100, Math.round(recent/RECONNECT_LOOP_MAX*100)) : 0;
  healthFill.style.width = pct+'%';
  healthFill.className = 'health-fill'+(pct > 75 ? ' danger' : pct > 40 ? ' warn' : '');
  healthLabel.textContent = recent+' / '+RECONNECT_LOOP_MAX+' failures in window';
}

// ── Flows listbox ─────────────────────────────────────────────────────────────
function renderFlows(){
  while(flowsSelect.firstChild) flowsSelect.removeChild(flowsSelect.firstChild);
  if(!flows.length){
    const opt = document.createElement('option');
    opt.textContent = '(no flows found)'; opt.disabled = true;
    flowsSelect.appendChild(opt);
    updateFlowDetail(null);
    return;
  }
  for(const flow of flows){
    const opt = document.createElement('option');
    opt.value = flow.name;
    opt.textContent = flow.valid ? flow.name + '  (' + flow.steps + ' steps)' : flow.name + '  ⚠ invalid';
    if(!flow.valid){ opt.disabled = true; opt.className = 'invalid'; }
    flowsSelect.appendChild(opt);
  }
  const firstValid = flows.find(f => f.valid);
  if(firstValid) flowsSelect.value = firstValid.name;
  updateFlowDetail(flowsSelect.value || null);
}

function updateFlowDetail(name){
  while(flowsDetail.firstChild) flowsDetail.removeChild(flowsDetail.firstChild);
  if(!name){
    const span = document.createElement('span'); span.textContent = 'Select a flow to run';
    flowsDetail.appendChild(span); btnRunFlow.disabled = true; return;
  }
  const flow = flows.find(f => f.name === name);
  if(!flow){ btnRunFlow.disabled = true; return; }
  if(!flow.valid){
    const err = document.createElement('span'); err.style.color = 'var(--red)';
    err.textContent = flow.error ?? 'invalid manifest'; flowsDetail.appendChild(err);
    btnRunFlow.disabled = true; return;
  }
  const meta = document.createElement('span');
  meta.textContent = flow.steps+' steps'+(flow.target ? '  →  '+flow.target : '');
  flowsDetail.appendChild(meta);
  btnRunFlow.disabled = replayRunning;
}

flowsSelect.addEventListener('change', () => { updateFlowDetail(flowsSelect.value || null); });
btnRunFlow.addEventListener('click', () => {
  const name = flowsSelect.value;
  if(name && !replayRunning) triggerReplay(name);
});

// ── Replay state ──────────────────────────────────────────────────────────────
function setFlowRunning(){
  replayRunning = true; btnRunFlow.disabled = true; flowsSelect.disabled = true;
  if(flowProgress) flowProgress.classList.add('active');
  if(flowFill) flowFill.style.width = '0%';
  if(flowStatus){ flowStatus.className = 'flow-status running'; flowStatus.textContent = 'running…'; }
}
function setFlowDone(ok, msg){
  replayRunning = false; btnRunFlow.disabled = false; flowsSelect.disabled = false;
  if(flowFill) flowFill.style.width = '100%';
  setTimeout(() => { if(flowProgress) flowProgress.classList.remove('active'); if(flowFill) flowFill.style.width = '0%'; }, 1500);
  if(flowStatus){ flowStatus.className = 'flow-status '+(ok ? 'ok' : 'err'); flowStatus.textContent = msg ?? (ok ? 'done' : 'error'); setTimeout(() => { flowStatus.textContent = ''; }, 5000); }
}
function updateFlowStep(stepIndex, total){
  if(flowFill && total > 0) flowFill.style.width = Math.round((stepIndex+1)/total*100)+'%';
}

// ── Replay trigger ────────────────────────────────────────────────────────────
function triggerReplay(name){
  if(replayRunning) return; setFlowRunning();
  fetch('/tubes/replay', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ manifest: name }) })
    .then(res => { if(!res.ok) return res.json().then(b => { throw new Error(b.error || res.statusText); }); })
    .catch(err => {
      replayRunning = false; btnRunFlow.disabled = false; flowsSelect.disabled = false;
      if(flowProgress) flowProgress.classList.remove('active');
      if(flowStatus){ flowStatus.className = 'flow-status err'; flowStatus.textContent = err.message; setTimeout(()=>{ flowStatus.textContent=''; },5000); }
    });
}

// ── Event handler ─────────────────────────────────────────────────────────────
function handleEvent(ev){
  switch(ev.type){
    case '__init__':
      if(ev.state) applyState(ev.state);
      if(ev.flows){ flows = ev.flows; renderFlows(); }
      return;
    case 'expose.started':
      state.status = 'open'; state.publicUrl = ev.serverUrl ?? null;
      state.localAddress = ev.localAddress ?? state.localAddress;
      state.localPort = ev.localPort ?? state.localPort;
      startedAt = ev.ts ? new Date(ev.ts) : new Date();
      startUptimeTicker(); renderStatus(); break;
    case 'tunnel.open':
      state.status = 'open'; state.publicUrl = ev.publicUrl ?? state.publicUrl;
      state.tunnelId = ev.tunnelId ?? state.tunnelId;
      state.maxConnections = ev.maxConnections ?? state.maxConnections;
      renderStatus(); break;
    case 'tunnel.closed':
      state.status = 'closed'; renderStatus(); break;
    case 'failure.recorded':
      state.totalFailures = ev.totalFailures ?? state.totalFailures;
      state.recentFailures = ev.recentFailures ?? state.recentFailures;
      state.lastReason = ev.kind ?? state.lastReason;
      renderHealth(); break;
    case 'expose.exit':
      state.status = 'closed'; renderStatus(); break;
    case 'replay.started': setFlowRunning(); break;
    case 'replay.step': updateFlowStep(ev.stepIndex ?? 0, ev.total ?? 1); break;
    case 'replay.completed': setFlowDone(true, 'done in '+ev.durationMs+'ms'); break;
    case 'replay.error': setFlowDone(false, ev.error ?? 'error'); break;
    case 'capture.toggled': applyCaptureState(ev.enabled); break;
    case 'events.cleared': clearLogDom(); return;
  }
  appendLogRow(ev);
}

function applyState(s){
  if(s.status) state.status = s.status;
  if(s.publicUrl) state.publicUrl = s.publicUrl;
  if(s.localAddress) state.localAddress = s.localAddress;
  if(s.localPort) state.localPort = s.localPort;
  if(s.tunnelId) state.tunnelId = s.tunnelId;
  if(s.maxConnections) state.maxConnections = s.maxConnections;
  if(s.totalFailures != null) state.totalFailures = s.totalFailures;
  if(s.recentFailures != null) state.recentFailures = s.recentFailures;
  if(s.lastReason) state.lastReason = s.lastReason;
  if(s.startedAt){ startedAt = new Date(s.startedAt); startUptimeTicker(); }
  if(s.captureEnabled != null) applyCaptureState(s.captureEnabled);
  if(s.debug) applyDebugState(s.debug);
  renderStatus(); renderHealth();
}

// ── Uptime ticker ─────────────────────────────────────────────────────────────
function startUptimeTicker(){
  if(uptimeTimer) return;
  uptimeTimer = setInterval(() => {
    if(startedAt) setText(uptimeEl, fmtUptime(Date.now() - startedAt.getTime()));
  }, 1000);
}

// ── Filters ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    filterActive = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    for(const row of logEl.children){
      row.style.display = (filterActive === 'all' || row.dataset.group === filterActive) ? '' : 'none';
    }
    updateLogCount();
  });
});

// ── Collapsible sections ──────────────────────────────────────────────────────
document.querySelectorAll('section h2.collapsible-trigger').forEach(h2 => {
  const body = document.getElementById(h2.dataset.collapse);
  if(!body) return;
  if(!body.classList.contains('collapsed')) h2.classList.add('section-open');
  h2.addEventListener('click', (ev) => {
    if(ev.target.closest('.section-actions')) return;
    const collapsed = body.classList.toggle('collapsed');
    h2.classList.toggle('section-open', !collapsed);
  });
});

// ── Config table ──────────────────────────────────────────────────────────────
(function renderConfig(){
  const dl = document.getElementById('config-kv');
  if(!dl) return;
  for(const [k,v] of CONFIG_ENTRIES){
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  }
})();

// ── Events SSE ────────────────────────────────────────────────────────────────
(function connectSse(){
  let es;
  function connect(){
    es = new EventSource('/tubes/events');
    es.onopen = () => { sseDot.className = 'sse-dot ok'; };
    es.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch {} };
    es.onerror = () => { sseDot.className = 'sse-dot err'; es.close(); setTimeout(connect, 3000); };
  }
  connect();
})();

// ── Debug SSE ─────────────────────────────────────────────────────────────────
(function connectDebugSse(){
  let es;
  function connect(){
    es = new EventSource('/tubes/debug/events');
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if(ev.type === 'debug.state' || ev.type === 'debug.changed') {
          applyDebugState({ enabled: ev.enabled, pattern: ev.pattern });
          if(ev.type === 'debug.changed') appendDebugRow({ ts: ev.ts, ns: 'debug', msg: (ev.enabled ? 'enabled' : 'disabled') + ' pattern=' + ev.pattern });
        } else if(ev.type === 'debug.log') appendDebugRow(ev);
        else if(ev.type === 'debug.cleared') clearDebugDom();
      } catch {}
    };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  connect();
})();

// ── Activity section buttons ──────────────────────────────────────────────────
;(function(){
  const btnClear = document.getElementById('btn-clear-events');
  if(btnClear) btnClear.addEventListener('click', ev => {
    ev.stopPropagation();
    fetch('/tubes/events/clear', { method:'POST' }).catch(() => {});
  });

  const btnCopy = document.getElementById('btn-copy-events');
  if(btnCopy) btnCopy.addEventListener('click', ev => { ev.stopPropagation(); copyEvents(); });
})();

// ── Debug section buttons ─────────────────────────────────────────────────────
;(function(){
  const btnClear = document.getElementById('btn-clear-debug');
  if(btnClear) btnClear.addEventListener('click', ev => {
    ev.stopPropagation();
    fetch('/tubes/debug/clear', { method:'POST' }).catch(() => {});
  });

  const btnCopy = document.getElementById('btn-copy-debug');
  if(btnCopy) btnCopy.addEventListener('click', ev => { ev.stopPropagation(); copyDebug(); });
})();

// ── Capture toggle button ─────────────────────────────────────────────────────
if(captureBtnEl) captureBtnEl.addEventListener('click', ev => { ev.stopPropagation(); toggleCapture(); });

// ── Debug controls ────────────────────────────────────────────────────────────
;(function(){
  const cb = document.getElementById('debug-enabled');
  const pi = document.getElementById('debug-pattern');
  if(cb) cb.addEventListener('change', setDebugLevel);
  if(pi){ pi.addEventListener('change', setDebugLevel); pi.addEventListener('keydown', e => { if(e.key==='Enter') setDebugLevel(); }); }
})();

// ── Initial render ────────────────────────────────────────────────────────────
renderStatus();
renderHealth();
renderFlows();

})();
`;
}

/**
 * Generate the full admin HTML page.
 * @param {object} opts
 * @param {object} opts.filteredConfig - expose config with secrets removed
 * @returns {string} HTML
 */
export function adminPage({ filteredConfig }) {
  const SKIP_KEYS = new Set(['sessionToken', 'hmacSecret', 'sessionTokenFile', 'adminPort', 'adminAddress', 'flowsDir']);
  const configEntries = Object.entries(filteredConfig ?? {})
    .filter(([k]) => !SKIP_KEYS.has(k))
    .map(([k, v]) => [k, v == null ? 'null' : String(v)]);

  const reconnectLoopMax = filteredConfig?.reconnectLoopMax ?? 10;
  const hasCaptureDir = !!(filteredConfig?.captureDir);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>tt expose — admin</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>tt expose</h1>
  <span id="status-pill" class="pill closed">closed</span>
  <span style="color:var(--dim);font-size:11px;margin-left:4px">uptime: <span id="uptime">—</span></span>
  <span id="sse-dot" class="sse-dot" title="SSE connection"></span>
</header>
<main>

  <!-- Tunnel info -->
  <section>
    <h2 class="collapsible-trigger section-open" data-collapse="tunnel-body">Tunnel <span class="toggle">${ICON.chevron}</span></h2>
    <div id="tunnel-body" class="collapsible">
      <dl class="kv">
        <dt>Public URL</dt>
        <dd><a id="pub-url" href="#" target="_blank">—</a></dd>
        <dt>Local</dt>
        <dd id="local-addr">—</dd>
        <dt>Tunnel ID</dt>
        <dd id="tunnel-id">—</dd>
        <dt>Max connections</dt>
        <dd id="max-conn">—</dd>
        <dt>Capture</dt>
        <dd>
          <span id="capture-status">${hasCaptureDir ? 'on' : 'not configured'}</span>
          ${hasCaptureDir
            ? `<button id="btn-capture-toggle" class="btn-toggle on" title="Toggle capture">ON</button>`
            : `<span style="color:var(--dim);font-size:11px"> (--capture-dir not set)</span>`}
        </dd>
      </dl>
    </div>
  </section>

  <!-- Health (collapsed) -->
  <section>
    <h2 class="collapsible-trigger" data-collapse="health-body">Health <span class="toggle">${ICON.chevron}</span></h2>
    <div id="health-body" class="collapsible collapsed">
      <div class="stats-row">
        <div class="stat"><span class="stat-val" id="total-fail">0</span><span class="stat-lbl">total failures</span></div>
        <div class="stat"><span class="stat-val" id="recent-fail">0</span><span class="stat-lbl">recent failures</span></div>
        <div class="stat"><span class="stat-val" id="last-reason">—</span><span class="stat-lbl">last failure kind</span></div>
      </div>
      <div class="health-bar-wrap">
        <div class="health-bar"><div id="health-fill" class="health-fill" style="width:0%"></div></div>
        <div id="health-label" class="health-label">0 / ${reconnectLoopMax} failures in window</div>
      </div>
    </div>
  </section>

  <!-- Flows (collapsed) -->
  <section>
    <h2 class="collapsible-trigger" data-collapse="flows-body">Flows <span class="toggle">${ICON.chevron}</span></h2>
    <div id="flows-body" class="collapsible collapsed">
      <div class="flows-ui">
        <div class="flows-top-row">
          <select id="flows-select" class="flows-listbox"></select>
          <button id="btn-run-flow" class="btn-run" disabled>Run</button>
          <span id="flow-run-status" class="flow-status"></span>
        </div>
        <div id="flows-detail" class="flows-detail"></div>
        <div id="flow-progress-bar" class="flow-progress">
          <div id="flow-progress-fill" class="flow-progress-fill" style="width:0%"></div>
        </div>
      </div>
    </div>
  </section>

  <!-- Activity log -->
  <section class="log-section">
    <h2 class="collapsible-trigger section-open" data-collapse="activity-body">
      Activity
      <span id="log-count" style="font-weight:400;color:var(--dim);font-size:11px;margin-left:4px"></span>
      <span class="section-actions">
        <button class="btn-icon" id="btn-copy-events" title="Copy events">${ICON.clip}</button>
        <button class="btn-icon danger" id="btn-clear-events" title="Clear events">${ICON.x}</button>
      </span>
      <span class="toggle" style="margin-left:4px">${ICON.chevron}</span>
    </h2>
    <div id="activity-body" class="collapsible">
      <div class="log-filters">
        <button class="filter-btn active" data-filter="all">all</button>
        <button class="filter-btn" data-filter="expose">expose</button>
        <button class="filter-btn" data-filter="tunnel">tunnel</button>
        <button class="filter-btn" data-filter="pairs">pairs</button>
        <button class="filter-btn" data-filter="requests">requests</button>
        <button class="filter-btn" data-filter="health">health</button>
        <button class="filter-btn" data-filter="local">local</button>
        <button class="filter-btn" data-filter="replay">replay</button>
      </div>
      <div id="log" class="log">
        <div class="empty">No events yet</div>
      </div>
    </div>
  </section>

  <!-- Debug (collapsed by default) -->
  <section>
    <h2 class="collapsible-trigger" data-collapse="debug-body">
      Debug
      <span class="section-actions">
        <button class="btn-icon" id="btn-copy-debug" title="Copy debug log">${ICON.clip}</button>
        <button class="btn-icon danger" id="btn-clear-debug" title="Clear debug log">${ICON.x}</button>
      </span>
      <span class="toggle" style="margin-left:4px">${ICON.chevron}</span>
    </h2>
    <div id="debug-body" class="collapsible collapsed">
      <div class="debug-controls">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="debug-enabled"> Enable
        </label>
        <input type="text" id="debug-pattern" class="debug-pattern" value="tt:*" placeholder="tt:*" title="Namespace pattern (e.g. tt:*, tt:client:*)">
      </div>
      <div id="debug-log" class="debug-log">
        <div class="empty">No debug entries</div>
      </div>
    </div>
  </section>

  <!-- Config (collapsed) -->
  <section>
    <h2 class="collapsible-trigger" data-collapse="config-body">Config <span class="toggle">${ICON.chevron}</span></h2>
    <div id="config-body" class="collapsible collapsed">
      <dl id="config-kv" class="kv"></dl>
    </div>
  </section>

</main>
<script>${makeClientJs(configEntries, reconnectLoopMax, hasCaptureDir)}</script>
</body>
</html>`;
}
