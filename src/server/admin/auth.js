/**
 * Admin authentication helper.
 *
 * Checks whether an incoming request carries a valid admin token.
 * The token can be supplied via:
 *   - Header:  X-TT-Admin-Token: <token>
 *   - Header:  Authorization: Bearer <token>
 *
 * If no adminToken is configured in config, access is allowed only from
 * loopback addresses (127.0.0.1, ::1) — suitable for local development
 * where the server is not exposed to the internet.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object} config  Server config (must have .adminToken and .trustForwardHeaders)
 * @returns {boolean}
 */

import { getClientIp } from '../../common/http-utils.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isAdminAuthorized(req, config) {
  const { adminToken, trustForwardHeaders } = config;

  if (!adminToken) {
    // No token configured — allow only loopback connections
    const ip = getClientIp(req, trustForwardHeaders);
    return LOOPBACK.has(ip);
  }

  // Check X-TT-Admin-Token header first
  const headerToken = req.headers['x-tt-admin-token'];
  if (headerToken) return headerToken === adminToken;

  const authHeader = req.headers['authorization'];

  // Authorization: Bearer <token>
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7) === adminToken;
  }

  // Authorization: Basic <base64(user:token)> — browser-friendly
  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx !== -1) {
      return decoded.slice(colonIdx + 1) === adminToken;
    }
  }

  return false;
}
