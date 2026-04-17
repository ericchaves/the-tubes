import { styleText } from 'node:util';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TunnelManager } from './tunnel-manager.js';
import { createApiServer } from './api-server.js';
import { createHmacMiddleware } from './hmac-middleware.js';
import { handleAdminRequest } from './router.js';
import { GlobalEventLog } from './admin/event-log.js';
import { RateLimiter } from './rate-limiter.js';
import { BlocklistManager } from './blocklist.js';
import { getClientIp } from '../common/http-utils.js';
import { createDebug } from '../debug.js';

const debug = createDebug('server');

/**
 * Run the tunnel server.
 * @param {object} config - from buildServeConfig()
 */
export async function runServe(config) {
  const startedAt = Date.now();

  // ── Data directory & admin token ──────────────────────────────────────────
  mkdirSync(config.dataDir, { recursive: true });

  if (!config.adminToken) {
    const tokenFile = join(config.dataDir, 'admin-token');
    if (existsSync(tokenFile)) {
      const raw = readFileSync(tokenFile, 'utf8');
      config.adminToken = raw.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? '';
      debug('admin token loaded from %s', tokenFile);
    } else {
      config.adminToken = randomBytes(32).toString('hex');
      const content = `# the-tubes admin token — keep this file private\n${config.adminToken}\n`;
      writeFileSync(tokenFile, content, 'utf8');
      console.log(styleText('yellow', `  admin token (auto-generated): ${config.adminToken}`));
      console.log(styleText('yellow', `  saved to: ${tokenFile}`));
    }
  }

  // ── Core services ─────────────────────────────────────────────────────────
  const globalLog = new GlobalEventLog();
  const manager = new TunnelManager(config, globalLog);

  const rateLimiter = new RateLimiter({
    windowMs: config.rateLimitWindowMs,
    maxHits: config.rateLimitMaxHits,
    blockDurationMs: config.rateLimitBlockDurationMs,
    globalLog,
  });

  const blocklist = new BlocklistManager({
    dataDir: config.dataDir,
    globalLog,
  });

  let hmacVerify = null;
  if (config.hmacSecret) {
    hmacVerify = createHmacMiddleware({
      secret: config.hmacSecret,
      clockSkewS: config.hmacClockSkewToleranceS,
      nonceCacheTtlS: config.hmacNonceCacheTtlS,
    });
    debug('HMAC authentication enabled');
  }

  const adminServices = { manager, hmacVerify, startedAt, serverConfig: config, globalLog, rateLimiter, blocklist };

  // ── Public server ──────────────────────────────────────────────────────────
  // Handles: tunnel traffic (by subdomain) + admin API (if no separate apiPort)

  const publicServer = createServer((req, res) => {
    const tunnelId = extractTunnelId(req.headers.host, config.publicDomain);

    // Route to admin only when there is no tunnel subdomain
    if (!tunnelId) {
      if (config.apiPort && req.url !== '/healthz') {
        // Separate API port configured — reject admin requests on public port
        // (/healthz is always allowed so load balancers can probe the primary port)
        res.writeHead(404, { 'X-TT-Source': 'server', 'X-TT-Proto': 'the-tubes/1.0' });
        return res.end(JSON.stringify({ error: 'Not Found' }));
      }
      return handleAdminRequest(req, res, adminServices);
    }

    const ip = getClientIp(req, config.trustForwardHeaders);

    // Permanent blocklist — fast reject before any tunnel lookup
    if (blocklist.isPermanentlyBlocked(ip)) {
      blocklist.emitRequestBlocked(ip, { method: req.method, host: req.headers.host });
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-TT-Source': 'server' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }

    let tunnel;
    try {
      tunnel = manager.getTunnel(tunnelId);
    } catch {
      // Rate-limit tunnel_not_found probes
      if (rateLimiter.hit(ip, { method: req.method, host: req.headers.host })) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil(config.rateLimitBlockDurationMs / 1000)),
          'X-TT-Source': 'server',
        });
        return res.end(JSON.stringify({ error: 'Too Many Requests' }));
      }
      globalLog.push('server.error', {
        reason: 'tunnel_not_found',
        method: req.method,
        path: req.url,
        host: req.headers.host,
        clientIp: ip,
        statusSent: 404,
      });
      res.writeHead(404, {
        'Content-Type': 'application/json',
        'X-TT-Source': 'server',
        'X-TT-Proto': 'the-tubes/1.0',
      });
      return res.end(JSON.stringify({ error: 'Tunnel Not Found' }));
    }

    if (config.landingUrl && req.url === '/') {
      res.writeHead(302, { Location: config.landingUrl, 'X-TT-Source': 'server' });
      return res.end();
    }

    debug('[%s] → %s %s (client=%s)', tunnelId, req.method, req.url, ip);

    tunnel.handleRequest(req, res).catch(err => {
      debug('[%s] handleRequest error: %s', tunnelId, err.message);
      globalLog.push('server.error', {
        reason: 'internal_error',
        method: req.method,
        path: req.url,
        host: req.headers.host,
        statusSent: 500,
        detail: err.message,
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'X-TT-Source': 'server' });
        res.end();
      }
    });
  });

  publicServer.on('upgrade', (req, socket, head) => {
    const tunnelId = extractTunnelId(req.headers.host, config.publicDomain);
    if (!tunnelId) {
      socket.write('HTTP/1.1 404 Not Found\r\nX-TT-Source: server\r\n\r\n');
      return socket.end();
    }

    const ip = getClientIp(req, config.trustForwardHeaders);

    // Permanent blocklist
    if (blocklist.isPermanentlyBlocked(ip)) {
      blocklist.emitRequestBlocked(ip, { method: 'WS', host: req.headers.host });
      socket.write('HTTP/1.1 403 Forbidden\r\nX-TT-Source: server\r\n\r\n');
      return socket.end();
    }

    let tunnel;
    try {
      tunnel = manager.getTunnel(tunnelId);
    } catch {
      if (rateLimiter.hit(ip, { method: 'WS', host: req.headers.host })) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nX-TT-Source: server\r\n\r\n');
        return socket.end();
      }
      globalLog.push('server.error', {
        reason: 'tunnel_not_found',
        method: 'WS',
        path: req.url,
        host: req.headers.host,
        clientIp: ip,
        statusSent: 404,
      });
      socket.write('HTTP/1.1 404 Not Found\r\nX-TT-Source: server\r\n\r\n');
      return socket.end();
    }
    tunnel.handleUpgrade(req, socket, head).catch(err => {
      debug('[%s] handleUpgrade error: %s', tunnelId, err.message);
      globalLog.push('server.error', {
        reason: 'internal_error',
        method: 'WS',
        path: req.url,
        host: req.headers.host,
        statusSent: 500,
        detail: err.message,
      });
      socket.destroy();
    });
  });

  await listenServer(publicServer, config.publicPort, config.publicAddress);

  // ── Optional separate API server ──────────────────────────────────────────

  let apiServer = null;
  if (config.apiPort && config.apiPort !== config.publicPort) {
    apiServer = createApiServer({ manager, hmacVerify, config, startedAt, globalLog });
    await listenServer(apiServer, config.apiPort, config.apiAddress);
  }

  // ── Logging ───────────────────────────────────────────────────────────────

  console.log(styleText('green', `the tubes serve started`));
  console.log(`  public:  http://${config.publicAddress}:${config.publicPort}`);
  if (apiServer) {
    console.log(`  api:     http://${config.apiAddress}:${config.apiPort}`);
  } else {
    console.log(`  api:     http://${config.publicAddress}:${config.publicPort} (shared)`);
  }
  if (config.publicDomain) console.log(`  domain:  *.${config.publicDomain}`);
  if (config.hmacSecret) console.log(styleText('yellow', '  hmac:    enabled'));
  console.log(styleText('cyan', `  admin:   token=${config.adminToken.slice(0, 8)}… (use X-TT-Admin-Token header)`));
  if (config.tunnelPortStart != null) {
    console.log(`  ports:   ${config.tunnelPortStart}–${config.tunnelPortEnd}`);
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  const shutdown = () => {
    console.log('\nShutting down...');
    manager.destroyAll();
    if (hmacVerify?.destroy) hmacVerify.destroy();
    rateLimiter.destroy();
    publicServer.close();
    if (apiServer) apiServer.close();
    setTimeout(() => process.exit(0), 500);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// ─────────────────────────────────────────────────────────────────────────────

function listenServer(server, port, address) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, resolve);
  });
}

function extractTunnelId(host, publicDomain) {
  if (!host || !publicDomain) return null;
  // IPv6 literal host header (e.g. [::1]:3000) — never has a wildcard subdomain
  if (host.startsWith('[')) return null;
  const hostname = host.split(':')[0];
  if (!hostname.endsWith(`.${publicDomain}`)) return null;
  const sub = hostname.slice(0, hostname.length - publicDomain.length - 1);
  return sub || null;
}

function isAdminPath(url) {
  return url && (
    url.startsWith('/api/') ||
    url === '/api' ||
    url === '/healthz' ||
    url === '/tubes' ||
    url.startsWith('/tubes/')
  );
}
