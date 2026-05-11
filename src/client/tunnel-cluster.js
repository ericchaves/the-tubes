import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createDebug } from '../debug.js';
import { HeaderHostTransformer } from './header-host-transformer.js';
import { HttpInspector } from './http-inspector.js';
import { buildPreamble, MSG } from '../common/control-protocol.js';

const debug = createDebug('client:cluster');

/**
 * TunnelCluster manages on-demand socket pairs on the client side.
 *
 * A pair exists only while a real external request is being proxied. It is
 * created when the server sends `pair.open` on the control channel:
 *   1. Connect to the local service first. If it fails, the data socket is
 *      never opened; we reply `pair.failed` and the server returns 502 to
 *      the external client.
 *   2. Connect to the server's TCP data listener and write the preamble
 *      (`TT/1 PAIR <pairId>\r\n`) so the server can match it to the reserved
 *      pending request.
 *   3. Pipe bidirectionally (with optional Host header rewriting) until
 *      either side closes.
 *   4. On close, emit `pair.closed` with stats to the server and clean up.
 *
 * Events (for ClientTunnel/admin):
 *   'open'        — pair fully connected { pairId, requestId }
 *   'tunnel:dead' — pair died { pairId, reason, kind, retriable }
 *   'request'     — proxied request info { method, path, status }
 *   'capture'     — capture saved { captureId, file, method, path }
 */
export class TunnelCluster extends EventEmitter {
  /**
   * @param {object} info - tunnel info returned by POST /api/tunnels
   * @param {object} config
   * @param {import('./failure-tracker.js').FailureTracker} failureTracker
   * @param {import('./reconnect-policy.js').ReconnectPolicy} reconnectPolicy
   * @param {import('./control-channel.js').ControlChannel} control
   */
  constructor(info, config, failureTracker, reconnectPolicy, control) {
    super();
    this.info = info;
    this.config = config;
    this.failureTracker = failureTracker;
    this.reconnectPolicy = reconnectPolicy;
    this.control = control;
    /** @type {Map<string, object>} pairId → pair state */
    this.pairs = new Map();
    this._closed = false;
    this._captureEnabled = !!config.captureDir && !!config.captureEnabled;
    this._inspector = config.captureDir
      ? new HttpInspector({ captureDir: config.captureDir, tunnelId: info.tunnelId, maxBodyKb: config.captureMaxBodyKb })
      : null;
    if (this._inspector && !this._captureEnabled) this._inspector.setPaused(true);

    // Wire control messages to pair lifecycle
    control.on('message', msg => {
      if (msg.type === MSG.PAIR_OPEN) this._openPair(msg);
      else if (msg.type === MSG.PAIR_CLOSE) this._closePair(msg.pairId, msg.reason);
    });
    control.on('resumed', ({ keep, drop, previousControlId }) => {
      for (const pairId of drop) this._closePair(pairId, 'dropped_on_resume');
      for (const pairId of keep) this._replacePair(pairId, previousControlId);
    });
    control.on('disconnected', () => {
      // HTTP pairs in flight cannot survive a control drop (body may be
      // partially forwarded). WS pairs are kept — they'll get REPLACES on resume.
      for (const [pairId, pair] of this.pairs) {
        if (pair.kind !== 'ws') this._closePair(pairId, 'control_disconnected');
      }
    });
  }

  /**
   * Open a pair in response to pair.open from the server.
   */
  _openPair(msg) {
    if (this._closed) return;
    const { pairId, requestId, kind, method, path } = msg;

    const pair = {
      pairId, requestId, kind, method, path,
      local: null, data: null,
      startMs: Date.now(),
      bytesIn: 0, bytesOut: 0,
      reqBufs: [], resBufs: [], reqTotal: 0, resTotal: 0,
      requestEmitted: false,
    };
    this.pairs.set(pairId, pair);

    // Step 1: connect to local service
    const local = this._connectLocal();
    pair.local = local;

    local.once('error', (err) => {
      // ECONNREFUSED is a normal "app down temporarily" signal — do not charge
      // against the failure budget (same rule as the legacy model).
      if (err.code !== 'ECONNREFUSED') this.failureTracker.record('localConnect');
      this._reportFailure(pairId, err.code || err.message);
      const retriable = this.config.reconnectLocal !== false;
      this.emit('tunnel:dead', { pairId, reason: err.code || err.message, kind: 'localConnect', retriable });
      this.pairs.delete(pairId);
    });

    local.once('connect', () => {
      // Step 2: open data socket to server with preamble
      const data = netConnect({
        host: this.info.tunnelHost,
        port: this.info.tunnelPort,
        allowHalfOpen: true,
      });
      pair.data = data;

      data.once('error', (err) => {
        this.failureTracker.record('remoteConnect');
        try { local.destroy(); } catch {}
        this._reportFailure(pairId, err.code || err.message);
        this.emit('tunnel:dead', { pairId, reason: err.code || err.message, kind: 'remoteConnect', retriable: true });
        this.pairs.delete(pairId);
      });

      data.once('connect', () => {
        data.setKeepAlive(true);
        data.write(buildPreamble(pairId));
        this._wirePair(pair);
        this.emit('open', { pairId, requestId });
      });
    });
  }

  /**
   * Reconnect a WS pair that survived a control outage. The server kept the
   * external socket alive; we must open a new data socket with REPLACES and
   * reconnect the local service, then splice the two together.
   *
   * Note: for WS we cannot replay missed frames; the application must
   * tolerate brief interruption. This is best-effort.
   */
  _replacePair(pairId, previousControlId) {
    const pair = this.pairs.get(pairId);
    if (!pair) return;
    if (pair.kind !== 'ws') { this._closePair(pairId, 'replace_not_supported'); return; }

    // Tear down old sockets
    try { pair.local?.destroy(); } catch {}
    try { pair.data?.destroy(); } catch {}

    const local = this._connectLocal();
    pair.local = local;
    local.once('error', () => {
      this._reportFailure(pairId, 'replace_local_error');
      this.pairs.delete(pairId);
    });
    local.once('connect', () => {
      const data = netConnect({
        host: this.info.tunnelHost,
        port: this.info.tunnelPort,
        allowHalfOpen: true,
      });
      pair.data = data;
      data.once('connect', () => {
        data.setKeepAlive(true);
        data.write(buildPreamble(pairId, previousControlId));
        // No HTTP/WS handshake replay — just wire raw bidirectional pipe.
        data.pipe(local);
        local.pipe(data);
      });
      data.once('error', () => {
        this._reportFailure(pairId, 'replace_data_error');
        this.pairs.delete(pairId);
      });
    });
  }

  _connectLocal() {
    const { config } = this;
    if (config.localTls) {
      const tlsOpts = {
        host: config.localAddress,
        port: config.localPort,
        rejectUnauthorized: !config.allowInsecureLocalTls,
      };
      if (config.localTlsCert) tlsOpts.cert = readFileSync(config.localTlsCert);
      if (config.localTlsKey) tlsOpts.key = readFileSync(config.localTlsKey);
      if (config.localTlsCa) tlsOpts.ca = readFileSync(config.localTlsCa);
      return tlsConnect(tlsOpts);
    }
    return netConnect({
      host: config.localAddress,
      port: config.localPort,
      allowHalfOpen: true,
    });
  }

  _wirePair(pair) {
    const { local, data } = pair;
    const config = this.config;
    const info = this.info;

    // Response-end detection state (see §keep-alive upstream)
    let resHeaderEnd = -1;
    let resContentLength = -1;
    let resIsChunked = false;
    let resNoBody = false;
    let resRawTotal = 0;

    const maxCollect = this._inspector
      ? (config.captureMaxBodyKb ?? 1024) * 1024 + 8192
      : 4096;

    const emitHttpRequest = () => {
      if (pair.requestEmitted) return;
      const reqMsg = _parseHttpMsg(Buffer.concat(pair.reqBufs));
      if (!reqMsg) return;
      pair.requestEmitted = true;
      const parts = reqMsg.firstLine.split(' ');
      const method = parts[0];
      const path = parts[1];
      const resBuf = Buffer.concat(pair.resBufs);
      const resMsg = _parseHttpMsg(resBuf);
      const status = resMsg ? parseInt(resMsg.firstLine.split(' ')[1], 10) : null;
      this.emit('request', { method, path, status });
      if (this._inspector && method && path) {
        const captureId = this._inspector.captureRequest({ method, path, headers: reqMsg.headers, body: reqMsg.body });
        if (resMsg) {
          this._inspector.captureResponse({ status, headers: resMsg.headers, body: resMsg.body }, captureId);
        }
        this.emit('capture', { captureId, file: `${info.tunnelId}.${captureId}.req.yaml`, method, path });
      }
    };

    const tryEmitResponseComplete = () => {
      if (pair.requestEmitted || pair.resBufs.length === 0) return;
      if (resHeaderEnd === -1) {
        const resBuf = Buffer.concat(pair.resBufs);
        resHeaderEnd = resBuf.indexOf('\r\n\r\n');
        if (resHeaderEnd === -1) return;
        const resMsg = _parseHttpMsg(resBuf);
        if (!resMsg) return;
        const statusCode = parseInt(resMsg.firstLine.split(' ')[1], 10);
        // 101 Switching Protocols — handled separately when upgraded
        if (statusCode === 101) return;
        if ((statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304) {
          resNoBody = true;
        } else {
          const cl = resMsg.headers['content-length'];
          const te = resMsg.headers['transfer-encoding'];
          resContentLength = cl !== undefined ? parseInt(cl, 10) : -1;
          resIsChunked = !!(te?.toLowerCase().includes('chunked'));
        }
      }
      if (resNoBody) { emitHttpRequest(); return; }
      if (resContentLength >= 0) {
        if (resRawTotal - (resHeaderEnd + 4) >= resContentLength) emitHttpRequest();
      } else if (resIsChunked) {
        if (Buffer.concat(pair.resBufs).indexOf(Buffer.from('\r\n0\r\n\r\n')) !== -1) emitHttpRequest();
      }
    };

    // Pipe data → local, with optional Host rewriting
    let remoteToLocal;
    if (config.rewriteHostHeader !== false) {
      const transformer = new HeaderHostTransformer(
        `${config.localAddress}:${config.localPort}`
      );
      data.pipe(transformer).pipe(local);
      remoteToLocal = transformer;
    } else {
      data.pipe(local);
      remoteToLocal = data;
    }
    local.pipe(data);

    data.on('data', chunk => {
      pair.bytesIn += chunk.length;
      if (pair.reqTotal < maxCollect) { pair.reqBufs.push(chunk); pair.reqTotal += chunk.length; }
    });
    local.on('data', chunk => {
      pair.bytesOut += chunk.length;
      resRawTotal += chunk.length;
      if (pair.resTotal < maxCollect) { pair.resBufs.push(chunk); pair.resTotal += chunk.length; }
      tryEmitResponseComplete();
    });

    // WebSocket finalize: remote EOF during WS session
    data.once('end', () => {
      const reqMsg = _parseHttpMsg(Buffer.concat(pair.reqBufs));
      if (!reqMsg) return;
      const isWebSocket = reqMsg.headers['upgrade']?.toLowerCase() === 'websocket';
      if (!isWebSocket) return;

      const parts = reqMsg.firstLine.split(' ');
      const path = parts[1];
      this.emit('request', { method: 'WS', path, status: 101 });

      if (this._inspector && path) {
        const resMsg = _parseHttpMsg(Buffer.concat(pair.resBufs));
        const clientFrames = _parseWsFrames(reqMsg.body, true);
        const serverFrames = resMsg ? _parseWsFrames(resMsg.body, false) : [];

        const captureId = this._inspector.captureWebSocket({
          path,
          reqHeaders: reqMsg.headers,
          frames: [...clientFrames, ...serverFrames],
        });
        this.emit('capture', {
          captureId,
          file: `${info.tunnelId}.${captureId}.ws.yaml`,
          method: 'WS',
          path,
        });
      }
      pair.reqBufs.length = 0;
    });

    local.once('close', (hadError) => {
      if (pair.bytesIn > 0 || pair.bytesOut > 0) {
        this.failureTracker.onSuccessfulTraffic();
        this.reconnectPolicy.reset();
      }

      // Fallback request event (for chunked responses relying on close)
      const reqMsg = _parseHttpMsg(Buffer.concat(pair.reqBufs));
      if (reqMsg && !pair.requestEmitted) {
        const path = reqMsg.firstLine.split(' ')[1];
        const isWebSocket = reqMsg.headers['upgrade']?.toLowerCase() === 'websocket';
        if (isWebSocket) {
          this.emit('request', { method: 'WS', path, status: 101 });
          if (this._inspector && path) {
            const resMsg = _parseHttpMsg(Buffer.concat(pair.resBufs));
            const clientFrames = _parseWsFrames(reqMsg.body, true);
            const serverFrames = resMsg ? _parseWsFrames(resMsg.body, false) : [];
            const captureId = this._inspector.captureWebSocket({
              path,
              reqHeaders: reqMsg.headers,
              frames: [...clientFrames, ...serverFrames],
            });
            this.emit('capture', {
              captureId,
              file: `${info.tunnelId}.${captureId}.ws.yaml`,
              method: 'WS', path,
            });
          }
        } else {
          emitHttpRequest();
        }
      }

      try { data.end(); } catch {}
      this._reportClosed(pair, hadError ? 'local_error' : 'local_closed');
      this.pairs.delete(pair.pairId);
      this.emit('tunnel:dead', {
        pairId: pair.pairId,
        reason: hadError ? 'local-closed-error' : 'local-closed-clean',
        kind: 'localDrop',
        retriable: true,
      });
    });

    data.once('close', () => {
      try { local.destroy(); } catch {}
    });
  }

  _closePair(pairId, reason) {
    const pair = this.pairs.get(pairId);
    if (!pair) return;
    this.pairs.delete(pairId);
    try { pair.local?.destroy(); } catch {}
    try { pair.data?.destroy(); } catch {}
    this.emit('tunnel:dead', { pairId, reason, kind: 'serverClose', retriable: false });
  }

  _reportFailure(pairId, reason) {
    if (this.control.connected) this.control.send(MSG.PAIR_FAILED, { pairId, reason });
  }

  _reportClosed(pair, reason) {
    if (this.control.connected) {
      this.control.send(MSG.PAIR_CLOSED, {
        pairId: pair.pairId, reason,
        bytesIn: pair.bytesIn, bytesOut: pair.bytesOut,
        durationMs: Date.now() - pair.startMs,
      });
    }
  }

  getInflightPairIds() { return [...this.pairs.keys()]; }

  get captureEnabled() { return this._captureEnabled; }

  toggleCapture(enabled) {
    this._captureEnabled = enabled;
    this._inspector?.setPaused(!enabled);
  }

  close() {
    this._closed = true;
    for (const pair of this.pairs.values()) {
      try { pair.local?.destroy(); } catch {}
      try { pair.data?.destroy(); } catch {}
    }
    this.pairs.clear();
  }
}

/**
 * RFC 6455 WebSocket frame parser (for capture only — scans buffered bytes).
 */
function _parseWsFrames(buf, isClient) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const byte0 = buf[offset];
    const byte1 = buf[offset + 1];
    offset += 2;
    const opcode = byte0 & 0x0F;
    const masked = (byte1 & 0x80) !== 0;
    let payloadLen = byte1 & 0x7F;
    if (payloadLen === 126) {
      if (offset + 2 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset); offset += 2;
    } else if (payloadLen === 127) {
      if (offset + 8 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset)); offset += 8;
    }
    let maskKey = null;
    if (masked) {
      if (offset + 4 > buf.length) break;
      maskKey = buf.slice(offset, offset + 4); offset += 4;
    }
    if (offset + payloadLen > buf.length) break;
    let payload = buf.slice(offset, offset + payloadLen);
    offset += payloadLen;
    if (masked && maskKey) {
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    if (opcode === 0) continue;
    const dir = isClient ? 'client' : 'server';
    const text = payload.toString('utf8');
    const isBinary = opcode === 2 || _hasBinaryChars(text);
    frames.push({
      dir, opcode,
      encoding: isBinary ? 'base64' : 'utf8',
      data: isBinary ? payload.toString('base64') : text,
    });
  }
  return frames;
}

function _parseHttpMsg(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep === -1) return null;
  const lines = buf.slice(0, sep).toString('latin1').split('\r\n');
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
  }
  return { firstLine: lines[0], headers, body: buf.slice(sep + 4) };
}

function _hasBinaryChars(str) {
  for (let i = 0; i < Math.min(str.length, 512); i++) {
    if (str.charCodeAt(i) === 0) return true;
  }
  return false;
}
