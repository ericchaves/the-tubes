/**
 * Minimal HTTP router for the admin/API server.
 * Routes: POST /api/tunnels, POST /api/tunnels/:id, GET /api/status,
 *         GET /api/tunnels/:id, GET /healthz, GET /admin/*, POST /admin/*
 */

import { handleAdminRoute } from './admin/router.js';

/**
 * @typedef {import('node:http').IncomingMessage} Req
 * @typedef {import('node:http').ServerResponse} Res
 */

/**
 * @param {Req} req
 * @param {Res} res
 * @param {object} services - { manager, hmacVerify, startedAt, serverConfig, globalLog }
 */
export function handleAdminRequest(req, res, services) {
  const { manager, hmacVerify, startedAt, globalLog } = services;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // ── Admin dashboard routes ────────────────────────────────────────────────

  if (path === '/admin' || path.startsWith('/admin/')) {
    return handleAdminRoute(req, res, services);
  }

  // ── Public health/status routes (no auth) ────────────────────────────────

  if (method === 'GET' && path === '/healthz') {
    return sendJson(res, 200, {
      status: 'ok',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      tunnels: manager.tunnelCount,
    });
  }

  if (method === 'GET' && path === '/api/status') {
    return sendJson(res, 200, {
      protocol: 'the-tubes/1.0',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      tunnels: manager.getStatus(),
    });
  }

  const tunnelIdMatch = path.match(/^\/api\/tunnels\/([^/]+)$/);

  if (method === 'GET' && tunnelIdMatch) {
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

  // ── Authenticated tunnel creation routes ──────────────────────────────────

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
          tunnelHost: _extractHost(services.serverConfig),
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
        if (err.status === 403) {
          return sendJson(res, 403, { error: err.message });
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

function readBody(req, maxBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
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
