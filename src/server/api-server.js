import { createServer } from 'node:http';
import { handleAdminRequest } from './router.js';
import { tryHandleControlUpgrade } from './control-upgrade.js';
import { createDebug } from '../debug.js';

const debug = createDebug('server:api');

/**
 * Create the API/admin HTTP server (tunnel creation, status, health).
 *
 * @param {object} opts
 * @param {import('./tunnel-manager.js').TunnelManager} opts.manager
 * @param {Function|null} opts.hmacVerify
 * @param {object} opts.config
 * @param {number} opts.startedAt
 * @returns {import('node:http').Server}
 */
export function createApiServer({ manager, hmacVerify, config, startedAt, globalLog, debugManager, rateLimiter, blocklist }) {
  const services = { manager, hmacVerify, startedAt, serverConfig: config, globalLog, debugManager, rateLimiter, blocklist };

  const server = createServer((req, res) => {
    debug('%s %s', req.method, req.url);
    handleAdminRequest(req, res, services);
  });

  server.on('upgrade', (req, socket, head) => {
    if (tryHandleControlUpgrade({ req, socket, manager, config, hmacVerify, globalLog })) return;
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  return server;
}
