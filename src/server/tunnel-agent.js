import { createServer } from 'node:net';
import { createDebug } from '../debug.js';
import {
  DATA_PREAMBLE_PREFIX, DATA_PREAMBLE_MAX_BYTES, parsePreamble,
} from '../common/control-protocol.js';

const debug = createDebug('server:agent');

/**
 * TunnelAgent owns the TCP listener that accepts on-demand data sockets from
 * the tt client. Every incoming socket is expected to start with a plain-text
 * preamble (`TT/1 PAIR <pairId>\r\n`) identifying which pending pair it
 * belongs to — there is no pool of idle sockets.
 *
 * Flow per external request:
 *   1. ServerTunnel calls reservePair(pairId, timeoutMs) → gets a Promise
 *   2. Sends pair.open on the control channel
 *   3. Client connects here and writes the preamble
 *   4. parsePreamble matches the pairId to the pending reservation → socket
 *      is handed to the request handler (without the preamble bytes)
 *
 * If no preamble is received within PREAMBLE_TIMEOUT_MS, or the pairId is
 * unknown, the socket is destroyed.
 */
const PREAMBLE_TIMEOUT_MS = 10_000;

export class TunnelAgent {
  /**
   * @param {object} opts
   * @param {string} opts.tunnelId
   * @param {number} opts.maxConnections - concurrency cap (not pool size)
   */
  constructor({ tunnelId, maxConnections = 10 }) {
    this.tunnelId = tunnelId;
    this.maxConnections = maxConnections;
    /** Map<pairId, { resolve, reject, timer, controlId }> */
    this._pending = new Map();
    /** Map<pairId, { socket, controlId }> that are active (handed out to a request) */
    this._active = new Map();
    this._tcpServer = null;
    this._assignedPort = null;
    this._destroyed = false;
    /** @type {(info: {pairId, replacesControlId, socket}) => void | null} */
    this._onReplacement = null;
  }

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this._tcpServer = createServer(socket => this._onSocket(socket));
      this._tcpServer.on('error', reject);
      this._tcpServer.listen(port, '0.0.0.0', () => {
        const addr = this._tcpServer.address();
        this._assignedPort = addr.port;
        debug('[%s] data listener on port %d', this.tunnelId, this._assignedPort);
        resolve(this._assignedPort);
      });
    });
  }

  /**
   * Reserve a slot for a pairId the server is about to ask the client to open.
   * @param {string} pairId
   * @param {number} timeoutMs
   * @returns {Promise<import('node:net').Socket>}
   */
  reservePair(pairId, timeoutMs) {
    if (this._destroyed) return Promise.reject(new Error('TunnelAgent destroyed'));
    if (this._pending.has(pairId) || this._active.has(pairId)) {
      return Promise.reject(new Error(`pairId ${pairId} already in use`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(pairId);
        reject(Object.assign(new Error('Timeout waiting for data socket'), { code: 'ESOCKETTIMEOUT' }));
      }, timeoutMs);
      timer.unref();
      this._pending.set(pairId, { resolve, reject, timer });
    });
  }

  /**
   * Register a callback for replacement sockets (preamble with `REPLACES <controlId>`).
   * ServerTunnel sets this to swap the data socket on an in-flight WS pair.
   */
  onReplacement(fn) { this._onReplacement = fn; }

  /** Mark a pair as active (after it has been handed to a handler). */
  markActive(pairId, socket) {
    this._active.set(pairId, socket);
    socket.once('close', () => this._active.delete(pairId));
  }

  /** Cancel a pending reservation (e.g. client reported pair.failed). */
  cancelPair(pairId, reason) {
    const pending = this._pending.get(pairId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pending.delete(pairId);
      pending.reject(Object.assign(new Error(reason || 'pair cancelled'), { code: 'EPAIRCANCELLED' }));
    }
    const active = this._active.get(pairId);
    if (active) {
      try { active.destroy(); } catch {}
      this._active.delete(pairId);
    }
  }

  _onSocket(socket) {
    if (this._destroyed) { socket.destroy(); return; }
    debug('[%s] data socket from %s:%d', this.tunnelId, socket.remoteAddress, socket.remotePort);
    socket.setKeepAlive(true);

    let buf = Buffer.alloc(0);
    let handled = false;
    const timeout = setTimeout(() => {
      if (!handled) { debug('[%s] preamble timeout', this.tunnelId); socket.destroy(); }
    }, PREAMBLE_TIMEOUT_MS);
    timeout.unref();

    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf('\n');
      if (nl === -1) {
        if (buf.length > DATA_PREAMBLE_MAX_BYTES) {
          debug('[%s] preamble too long', this.tunnelId);
          socket.destroy();
        }
        return;
      }
      const lineEnd = buf[nl - 1] === 0x0D ? nl - 1 : nl;
      const line = buf.slice(0, lineEnd).toString('utf8');
      const rest = buf.slice(nl + 1);
      socket.removeListener('data', onData);
      clearTimeout(timeout);
      handled = true;

      const parsed = parsePreamble(line);
      if (!parsed) {
        debug('[%s] bad preamble: %s', this.tunnelId, line);
        socket.destroy();
        return;
      }
      if (parsed.replacesControlId) {
        if (this._onReplacement) {
          this._onReplacement({ pairId: parsed.pairId, replacesControlId: parsed.replacesControlId, socket, residual: rest });
        } else {
          socket.destroy();
        }
        return;
      }
      const pending = this._pending.get(parsed.pairId);
      if (!pending) {
        debug('[%s] unknown pairId in preamble: %s', this.tunnelId, parsed.pairId);
        socket.destroy();
        return;
      }
      this._pending.delete(parsed.pairId);
      clearTimeout(pending.timer);
      // Re-emit any leftover bytes (unusual — clients shouldn't send body before server writes request)
      if (rest.length > 0) socket.unshift(rest);
      pending.resolve(socket);
    };
    socket.on('data', onData);
    socket.once('error', () => { try { socket.destroy(); } catch {} });
  }

  get port() { return this._assignedPort; }
  get activeCount() { return this._active.size; }
  get pendingCount() { return this._pending.size; }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('TunnelAgent destroyed'));
    }
    this._pending.clear();
    for (const s of this._active.values()) { try { s.destroy(); } catch {} }
    this._active.clear();
    if (this._tcpServer) { this._tcpServer.close(); this._tcpServer = null; }
  }

  /** Static helper retained for compatibility with error paths. */
  static send429(socket, info = {}) {
    const headers = [
      'HTTP/1.1 429 Too Many Connections',
      'Content-Type: application/json',
      `X-TT-Max-Connections: ${info.max ?? ''}`,
      'X-TT-Source: server',
      'X-TT-Proto: the-tubes/1.0',
      'Connection: close',
    ];
    const body = JSON.stringify({ error: 'Too many connections', ...info });
    headers.push(`Content-Length: ${Buffer.byteLength(body)}`);
    socket.write(headers.join('\r\n') + '\r\n\r\n' + body);
    socket.end();
  }
}
