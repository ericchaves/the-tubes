import { EventEmitter } from 'node:events';
import { createDebug } from '../debug.js';
import { TunnelAgent } from './tunnel-agent.js';
import { generateCaptureId } from '../common/id-generator.js';
import { maskHeaders } from './admin/event-log.js';
import { MSG } from '../common/control-protocol.js';

const debug = createDebug('server:tunnel');

let _pairSeq = 0;
const nextPairId = () => `p${Date.now().toString(36)}${(++_pairSeq).toString(36)}`;

/**
 * Server-side tunnel. Owns a TunnelAgent (TCP listener for data sockets) and
 * an optional ControlSession (WebSocket for request lifecycle messages).
 *
 * Request flow:
 *   1. handleRequest is called by the public server.
 *   2. pairId is allocated; agent.reservePair returns a Promise.
 *   3. `pair.open` is sent on the control channel.
 *   4. Client opens local service, then a data socket with preamble.
 *   5. TunnelAgent resolves the Promise with the data socket.
 *   6. Server pipes the HTTP request and parses the response.
 *   7. On completion, `pair.closed` may arrive from the client; server logs.
 */
export class ServerTunnel extends EventEmitter {
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
    this.agent.onReplacement(info => this._onReplacementSocket(info));

    this._port = opts.assignedPort;
    this._closed = false;
    this._reconnectTimer = null;
    this.connected = false;
    this.createdAt = new Date().toISOString();

    /** @type {import('./control-session.js').ControlSession|null} */
    this._control = null;
    this._controlId = null;
    this._controlConnectedAt = null;

    /** Map<pairId, { kind, requestId, method, path, remoteAddr, external, onReplace? }> */
    this._pairs = new Map();

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
  get hasControl() { return this._control !== null && !this._control.closed; }

  async startListening() {
    const assignedPort = await this.agent.listen(this._port);
    this._port = assignedPort;
  }

  /**
   * Called by control-upgrade when a new control WebSocket is established.
   * Replaces any existing session.
   */
  attachControlSession(session) {
    if (this._closed) { session.close('tunnel_closed'); return; }

    // A new control arriving while another is still alive: close the old one.
    const previous = this._control;
    if (previous) {
      debug('[%s] replacing existing control session', this.tunnelId);
      previous.close('superseded');
    }
    this._control = session;

    session.once('hello', ({ controlId, resumeControlId, inflightPairs }) => {
      this._onHello({ controlId, resumeControlId, inflightPairs, session });
    });
    session.on('message', msg => this._onControlMessage(msg));
    session.once('close', ({ reason }) => this._onControlClose(reason, session));
    session.once('heartbeat_timeout', info => {
      this._log?.push('control.heartbeat_timeout', {
        controlId: this._controlId, lastPongAgoMs: info.lastPongAgoMs,
      });
    });
  }

  _onHello({ controlId, resumeControlId, inflightPairs, session }) {
    if (this._control !== session) return;
    this._clearReconnectTimer();
    this.connected = true;
    this._controlId = controlId;
    this._controlConnectedAt = Date.now();

    // Determine keep/drop for replacement
    const keep = [];
    const drop = [];
    for (const pairId of inflightPairs) {
      const pair = this._pairs.get(pairId);
      if (pair && pair.external && !pair.external.destroyed) keep.push(pairId);
      else drop.push(pairId);
    }

    this._log?.push(resumeControlId ? 'control.resumed' : 'control.connected', {
      controlId,
      previousControlId: resumeControlId,
      remoteAddr: session.remoteAddr,
      keptPairs: keep.length,
      droppedPairs: drop.length,
    });

    session.send(MSG.HELLO_ACK, { tunnelId: this.tunnelId, keep, drop });

    // For pairs the server wants to keep, clean up the old data socket if still
    // present (it belongs to a stale controlId). Client will open a REPLACES socket.
    for (const pairId of keep) {
      const pair = this._pairs.get(pairId);
      if (pair && pair.dataSocket) {
        try { pair.dataSocket.destroy(); } catch {}
        pair.dataSocket = null;
      }
    }
    // Drop the ones we said we're dropping.
    for (const pairId of drop) this._teardownPair(pairId, 'dropped_on_resume');
  }

  _onControlMessage(msg) {
    if (msg.type === MSG.PAIR_FAILED) {
      const pair = this._pairs.get(msg.pairId);
      if (pair) {
        this._log?.push('pair.local_refused', {
          pairId: msg.pairId, requestId: pair.requestId, reason: msg.reason,
        });
        this.agent.cancelPair(msg.pairId, msg.reason);
        this._teardownPair(msg.pairId, msg.reason);
      }
      return;
    }
    if (msg.type === MSG.PAIR_CLOSED) {
      const pair = this._pairs.get(msg.pairId);
      if (pair) {
        this._log?.push('pair.closed', {
          pairId: msg.pairId,
          requestId: pair.requestId,
          reason: msg.reason,
          bytesIn: msg.bytesIn,
          bytesOut: msg.bytesOut,
          durationMs: msg.durationMs,
        });
      }
      return;
    }
  }

  _onControlClose(reason, session) {
    if (this._control !== session) return;
    this._control = null;
    this.connected = false;
    this._log?.push('control.disconnected', {
      controlId: this._controlId,
      reason,
      durationMs: this._controlConnectedAt ? Date.now() - this._controlConnectedAt : null,
      inflightPairs: [...this._pairs.keys()],
    });
    if (this._closed) return;
    this._startReconnectWindow();
  }

  _onReplacementSocket({ pairId, replacesControlId, socket, residual }) {
    const pair = this._pairs.get(pairId);
    if (!pair || !pair.onReplace) {
      debug('[%s] replacement rejected for %s', this.tunnelId, pairId);
      try { socket.destroy(); } catch {}
      return;
    }
    pair.dataSocket = socket;
    this.agent.markActive(pairId, socket);
    this._log?.push('pair.replaced', { pairId, previousControlId: replacesControlId });
    pair.onReplace(socket, residual);
  }

  _startReconnectWindow() {
    debug('[token=%s] reconnect window started (%dms)', this.sessionToken.slice(0, 8), this.reconnectWindowMs);
    this._reconnectTimer = setTimeout(() => {
      debug('[token=%s] reconnect window expired, closing tunnel', this.sessionToken.slice(0, 8));
      this._log?.push('tunnel.window_expired', {});
      this.destroy();
    }, this.reconnectWindowMs);
    this._reconnectTimer.unref();
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  /**
   * Allocate a pair + request the client to open it. Returns the data socket.
   */
  async _openPair({ kind, requestId, method, path, remoteAddr, timeoutMs, external }) {
    if (!this.hasControl) {
      const err = new Error('No control channel');
      err.code = 'ENOCONTROL';
      throw err;
    }
    if (this._pairs.size >= this.maxConnections) {
      const err = new Error('Max concurrent pairs reached');
      err.code = 'EMAXCONN';
      throw err;
    }
    const pairId = nextPairId();
    this._pairs.set(pairId, { kind, requestId, method, path, remoteAddr, external, dataSocket: null });
    this._log?.push('pair.requested', { pairId, requestId, kind, method, path, remoteAddr });

    const reservation = this.agent.reservePair(pairId, timeoutMs);
    this._control.send(MSG.PAIR_OPEN, { pairId, requestId, kind, method, path, remoteAddr });

    let socket;
    try {
      socket = await reservation;
    } catch (err) {
      this._pairs.delete(pairId);
      throw err;
    }
    const pair = this._pairs.get(pairId);
    if (pair) {
      pair.dataSocket = socket;
      this.agent.markActive(pairId, socket);
    }
    this._log?.push('pair.opened', { pairId, requestId });
    return { pairId, socket };
  }

  _teardownPair(pairId, reason) {
    const pair = this._pairs.get(pairId);
    if (!pair) return;
    this._pairs.delete(pairId);
    if (pair.dataSocket) { try { pair.dataSocket.destroy(); } catch {} }
    if (this.hasControl) {
      this._control.send(MSG.PAIR_CLOSE, { pairId, reason });
    }
  }

  async handleRequest(req, res) {
    const cfg = this._cfg;
    const requestId = generateCaptureId();
    const method = req.method;
    const path = req.url;
    const remoteAddr = req.socket?.remoteAddress ?? null;

    this._log?.push('request.received', {
      requestId, method, path,
      headers: maskHeaders(req.headers),
    });

    if (!this.hasControl) {
      this._log?.push('request.failed', { requestId, method, path, reason: 'no_control_channel', statusSent: 503 });
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': String(cfg.retryAfterSeconds),
        'X-TT-Source': 'server', 'X-TT-Proto': 'the-tubes/1.0',
      });
      return res.end(JSON.stringify({ error: 'Service Temporarily Unavailable — control channel disconnected' }));
    }

    let pairId, socket;
    try {
      ({ pairId, socket } = await this._openPair({
        kind: 'http', requestId, method, path, remoteAddr,
        timeoutMs: cfg.httpWaitTimeoutMs,
        external: res,
      }));
    } catch (err) {
      const reason = err.code === 'EMAXCONN' ? 'max_connections' : 'no_socket_available';
      this._log?.push('request.failed', { requestId, method, path, reason, statusSent: 503 });
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': String(cfg.retryAfterSeconds),
        'X-TT-Source': 'server', 'X-TT-Proto': 'the-tubes/1.0',
      });
      return res.end(JSON.stringify({ error: 'Service Temporarily Unavailable' }));
    }

    this._log?.push('request.delivered', { requestId, method, path, pairId });

    // Relay HTTP request → data socket; parse response back.
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
      if (!resHeadersParsed) {
        try {
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'X-TT-Source': 'server', 'X-TT-Proto': 'the-tubes/1.0',
          });
          res.end(JSON.stringify({ error: 'Bad Gateway: upstream closed without response' }));
        } catch {}
      } else {
        try { res.end(); } catch {}
      }
      try { socket.end(); } catch {}
      this._pairs.delete(pairId);
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

        if (lname === 'content-length') { contentLength = parseInt(value, 10); continue; }
        if (lname === 'transfer-encoding') {
          if (value.toLowerCase().includes('chunked')) isChunked = true;
          continue;
        }
        if (lname === 'connection') continue;

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

      if (resHeadersParsed) { consumeBody(chunk); return; }

      resBuf = Buffer.concat([resBuf, chunk]);
      const sepIdx = resBuf.indexOf('\r\n\r\n');
      if (sepIdx === -1) return;

      resHeadersParsed = true;
      parseHeaders(sepIdx);

      if (hasNoBody) { endResponse(); resBuf = null; return; }

      const bodyStart = resBuf.subarray(sepIdx + 4);
      resBuf = null;
      consumeBody(bodyStart);
    });

    socket.once('end', () => endResponse());

    // Forward the request
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
        this._log?.push('response.complete', { requestId, method, path, status, bytesIn, bytesOut, durationMs });
      } else {
        this._log?.push('response.aborted', { requestId, method, path, reason, status, bytesIn, bytesOut, durationMs });
      }
    };

    res.once('finish', () => logFinish('complete'));
    res.once('close', () => {
      if (!res.writableFinished) {
        logFinish('client_disconnected');
        this._teardownPair(pairId, 'client_disconnected');
      }
    });
    socket.once('error', () => { logFinish('socket_error'); endResponse(); });
    res.once('error', () => { logFinish('response_error'); this._teardownPair(pairId, 'response_error'); });
  }

  async handleUpgrade(req, clientSocket, head) {
    const cfg = this._cfg;
    const requestId = generateCaptureId();
    const path = req.url;
    const remoteAddr = req.socket?.remoteAddress ?? null;

    this._log?.push('ws.received', { requestId, path, remoteAddr });

    if (!this.hasControl) {
      this._log?.push('ws.failed', { requestId, path, reason: 'no_control_channel' });
      clientSocket.write('HTTP/1.1 503 Service Temporarily Unavailable\r\nX-TT-Source: server\r\n\r\n');
      return clientSocket.end();
    }

    let pairId, socket;
    try {
      ({ pairId, socket } = await this._openPair({
        kind: 'ws', requestId, method: 'GET', path, remoteAddr,
        timeoutMs: cfg.websocketWaitTimeoutMs,
        external: clientSocket,
      }));
    } catch (err) {
      const reason = err.code === 'EMAXCONN' ? 'max_connections' : 'no_socket_available';
      this._log?.push('ws.failed', { requestId, path, reason });
      clientSocket.write('HTTP/1.1 503 Service Temporarily Unavailable\r\nX-TT-Source: server\r\n\r\n');
      return clientSocket.end();
    }

    this._log?.push('ws.delivered', { requestId, path, pairId });

    let bytesIn = 0;
    let bytesOut = 0;
    const startMs = Date.now();

    const attachPipes = (dataSocket, residual) => {
      clientSocket.on('data', chunk => { bytesIn += chunk.length; });
      dataSocket.on('data', chunk => { bytesOut += chunk.length; });
      clientSocket.pipe(dataSocket);
      dataSocket.pipe(clientSocket);
      if (residual && residual.length) clientSocket.write(residual);
    };

    // Record replacement hook — if control drops, the client will open a
    // replacement data socket with the same pairId + REPLACES <prev controlId>.
    const pair = this._pairs.get(pairId);
    if (pair) {
      pair.onReplace = (newSocket, residual) => {
        try { socket.destroy(); } catch {}
        socket = newSocket;
        attachPipes(newSocket, residual);
      };
    }

    // Forward the upgrade request raw
    const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    socket.write(reqLine + headers + '\r\n\r\n');
    if (head && head.length) socket.write(head);

    attachPipes(socket, null);

    let loggedClose = false;
    const logClose = (reason) => {
      if (loggedClose) return;
      loggedClose = true;
      const durationMs = Date.now() - startMs;
      this._log?.push('ws.closed', { requestId, path, reason, bytesIn, bytesOut, durationMs });
      this._pairs.delete(pairId);
    };

    socket.once('error', () => { logClose('socket_error'); try { clientSocket.destroy(); } catch {} });
    clientSocket.once('error', () => { logClose('client_error'); try { socket.destroy(); } catch {} });
    socket.once('close', () => { logClose('socket_closed'); try { clientSocket.end(); } catch {} });
    clientSocket.once('close', () => { logClose('client_closed'); this._teardownPair(pairId, 'client_closed'); });
  }

  destroy() {
    if (this._closed) return;
    this._closed = true;
    this._clearReconnectTimer();
    if (this._control) this._control.close('tunnel_destroyed');
    for (const pairId of [...this._pairs.keys()]) this._teardownPair(pairId, 'tunnel_destroyed');
    this._log?.push('tunnel.destroyed', {});
    this.agent.destroy();
    this.emit('close');
    debug('[token=%s] tunnel destroyed (id=%s)', this.sessionToken.slice(0, 8), this.tunnelId);
  }

  // Back-compat stub for old callers — the new model doesn't need this anymore.
  onReconnect() {}
  startReconnectWindow() { this._startReconnectWindow(); }
}

/**
 * Incremental decoder for HTTP/1.1 Transfer-Encoding: chunked.
 */
function createChunkedDecoder() {
  let buf = Buffer.alloc(0);
  let expectSizeLine = true;
  let remaining = 0;

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
          if (buf.length < 2) break;
          buf = buf.subarray(2);
          expectSizeLine = true;
        }
      }

      return { decoded: out.length === 0 ? Buffer.alloc(0) : Buffer.concat(out), done };
    },
  };
}
