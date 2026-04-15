import { createServer } from 'node:http';
import { createDebug } from '../debug.js';
import { getClientIp } from '../common/http-utils.js';

const debug = createDebug('server:public');

/**
 * Create the public HTTP server that forwards incoming requests to tunnels.
 *
 * @param {object} opts
 * @param {import('./tunnel-manager.js').TunnelManager} opts.manager
 * @param {object} opts.config
 * @returns {import('node:http').Server}
 */
export function createPublicServer({ manager, config }) {
  const server = createServer((req, res) => {
    const tunnelId = extractTunnelId(req.headers.host, config.publicDomain);

    if (!tunnelId) {
      // Root request — redirect to landing page or 200
      if (config.landingUrl) {
        res.writeHead(302, { Location: config.landingUrl, 'X-TT-Source': 'server' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-TT-Source': 'server', 'X-TT-Proto': 'the-tubes/1.0' });
      return res.end('the tubes server');
    }

    let tunnel;
    try {
      tunnel = manager.getTunnel(tunnelId);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json', 'X-TT-Source': 'server', 'X-TT-Proto': 'the-tubes/1.0' });
      return res.end(JSON.stringify({ error: `Tunnel Not Found: ${tunnelId}` }));
    }

    const ip = getClientIp(req, config.trustForwardHeaders);
    debug('[%s] → %s %s (client=%s)', tunnelId, req.method, req.url, ip);

    tunnel.handleRequest(req, res).catch(err => {
      debug('[%s] handleRequest error: %s', tunnelId, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'X-TT-Source': 'server' });
        res.end();
      }
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const tunnelId = extractTunnelId(req.headers.host, config.publicDomain);

    if (!tunnelId) {
      socket.write('HTTP/1.1 404 Not Found\r\nX-TT-Source: server\r\n\r\n');
      socket.end();
      return;
    }

    let tunnel;
    try {
      tunnel = manager.getTunnel(tunnelId);
    } catch {
      socket.write('HTTP/1.1 404 Not Found\r\nX-TT-Source: server\r\n\r\n');
      socket.end();
      return;
    }

    tunnel.handleUpgrade(req, socket, head).catch(err => {
      debug('[%s] handleUpgrade error: %s', tunnelId, err.message);
      socket.destroy();
    });
  });

  return server;
}

/**
 * Extract tunnelId from Host header using the configured public domain.
 * e.g. "bold-raven.tunnel.example.com" → "bold-raven"
 *
 * @param {string|undefined} host
 * @param {string|null} publicDomain
 * @returns {string|null}
 */
function extractTunnelId(host, publicDomain) {
  if (!host) return null;
  const hostname = host.split(':')[0]; // strip port

  if (!publicDomain) {
    // No domain configured — can't route by subdomain
    return null;
  }

  if (!hostname.endsWith(`.${publicDomain}`)) return null;
  const sub = hostname.slice(0, hostname.length - publicDomain.length - 1);
  return sub || null;
}
