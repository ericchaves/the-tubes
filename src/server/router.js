/**
 * Minimal HTTP router for the admin/API server.
 * Routes: POST /api/tunnels, POST /api/tunnels/:id, GET /api/status,
 *         GET /api/tunnels/:id, GET /healthz, GET /tubes/*, POST /tubes/*,
 *         GET/POST/DELETE /api/blocklist/*, POST /api/admin/rotate-token,
 *         POST /api/admin/set-token
 */

import { handleAdminRoute } from './admin/router.js';
import { isAdminAuthorized } from './admin/auth.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {import('node:http').IncomingMessage} Req
 * @typedef {import('node:http').ServerResponse} Res
 */

/**
 * @param {Req} req
 * @param {Res} res
 * @param {object} services - { manager, hmacVerify, startedAt, serverConfig, globalLog, rateLimiter, blocklist }
 */
export function handleAdminRequest(req, res, services) {
  const { manager, hmacVerify, startedAt, globalLog, rateLimiter, blocklist } = services;
  const config = services.serverConfig;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // ── /healthz — always public (load balancer probe) ───────────────────────

  if (method === 'GET' && path === '/healthz') {
    return sendJson(res, 200, {
      status: 'ok',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      tunnels: manager.tunnelCount,
    });
  }

  // ── Admin dashboard routes (auth-guarded) ────────────────────────────────

  if (path === '/tubes' || path.startsWith('/tubes/')) {
    if (!isAdminAuthorized(req, config)) return sendUnauthorized(res);
    return handleAdminRoute(req, res, services);
  }

  // ── Authenticated API routes ──────────────────────────────────────────────

  if (!path.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Not Found' });
  }

  // ── GET /api/status — auth required ──────────────────────────────────────

  if (method === 'GET' && path === '/api/status') {
    if (!isAdminAuthorized(req, config)) return sendUnauthorized(res);
    return sendJson(res, 200, {
      protocol: 'the-tubes/1.0',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      tunnels: manager.getStatus(),
    });
  }

  // ── GET /api/tunnels/:id — auth required ──────────────────────────────────

  const tunnelIdMatch = path.match(/^\/api\/tunnels\/([^/]+)$/);

  if (method === 'GET' && tunnelIdMatch) {
    if (!isAdminAuthorized(req, config)) return sendUnauthorized(res);
    const tunnelId = tunnelIdMatch[1];
    try {
      const tunnel = manager.getTunnel(tunnelId);
      return sendJson(res, 200, {
        protocol: 'the-tubes/1.0',
        tunnelId: tunnel.tunnelId,
        connected: tunnel.connected,
        tunnelPort: tunnel.port,
        publicUrl: manager.buildPublicUrl(tunnel.tunnelId),
        maxConnections: tunnel.maxConnections,
        reconnectWindowMs: tunnel.reconnectWindowMs,
        createdAt: tunnel.createdAt,
      });
    } catch (err) {
      if (err.code === 'TUNNEL_NOT_FOUND') return sendJson(res, 404, { error: err.message });
      return sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  // ── Blocklist routes (auth required) ─────────────────────────────────────

  if (path.startsWith('/api/blocklist/')) {
    if (!isAdminAuthorized(req, config)) return sendUnauthorized(res);
    return handleBlocklistRequest(req, res, path, method, rateLimiter, blocklist);
  }

  // ── Token rotation (auth required) ────────────────────────────────────────

  if (method === 'POST' && path === '/api/admin/rotate-token') {
    if (!isAdminAuthorized(req, config)) return sendUnauthorized(res);
    return handleRotateToken(req, res, config, globalLog);
  }

  // ── Token set to specific value (auth required) ───────────────────────────

  if (method === 'POST' && path === '/api/admin/set-token') {
    if (!isAdminAuthorized(req, config)) return sendUnauthorized(res);
    return readBody(req).then(body => handleSetToken(body, res, config, globalLog));
  }

  // ── Tunnel creation — authenticated ───────────────────────────────────────

  const isCreate =
    (method === 'POST' && path === '/api/tunnels') ||
    (method === 'POST' && path.startsWith('/api/tunnels/'));

  if (!isCreate) {
    return sendJson(res, 404, { error: 'Not Found' });
  }

  // Read body (may be empty for POST)
  readBody(req).then(body => {
    // Session token is required
    const sessionToken = req.headers['x-tt-session-token'];
    if (!sessionToken) {
      globalLog?.push('server.error', {
        reason: 'auth_rejected',
        method,
        path,
        statusSent: 400,
        detail: 'Missing X-TT-Session-Token header',
      });
      return sendJson(res, 400, { error: 'Missing X-TT-Session-Token header' });
    }
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(sessionToken)) {
      globalLog?.push('server.error', {
        reason: 'auth_rejected',
        method,
        path,
        statusSent: 400,
        detail: 'Invalid X-TT-Session-Token format',
      });
      return sendJson(res, 400, { error: 'Invalid X-TT-Session-Token format' });
    }

    // HMAC verification (if configured)
    if (hmacVerify) {
      const result = hmacVerify(req, body);
      if (!result.valid) {
        globalLog?.push('server.error', {
          reason: 'auth_rejected',
          method,
          path,
          statusSent: 401,
          detail: `Authentication failed: ${result.reason}`,
        });
        return sendJson(res, 401, { error: `Authentication failed: ${result.reason}` });
      }
    }

    // Extract requested subdomain if provided
    const subdirMatch = path.match(/^\/api\/tunnels\/([^/]+)$/);
    const requestedSubdomain = subdirMatch ? subdirMatch[1] : null;

    manager.createTunnel({ sessionToken, requestedSubdomain })
      .then(tunnel => {
        sendJson(res, 200, {
          protocol: 'the-tubes/1.0',
          tunnelId: tunnel.tunnelId,
          tunnelHost: _extractHost(config),
          tunnelPort: tunnel.port,
          publicUrl: manager.buildPublicUrl(tunnel.tunnelId),
          maxConnections: tunnel.maxConnections,
          reconnectWindowMs: tunnel.reconnectWindowMs,
          createdAt: tunnel.createdAt,
        });
      })
      .catch(err => {
        if (err.code === 'TUNNEL_CONFLICT') {
          return sendJson(res, 409, {
            error: err.message,
            retryAfter: err.retryAfter,
          });
        }
        if (err.code === 'NO_PORTS_AVAILABLE') {
          return sendJson(res, 503, { error: err.message });
        }
        if (err.status >= 400 && err.status < 500) {
          return sendJson(res, err.status, { error: err.message });
        }
        globalLog?.push('server.error', {
          reason: 'internal_error',
          method,
          path,
          statusSent: 500,
          detail: err.message,
        });
        return sendJson(res, 500, { error: 'Internal server error' });
      });
  }).catch(() => {
    globalLog?.push('server.error', {
      reason: 'bad_request',
      method,
      path,
      statusSent: 400,
      detail: 'Cannot read request body',
    });
    sendJson(res, 400, { error: 'Cannot read request body' });
  });
}

// ── Blocklist handler ─────────────────────────────────────────────────────────

function handleBlocklistRequest(req, res, path, method, rateLimiter, blocklist) {
  // GET /api/blocklist/temp — list temporarily blocked IPs
  if (method === 'GET' && path === '/api/blocklist/temp') {
    return sendJson(res, 200, { blocked: rateLimiter?.listBlocked() ?? [] });
  }

  // DELETE /api/blocklist/temp/:ip — unblock a temporarily blocked IP
  const tempIpMatch = path.match(/^\/api\/blocklist\/temp\/(.+)$/);
  if (method === 'DELETE' && tempIpMatch) {
    const ip = decodeURIComponent(tempIpMatch[1]);
    const removed = rateLimiter?.unblock(ip) ?? false;
    return sendJson(res, 200, { ok: removed, ip });
  }

  // GET /api/blocklist/permanent — list permanently blocked IPs
  if (method === 'GET' && path === '/api/blocklist/permanent') {
    return sendJson(res, 200, { blocked: blocklist?.listPermanent() ?? [] });
  }

  // POST /api/blocklist/permanent — add IP to permanent blocklist
  if (method === 'POST' && path === '/api/blocklist/permanent') {
    return readBody(req).then(body => {
      let ip;
      try { ip = JSON.parse(body || '{}').ip; } catch {
        return sendJson(res, 400, { error: 'Invalid JSON body' });
      }
      if (!ip || typeof ip !== 'string') {
        return sendJson(res, 400, { error: '"ip" field is required' });
      }
      const added = blocklist?.addPermanent(ip) ?? false;
      return sendJson(res, 200, { ok: added, ip });
    }).catch(() => sendJson(res, 400, { error: 'Cannot read request body' }));
  }

  // DELETE /api/blocklist/permanent/:ip — remove IP from permanent blocklist
  const permIpMatch = path.match(/^\/api\/blocklist\/permanent\/(.+)$/);
  if (method === 'DELETE' && permIpMatch) {
    const ip = decodeURIComponent(permIpMatch[1]);
    const removed = blocklist?.removePermanent(ip) ?? false;
    return sendJson(res, 200, { ok: removed, ip });
  }

  return sendJson(res, 404, { error: 'Not Found' });
}

// ── Token rotation handler ────────────────────────────────────────────────────

function handleRotateToken(req, res, config, globalLog) {
  const newToken = randomBytes(32).toString('hex');
  return applyNewToken(newToken, res, config, globalLog);
}

function handleSetToken(body, res, config, globalLog) {
  let token;
  try { token = JSON.parse(body).token; } catch {}
  if (typeof token !== 'string' || token.length < 8) {
    return sendJson(res, 400, { error: 'Token must be at least 8 characters' });
  }
  if (!/^[A-Za-z0-9_\-]+$/.test(token)) {
    return sendJson(res, 400, { error: 'Token may only contain alphanumeric characters, hyphens, and underscores' });
  }
  return applyNewToken(token, res, config, globalLog);
}

function applyNewToken(newToken, res, config, globalLog) {
  const oldPrefix = config.adminToken?.slice(0, 8) ?? '(none)';
  config.adminToken = newToken;

  // Persist to file if dataDir is configured
  if (config.dataDir) {
    try {
      const content = `# the-tubes admin token — keep this file private\n${newToken}\n`;
      writeFileSync(join(config.dataDir, 'admin-token'), content, 'utf8');
    } catch {}
  }

  globalLog?.push('server.token_rotated', { tokenPrefix: newToken.slice(0, 8) });

  return sendJson(res, 200, {
    ok: true,
    token: newToken,
    rotatedFrom: oldPrefix + '…',
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'X-TT-Proto': 'the-tubes/1.0',
  });
  res.end(json);
}

function sendUnauthorized(res) {
  const json = JSON.stringify({ error: 'Unauthorized' });
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'WWW-Authenticate': 'Basic realm="tt-admin"',
    'X-TT-Proto': 'the-tubes/1.0',
  });
  res.end(json);
}

export function readBody(req, maxBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function _extractHost(cfg) {
  if (!cfg) return 'localhost';
  return cfg.publicDomain || 'localhost';
}
