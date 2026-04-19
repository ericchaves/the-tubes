import { createDebug } from '../debug.js';
import { computeAcceptKey } from '../common/ws-framing.js';
import { ControlSession } from './control-session.js';

const debug = createDebug('server:control-upgrade');

/**
 * Handle an HTTP upgrade for `/api/tunnels/:id/control`.
 *
 * Authentication mirrors POST /api/tunnels:
 *   - X-TT-Session-Token header required; must match the tunnel's session.
 *   - If HMAC is enabled, X-TT-Auth must validate against GET <path>.
 *
 * On success, responds with 101 Switching Protocols and attaches a ControlSession
 * to the tunnel. On failure, writes a plain HTTP error and closes the socket.
 *
 * @param {object} opts
 * @param {import('node:http').IncomingMessage} opts.req
 * @param {import('node:net').Socket} opts.socket
 * @param {import('./tunnel-manager.js').TunnelManager} opts.manager
 * @param {object} opts.config
 * @param {Function|null} [opts.hmacVerify] - middleware built by createHmacMiddleware
 * @param {import('./admin/event-log.js').GlobalEventLog} [opts.globalLog]
 * @returns {boolean} true if the request was a control upgrade (handled or rejected)
 */
export function tryHandleControlUpgrade({ req, socket, manager, config, hmacVerify, globalLog }) {
  const m = req.url?.match(/^\/api\/tunnels\/([^/]+)\/control(?:\?|$|#)/);
  if (!m) return false;

  const tunnelId = m[1];
  const wsKey = req.headers['sec-websocket-key'];
  const wsVersion = req.headers['sec-websocket-version'];
  const upgrade = (req.headers['upgrade'] || '').toLowerCase();

  if (upgrade !== 'websocket' || !wsKey || wsVersion !== '13') {
    _deny(socket, 400, 'Bad control upgrade');
    return true;
  }

  const sessionToken = req.headers['x-tt-session-token'];
  if (!sessionToken || !/^[a-zA-Z0-9_-]{1,256}$/.test(sessionToken)) {
    _deny(socket, 401, 'Missing or invalid session token');
    return true;
  }

  if (hmacVerify) {
    const result = hmacVerify(req, '');
    if (!result.valid) {
      globalLog?.push('server.error', {
        reason: 'auth_rejected', method: 'CONTROL', path: req.url,
        statusSent: 401, detail: `HMAC failed: ${result.reason}`,
      });
      _deny(socket, 401, 'HMAC verification failed');
      return true;
    }
  }

  const tunnel = manager.getTunnelSafe(tunnelId);
  if (!tunnel) {
    _deny(socket, 404, 'Tunnel not found');
    return true;
  }
  if (tunnel.sessionToken !== sessionToken) {
    _deny(socket, 403, 'Session token mismatch');
    return true;
  }

  // Send the 101 response
  const accept = computeAcceptKey(wsKey);
  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    'X-TT-Proto: the-tubes/1.0',
    '\r\n',
  ].join('\r\n');
  socket.write(response);

  debug('[%s] control upgrade accepted from %s', tunnelId, socket.remoteAddress);
  const session = new ControlSession(socket);
  tunnel.attachControlSession(session);
  return true;
}

function _deny(socket, status, reason) {
  const msg = [
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'X-TT-Proto: the-tubes/1.0',
    '\r\n',
  ].join('\r\n');
  try { socket.write(msg); } catch {}
  try { socket.destroy(); } catch {}
}
