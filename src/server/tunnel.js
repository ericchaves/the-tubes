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

    // Track bytes and relay HTTP response properly.
    // socket carries a full raw HTTP response (status line + headers + body).
    // We must parse the response headers and call res.writeHead() before writing
    // the body — piping raw bytes directly into http.ServerResponse would send
    // "HTTP/1.1 200 OK\r\n..." as the body of the outer response.
    //
    // We must also detect response completion (Content-Length / chunked / no-body)
    // and end the response ourselves. Upstream services (e.g. n8n) use HTTP
    // keep-alive, so the tunnel socket stays open after each response — waiting
    // for socket 'end' would stall forever and the public client would timeout.
    //
    // Transfer framing is re-generated by the outer http.ServerResponse, so the
    // upstream's hop-by-hop framing headers (content-length, transfer-encoding,
    // connection) are stripped and the body is decoded (chunked → raw) before
    // being written to res.
    let bytesIn = 0;
    let bytesOut = 0;
    let status = 0;
    const startMs = Date.now();

    req.on('data', chunk => { bytesIn += chunk.length; });

    let resBuf = Buffer.alloc(0);
    let resHeadersParsed = false;
    let bodyBytesReceived = 0;
    let contentLength = -1;
    let isChunked = false;
    let hasNoBody = false;
    let responseEnded = false;
    let chunkDecoder = null;

    const endResponse = () => {
      if (responseEnded) return;
      responseEnded = true;
      // Defensive: if the tunnel socket closed before we parsed any response
      // headers from upstream, don't let Node default to "200 OK with empty
      // body" — that misleads callers (e.g. WhatsApp webhook verification).
      // Report 502 Bad Gateway so the public client sees a real error.
      if (!resHeadersParsed) {
        try {
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'X-TT-Source': 'server',
            'X-TT-Proto': 'the-tubes/1.0',
          });
          res.end(JSON.stringify({ error: 'Bad Gateway: upstream closed without response' }));
        } catch {}
      } else {
        try { res.end(); } catch {}
      }
      // Close the tunnel socket: the client's TunnelCluster uses one pair per
      // request. Leaving the socket dangling would keep stale pairs in the
      // pool; closing it unblocks the client's local.once('close') → remote.end().
      try { socket.end(); } catch {}
    };

    const parseHeaders = (sepIdx) => {
      const headerSection = resBuf.subarray(0, sepIdx).toString('latin1');
      const lines = headerSection.split('\r\n');
      const statusParts = lines[0].split(' ');
      status = parseInt(statusParts[1], 10);

      const outHeaders = {};
      for (let i = 1; i < lines.length; i++) {
        const colon = lines[i].indexOf(':');
        if (colon === -1) continue;
        const name = lines[i].slice(0, colon).trim();
        const lname = name.toLowerCase();
        const value = lines[i].slice(colon + 1).trim();

        if (lname === 'content-length') {
          contentLength = parseInt(value, 10);
          continue; // drop — outer res recomputes framing
        }
        if (lname === 'transfer-encoding') {
          if (value.toLowerCase().includes('chunked')) isChunked = true;
          continue; // drop — outer res recomputes framing
        }
        if (lname === 'connection') continue; // hop-by-hop

        if (Object.prototype.hasOwnProperty.call(outHeaders, name)) {
          outHeaders[name] = [].concat(outHeaders[name], value);
        } else {
          outHeaders[name] = value;
        }
      }

      if ((status >= 100 && status < 200) || status === 204 || status === 304 || method === 'HEAD') {
        hasNoBody = true;
      }

      if (isChunked) chunkDecoder = createChunkedDecoder();
      res.writeHead(status, outHeaders);
    };

    const consumeBody = (chunk) => {
      if (chunk.length === 0) return;
      bodyBytesReceived += chunk.length;

      if (isChunked) {
        const { decoded, done } = chunkDecoder.push(chunk);
        if (decoded.length > 0) res.write(decoded);
        if (done) endResponse();
      } else {
        res.write(chunk);
        if (contentLength >= 0 && bodyBytesReceived >= contentLength) endResponse();
      }
    };

    socket.on('data', chunk => {
      bytesOut += chunk.length;
      if (responseEnded) return;

      if (resHeadersParsed) {
        consumeBody(chunk);
        return;
      }

      resBuf = Buffer.concat([resBuf, chunk]);
      const sepIdx = resBuf.indexOf('\r\n\r\n');
      if (sepIdx === -1) return;

      resHeadersParsed = true;
      parseHeaders(sepIdx);

      if (hasNoBody) {
        endResponse();
        resBuf = null;
        return;
      }

      const bodyStart = resBuf.subarray(sepIdx + 4);
      resBuf = null;
      consumeBody(bodyStart);
    });

    socket.once('end', () => endResponse());

    // Reconstruct and forward the full HTTP request (headers + body).
    // Node.js has already consumed the headers from the TCP stream by the time
    // the request handler is called, so we must re-serialize them manually
    // before piping the body — same pattern used in handleUpgrade.
    const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const reqHeaders = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    socket.write(reqLine + reqHeaders + '\r\n\r\n');
    req.pipe(socket, { end: false });

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
    res.once('close', () => {
      if (!res.writableFinished) {
        // Public client abandoned the request before we finished responding —
        // tear down the tunnel socket so upstream stops processing.
        logFinish('client_disconnected');
        try { socket.destroy(); } catch {}
      }
    });
    socket.once('error', () => {
      logFinish('socket_error');
      endResponse();
    });
    res.once('error', () => {
      logFinish('response_error');
      try { socket.destroy(); } catch {}
    });
    // NOTE: do NOT tear down the tunnel socket on req.once('close'). For a GET
    // request with no body, Node's IncomingMessage emits 'close' very early
    // (the empty body stream is "consumed" immediately), which would close the
    // tunnel socket before the upstream service could send its response.
    // Only res.once('close') with !writableFinished is a reliable signal that
    // the public client actually disconnected.
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

/**
 * Incremental decoder for HTTP/1.1 Transfer-Encoding: chunked.
 * Feeds raw bytes via push(buf); returns the decoded payload bytes and a `done`
 * flag when the terminal zero-length chunk is consumed.
 *
 * Intentionally lenient — ignores chunk extensions and trailers, which are
 * unused by the upstream services this tunnel forwards to.
 */
function createChunkedDecoder() {
  let buf = Buffer.alloc(0);
  let expectSizeLine = true;
  let remaining = 0; // bytes remaining in current chunk body

  return {
    push(chunk) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      const out = [];
      let done = false;

      while (buf.length > 0) {
        if (expectSizeLine) {
          const eol = buf.indexOf('\r\n');
          if (eol === -1) break;
          const sizeStr = buf.subarray(0, eol).toString('latin1').split(';')[0].trim();
          const size = parseInt(sizeStr, 16);
          buf = buf.subarray(eol + 2);
          if (!Number.isFinite(size) || size < 0) { done = true; break; }
          if (size === 0) {
            // Consume optional trailers up to final \r\n\r\n or a lone \r\n
            const term = buf.indexOf('\r\n');
            if (term !== -1) buf = buf.subarray(term + 2);
            done = true;
            break;
          }
          remaining = size;
          expectSizeLine = false;
        } else {
          if (remaining > 0) {
            const take = Math.min(remaining, buf.length);
            out.push(buf.subarray(0, take));
            buf = buf.subarray(take);
            remaining -= take;
            if (remaining > 0) break;
          }
          // After chunk body, expect trailing \r\n then next size line
          if (buf.length < 2) break;
          buf = buf.subarray(2); // skip the \r\n
          expectSizeLine = true;
        }
      }

      return { decoded: out.length === 0 ? Buffer.alloc(0) : Buffer.concat(out), done };
    },
  };
}
