import { createServer } from 'node:http';
import { handleAdminRequest } from './router.js';
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
export function createApiServer({ manager, hmacVerify, config, startedAt, globalLog }) {
  const services = { manager, hmacVerify, startedAt, serverConfig: config, globalLog };

  const server = createServer((req, res) => {
    debug('%s %s', req.method, req.url);
    handleAdminRequest(req, res, services);
  });

  return server;
}
