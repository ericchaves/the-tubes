import { adminIndexPage, adminTunnelPage, adminBlocklistPage } from './pages.js';
import { createDebug } from '../../debug.js';

const debug = createDebug('server:admin');

/** Config keys that must never appear in the filtered config object sent to the frontend */
const SENSITIVE_KEYS = new Set(['hmacSecret', 'hmacSecretFile', 'adminToken']);

function filterConfig(config) {
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (!SENSITIVE_KEYS.has(k) && v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Handle requests rooted at /admin.
 *
 * Routes:
 *   GET  /tubes                    → overview HTML page
 *   GET  /tubes/events             → SSE — global event stream (server.state first)
 *   GET  /tubes/:tunnelId          → per-tunnel HTML page
 *   GET  /tubes/:tunnelId/events   → SSE — per-tunnel event stream (history first)
 *   POST /tubes/:tunnelId/disconnect → destroy the tunnel
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} services
 * @param {import('../tunnel-manager.js').TunnelManager} services.manager
 * @param {import('./event-log.js').GlobalEventLog}       services.globalLog
 * @param {number}  services.startedAt  — epoch ms
 * @param {object}  services.serverConfig
 * @param {import('../../debug.js').debugManager}         services.debugManager
 */
export function handleAdminRoute(req, res, services) {
  const { manager, globalLog, startedAt, serverConfig, debugManager } = services;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // ── GET /tubes ──────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/tubes') {
    const html = adminIndexPage(filterConfig(serverConfig), serverConfig.adminToken);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // ── GET /tubes/blocklist ────────────────────────────────────────────────────
  if (method === 'GET' && path === '/tubes/blocklist') {
    const { rateLimiter, blocklist } = services;
    const html = adminBlocklistPage({
      tempBlocked: rateLimiter?.listBlocked() ?? [],
      permBlocked: blocklist?.listPermanent() ?? [],
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // ── GET /tubes/events ───────────────────────────────────────────────────────
  if (method === 'GET' && path === '/tubes/events') {
    startSse(res);
    sseWrite(res, {
      type: 'server.state',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      config: filterConfig(serverConfig),
      tunnels: manager.getStatus(),
      debug: debugManager?.state,
    });
    globalLog.addSseClient(res);
    debug('global SSE client connected');
    return;
  }

  // ── GET /tubes/debug/events — debug SSE ─────────────────────────────────────
  if (method === 'GET' && path === '/tubes/debug/events') {
    startSse(res);
    debugManager?.addSseClient(res);
    debug('debug SSE client connected');
    return;
  }

  // ── POST /tubes/debug — set debug level ────────────────────────────────────
  if (method === 'POST' && path === '/tubes/debug') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      const enabled = !!parsed.enabled;
      const pattern = typeof parsed.pattern === 'string' ? parsed.pattern : 'tt:*';
      debugManager?.setLevel(enabled, pattern);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, enabled, pattern }));
    });
    return;
  }

  // ── POST /tubes/events/clear — clear global event ring buffer ───────────────
  if (method === 'POST' && path === '/tubes/events/clear') {
    globalLog.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── POST /tubes/debug/clear — clear debug ring buffer ───────────────────────
  if (method === 'POST' && path === '/tubes/debug/clear') {
    debugManager?.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── Routes with :tunnelId ───────────────────────────────────────────────────
  const tunnelIdMatch = path.match(/^\/tubes\/([^/]+?)(?:\/(events(?:\/clear)?|disconnect))?$/);
  if (!tunnelIdMatch) {
    return send404(res);
  }

  const tunnelId = tunnelIdMatch[1];
  const action = tunnelIdMatch[2]; // 'events' | 'disconnect' | undefined

  // POST /tubes/:tunnelId/events/clear
  if (method === 'POST' && action === 'events/clear') {
    const eventLog = manager.getEventLog(tunnelId);
    if (!eventLog) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Tunnel not found' }));
    }
    eventLog.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, tunnelId }));
  }

  // GET /tubes/:tunnelId/events
  if (method === 'GET' && action === 'events') {
    startSse(res);
    const eventLog = manager.getEventLog(tunnelId);
    if (!eventLog) {
      sseWrite(res, { type: 'tunnel.not_found', tunnelId });
      return res.end();
    }
    // addSseClient sends the full ring-buffer history, then subscribes to live events
    eventLog.addSseClient(res);
    debug('[%s] per-tunnel SSE client connected', tunnelId);
    return;
  }

  // POST /tubes/:tunnelId/disconnect
  if (method === 'POST' && action === 'disconnect') {
    const tunnel = manager.getTunnelSafe(tunnelId);
    if (!tunnel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Tunnel not found' }));
    }
    tunnel.destroy();
    debug('[%s] disconnected via admin', tunnelId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, tunnelId }));
  }

  // GET /tubes/:tunnelId
  if (method === 'GET' && !action) {
    const html = adminTunnelPage(tunnelId, serverConfig.adminToken);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  send404(res);
}

// ─────────────────────────────────────────────────────────────────────────────

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  });
}

function sseWrite(res, event) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
}

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}
