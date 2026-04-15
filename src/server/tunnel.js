import { EventEmitter } from 'node:events';
import { createDebug } from '../debug.js';
import { TunnelAgent } from './tunnel-agent.js';
import { generateCaptureId } from '../common/id-generator.js';
import { maskHeaders } from './admin/event-log.js';

const debug = createDebug('server:tunnel');

/**
 * Server-side tunnel: manages one expose session's lifecycle.
 * Owns a TunnelAgent (TCP socket pool) and handles grace/reconnect window.
 *
 * Events:
 *   'close' — tunnel fully closed (grace window expired or destroy called)
 */
export class ServerTunnel extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.tunnelId
   * @param {string} opts.sessionToken
   * @param {number} opts.maxConnections
   * @param {number} opts.reconnectWindowMs
   * @param {number} opts.assignedPort
   * @param {object} opts.serverConfig
   * @param {import('./admin/event-log.js').EventLog} [opts.eventLog]
   */
  constructor(opts) {
    super();
    this.tunnelId = opts.tunnelId;
    this.sessionToken = opts.sessionToken;
    this.maxConnections = opts.maxConnections;
    this.reconnectWindowMs = opts.reconnectWindowMs;
    this._cfg = opts.serverConfig;
    this._log = opts.eventLog ?? null;

    this.agent = new TunnelAgent({
      tunnelId: opts.tunnelId,
      maxConnections: opts.maxConnections,
    });

    this._port = opts.assignedPort;
    this._closed = false;
    this._reconnectTimer = null;
    this.connected = false;
    this.createdAt = new Date().toISOString();

    const tokenPrefix = this.sessionToken.slice(0, 8);
    debug('[token=%s] tunnel created (id=%s, port=%d)', tokenPrefix, this.tunnelId, this._port);
    this._log?.push('tunnel.created', {
      port: this._port,
      maxConnections: this.maxConnections,
      reconnectWindowMs: this.reconnectWindowMs,
      sessionTokenPrefix: tokenPrefix,
    });
  }

  get port() { return this._port; }

  /**
   * Start the TCP listener (should be called after construction).
   */
  async startListening() {
    const assignedPort = await this.agent.listen(this._port);
    this._port = assignedPort; // update in case OS assigned a random port (port=0)
    this.connected = true;
    this._clearReconnectTimer();
    this._log?.push('tunnel.connected', {
      port: this._port,
      socketCount: this.agent.availableCount,
    });
  }

  /**
   * Called when the expose process is considered disconnected.
   * Starts the reconnect window countdown.
   */
  startReconnectWindow() {
    if (this._closed) return;
    this.connected = false;
    debug('[token=%s] reconnect window started (%dms)', this.sessionToken.slice(0, 8), this.reconnectWindowMs);
    this._log?.push('tunnel.disconnected', { reconnectWindowMs: this.reconnectWindowMs });
    this._reconnectTimer = setTimeout(() => {
      debug('[token=%s] reconnect window expired, closing tunnel', this.sessionToken.slice(0, 8));
      this._log?.push('tunnel.window_expired', {});
      this.destroy();
    }, this.reconnectWindowMs);
    this._reconnectTimer.unref();
  }

  /**
   * Called when the expose process reconnects.
   */
  onReconnect() {
    this._clearReconnectTimer();
    this.connected = true;
    debug('[token=%s] tunnel reconnected', this.sessionToken.slice(0, 8));
    this._log?.push('tunnel.reconnected', { socketCount: this.agent.availableCount });
  }

  /**
   * Handle an incoming HTTP request for this tunnel.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async handleRequest(req, res) {
    const cfg = this._cfg;
    const requestId = generateCaptureId();
    const method = req.method;
    const path = req.url;

    this._log?.push('request.received', {
      requestId,
      method,
      path,
      headers: maskHeaders(req.headers),
    });

    let socket;
    try {
      socket = await this.agent.getSocket(cfg.httpWaitTimeoutMs);
    } catch {
      this._log?.push('request.failed', {
        requestId, method, path, reason: 'no_socket_available', statusSent: 503,
      });
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': String(cfg.retryAfterSeconds),
        'X-TT-Source': 'server',
        'X-TT-Proto': 'the-tubes/1.0',
      });
      res.end(JSON.stringify({ error: 'Service Temporarily Unavailable' }));
      return;
    }

    if (!socket) {
      this._log?.push('request.failed', {
        requestId, method, path, reason: 'null_socket', statusSent: 503,
      });
      res.writeHead(503, { 'X-TT-Source': 'server', 'X-TT-Proto': 'the-tubes/1.0' });
      res.end();
      return;
    }

    this._log?.push('request.delivered', {
      requestId, method, path, socketPoolRemaining: this.agent.availableCount,
    });

    // Track bytes and parse HTTP response status from first chunk
    let bytesIn = 0;
    let bytesOut = 0;
    let status = 0;
    let statusParsed = false;
    const startMs = Date.now();

    req.on('data', chunk => { bytesIn += chunk.length; });
    socket.on('data', chunk => {
      bytesOut += chunk.length;
      if (!statusParsed) {
        // Peek at the first HTTP response line (e.g. "HTTP/1.1 200 OK")
        const str = chunk.toString('latin1', 0, Math.min(chunk.length, 200));
        const m = str.match(/^HTTP\/[\d.]+ (\d+)/);
        if (m) status = parseInt(m[1], 10);
        statusParsed = true;
      }
    });

    // Reconstruct and forward the full HTTP request (headers + body).
    // Node.js has already consumed the headers from the TCP stream by the time
    // the request handler is called, so we must re-serialize them manually
    // before piping the body — same pattern used in handleUpgrade.
    const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const reqHeaders = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    socket.write(reqLine + reqHeaders + '\r\n\r\n');
    req.pipe(socket);
    socket.pipe(res);

    let loggedFinish = false;
    const logFinish = (reason) => {
      if (loggedFinish) return;
      loggedFinish = true;
      const durationMs = Date.now() - startMs;
      if (reason === 'complete') {
        this._log?.push('response.complete', {
          requestId, method, path, status, bytesIn, bytesOut, durationMs,
        });
      } else {
        this._log?.push('response.aborted', {
          requestId, method, path, reason, status, bytesIn, bytesOut, durationMs,
        });
      }
    };

    res.once('finish', () => logFinish('complete'));
    res.once('close', () => { if (!res.writableFinished) logFinish('client_disconnected'); });
    socket.once('error', () => {
      logFinish('socket_error');
      try { res.end(); } catch {}
    });
    res.once('error', () => {
      logFinish('response_error');
      try { socket.destroy(); } catch {}
    });
    req.once('close', () => { try { socket.end(); } catch {} });
  }

  /**
   * Handle an HTTP upgrade (WebSocket) for this tunnel.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} clientSocket
   * @param {Buffer} head
   */
  async handleUpgrade(req, clientSocket, head) {
    const cfg = this._cfg;
    const requestId = generateCaptureId();
    const path = req.url;

    this._log?.push('ws.received', { requestId, path });

    let socket;
    try {
      socket = await this.agent.getSocket(cfg.websocketWaitTimeoutMs);
    } catch {
      this._log?.push('ws.failed', { requestId, path, reason: 'no_socket_available' });
      clientSocket.write(
        'HTTP/1.1 503 Service Temporarily Unavailable\r\n' +
        `Retry-After: ${cfg.retryAfterSeconds}\r\n` +
        'X-TT-Source: server\r\n' +
        '\r\n'
      );
      clientSocket.end();
      return;
    }

    if (!socket) {
      this._log?.push('ws.failed', { requestId, path, reason: 'null_socket' });
      clientSocket.end();
      return;
    }

    this._log?.push('ws.delivered', {
      requestId, path, socketPoolRemaining: this.agent.availableCount,
    });

    // Track bytes
    let bytesIn = 0;
    let bytesOut = 0;
    const startMs = Date.now();

    clientSocket.on('data', chunk => { bytesIn += chunk.length; });
    socket.on('data', chunk => { bytesOut += chunk.length; });

    // Forward the upgrade request raw
    const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    socket.write(reqLine + headers + '\r\n\r\n');
    if (head && head.length) socket.write(head);

    clientSocket.pipe(socket);
    socket.pipe(clientSocket);

    let loggedClose = false;
    const logClose = (reason) => {
      if (loggedClose) return;
      loggedClose = true;
      const durationMs = Date.now() - startMs;
      this._log?.push('ws.closed', { requestId, path, reason, bytesIn, bytesOut, durationMs });
    };

    const cleanup = () => {
      socket.destroy();
      clientSocket.destroy();
    };

    socket.once('error', () => { logClose('socket_error'); cleanup(); });
    clientSocket.once('error', () => { logClose('client_error'); cleanup(); });
    socket.once('close', () => { logClose('socket_closed'); clientSocket.end(); });
    clientSocket.once('close', () => { logClose('client_closed'); socket.end(); });
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  destroy() {
    if (this._closed) return;
    this._closed = true;
    this._clearReconnectTimer();
    this._log?.push('tunnel.destroyed', {});
    this.agent.destroy();
    this.emit('close');
    debug('[token=%s] tunnel destroyed (id=%s)', this.sessionToken.slice(0, 8), this.tunnelId);
  }
}
