import { Agent } from 'node:http';
import { createServer } from 'node:net';
import { createDebug } from '../debug.js';
import { TooManyConnectionsError } from '../common/errors.js';

const debug = createDebug('server:agent');

const RECONNECT_WINDOW_HEADER = 'x-tt-reconnect-window-ms';

/**
 * TunnelAgent manages a pool of raw TCP sockets from the expose process.
 * It extends http.Agent so Node's http.request() can use it as an agent —
 * each time a new connection is needed for forwarding, it pulls one from the pool.
 */
export class TunnelAgent extends Agent {
  /**
   * @param {object} opts
   * @param {string} opts.tunnelId
   * @param {number} opts.maxConnections
   */
  constructor({ tunnelId, maxConnections = 10 }) {
    super({ keepAlive: true, maxSockets: maxConnections });
    this.tunnelId = tunnelId;
    this.maxConnections = maxConnections;
    /** @type {import('node:net').Socket[]} */
    this._availableSockets = [];
    this._waiters = [];
    this._destroyed = false;
    this._tcpServer = null;
    this._assignedPort = null;
    this._connectedCount = 0;
  }

  /**
   * Start a TCP server on the given port (or random) to accept tunnel sockets.
   * @param {number} [port=0]
   * @returns {Promise<number>} the assigned port
   */
  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this._tcpServer = createServer(socket => this._onSocket(socket));
      this._tcpServer.on('error', reject);
      this._tcpServer.listen(port, '0.0.0.0', () => {
        const addr = this._tcpServer.address();
        this._assignedPort = addr.port;
        debug('[%s] TCP server listening on port %d', this.tunnelId, this._assignedPort);
        resolve(this._assignedPort);
      });
    });
  }

  _onSocket(socket) {
    if (this._destroyed) {
      socket.destroy();
      return;
    }
    this._connectedCount++;
    debug('[%s] new tunnel socket from %s:%d [pool=%d]',
      this.tunnelId, socket.remoteAddress, socket.remotePort, this._availableSockets.length);

    socket.setKeepAlive(true);
    socket.once('close', () => {
      this._connectedCount--;
      const idx = this._availableSockets.indexOf(socket);
      if (idx !== -1) this._availableSockets.splice(idx, 1);
      debug('[%s] socket closed [pool=%d]', this.tunnelId, this._availableSockets.length);
    });
    socket.once('error', () => socket.destroy());

    if (this._waiters.length > 0) {
      const resolve = this._waiters.shift();
      resolve(socket);
    } else {
      this._availableSockets.push(socket);
    }
  }

  /**
   * Pop an available socket from the pool, or wait until one arrives.
   * @param {number} timeoutMs
   * @returns {Promise<import('node:net').Socket>}
   */
  getSocket(timeoutMs = 5000) {
    if (this._destroyed) {
      return Promise.reject(new Error('TunnelAgent destroyed'));
    }
    // Pull the first still-usable socket. Sockets can be killed silently by
    // intermediate proxies / load balancers on idle timeout; without this
    // filter we'd hand out a zombie that would FIN immediately on first write,
    // causing the caller to see a 0-byte response.
    while (this._availableSockets.length > 0) {
      const candidate = this._availableSockets.shift();
      if (candidate.destroyed || candidate.readable === false || candidate.writable === false) {
        debug('[%s] discarding dead socket from pool [pool=%d]', this.tunnelId, this._availableSockets.length);
        try { candidate.destroy(); } catch {}
        continue;
      }
      return Promise.resolve(candidate);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._waiters.indexOf(resolve);
        if (idx !== -1) this._waiters.splice(idx, 1);
        reject(Object.assign(new Error('Timeout waiting for tunnel socket'), { code: 'ESOCKETTIMEOUT' }));
      }, timeoutMs);
      timer.unref();
      this._waiters.push(resolve);
    });
  }

  /**
   * Send a 429 Too Many Connections response directly to a socket.
   * @param {import('node:net').Socket} socket - the incoming HTTP socket
   * @param {object} info
   */
  static send429(socket, info = {}) {
    const headers = [
      'HTTP/1.1 429 Too Many Connections',
      'Content-Type: application/json',
      `X-TT-Max-Connections: ${info.max ?? ''}`,
      `X-TT-Current-Connections: ${info.current ?? ''}`,
      `X-TT-Available-Connections: ${info.available ?? ''}`,
      `X-TT-Waiting-Requests: ${info.waiting ?? ''}`,
      'X-TT-Source: server',
      'X-TT-Proto: the-tubes/1.0',
      'Connection: close',
    ];
    const body = JSON.stringify({ error: 'Too many connections', ...info });
    headers.push(`Content-Length: ${Buffer.byteLength(body)}`);
    socket.write(headers.join('\r\n') + '\r\n\r\n' + body);
    socket.end();
  }

  get availableCount() { return this._availableSockets.length; }
  get waitingCount() { return this._waiters.length; }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const s of this._availableSockets) s.destroy();
    this._availableSockets = [];
    for (const resolve of this._waiters) resolve(null);
    this._waiters = [];
    if (this._tcpServer) {
      this._tcpServer.close();
      this._tcpServer = null;
    }
    super.destroy();
    debug('[%s] agent destroyed', this.tunnelId);
  }
}
