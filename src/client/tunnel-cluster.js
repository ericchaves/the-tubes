import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createDebug } from '../debug.js';
import { HeaderHostTransformer } from './header-host-transformer.js';
import { HttpInspector } from './http-inspector.js';

const debug = createDebug('client:cluster');

/**
 * @typedef {object} SocketPair
 * @property {import('node:net').Socket} remote - connection to tunnel server's TCP port
 * @property {import('node:net').Socket|import('node:tls').TLSSocket} local - connection to local service
 * @property {string} id
 */

/**
 * TunnelCluster manages the pool of socket pairs (remote↔local).
 *
 * Key design principle (§3.4 R4-R6):
 * - openOne() opens exactly one pair and returns Promise<SocketPair>
 * - When a pair dies for any reason, it emits 'tunnel:dead' with {reason,kind,retriable}
 * - It does NOT reopen — the Tunnel controller decides
 * - No recursive retry loops inside connLocal()
 *
 * Events:
 *   'open' — a new pair opened successfully (socket pair)
 *   'tunnel:dead' — a pair died { reason, kind, retriable, pairId }
 *   'request' — a request was proxied { method, path, status }
 */
export class TunnelCluster extends EventEmitter {
  /**
   * @param {object} info - tunnel info from server
   * @param {object} config - expose config
   * @param {import('./failure-tracker.js').FailureTracker} failureTracker
   * @param {import('./reconnect-policy.js').ReconnectPolicy} reconnectPolicy
   */
  constructor(info, config, failureTracker, reconnectPolicy) {
    super();
    this.info = info;
    this.config = config;
    this.failureTracker = failureTracker;
    this.reconnectPolicy = reconnectPolicy;
    /** @type {Set<SocketPair>} */
    this.pairs = new Set();
    this._closed = false;
    this._pairCounter = 0;
    this._inspector = config.captureDir
      ? new HttpInspector({ captureDir: config.captureDir, tunnelId: info.tunnelId, maxBodyKb: config.captureMaxBodyKb })
      : null;
  }

  /**
   * Open exactly one remote↔local socket pair.
   * @returns {Promise<void>} resolves when the remote connection is established
   */
  openOne() {
    return new Promise((resolve, reject) => {
      if (this._closed) return reject(new Error('TunnelCluster closed'));

      const pairId = `pair-${++this._pairCounter}`;
      debug('[%s] opening (host=%s, port=%d)', pairId, this.info.tunnelHost, this.info.tunnelPort);

      const remote = netConnect({
        host: this.info.tunnelHost,
        port: this.info.tunnelPort,
        allowHalfOpen: true,
      });

      let deadEmitted = false;

      const emitDead = (reason, kind, retriable = true) => {
        if (deadEmitted) return;
        deadEmitted = true;
        this.pairs.delete(pair);
        debug('[%s] dead (reason=%s, kind=%s, retriable=%s)', pairId, reason, kind, retriable);
        this.emit('tunnel:dead', { reason, kind, retriable, pairId });
      };

      const pair = { remote, local: null, id: pairId };

      remote.once('error', (err) => {
        this.failureTracker.record('remoteConnect');
        emitDead(err.code || err.message, 'remoteConnect', true);
        reject(err);
      });

      remote.once('close', () => {
        // Ensure local closes too so local.once('close') fires for capture.
        // This matters for WebSocket sessions where handleUpgrade uses socket.destroy(),
        // which doesn't emit 'end' — the pipe never propagates to local.end().
        if (pair.local && !pair.local.destroyed) pair.local.destroy();
        emitDead('remote-closed', 'remoteDrop', true);
      });

      remote.once('connect', () => {
        debug('[%s] remote connected', pairId);
        this._connectLocal(pair, emitDead);
        this.pairs.add(pair);
        resolve();
        this.emit('open', pair);
      });
    });
  }

  /**
   * Connect to local service for an established remote socket.
   */
  _connectLocal(pair, emitDead) {
    const { config, info } = this;
    const { remote } = pair;

    let local;
    if (config.localTls) {
      const tlsOpts = {
        host: config.localAddress,
        port: config.localPort,
        rejectUnauthorized: !config.allowInsecureLocalTls,
      };
      if (config.localTlsCert) tlsOpts.cert = readFileSync(config.localTlsCert);
      if (config.localTlsKey) tlsOpts.key = readFileSync(config.localTlsKey);
      if (config.localTlsCa) tlsOpts.ca = readFileSync(config.localTlsCa);
      local = tlsConnect(tlsOpts);
    } else {
      local = netConnect({
        host: config.localAddress,
        port: config.localPort,
        allowHalfOpen: true,
      });
    }

    pair.local = local;
    let bytesTransferred = 0;
    // Guard: when a socket error fires, the 'close' event fires immediately after
    // with hadError=true. Without this flag we'd double-count the failure in
    // FailureTracker (once for 'error', once for 'close'), which can prematurely
    // trigger reconnect_loop_detected on a single app crash.
    let localErrorHandled = false;

    // Buffers for request/response: always collected to enable 'request' event.
    // Inspector uses full body limit; without inspector we only need enough for headers.
    const maxCollect = this._inspector
      ? (config.captureMaxBodyKb ?? 1024) * 1024 + 8192
      : 4096;
    const reqBufs = [], resBufs = [];
    let reqTotal = 0, resTotal = 0;

    local.once('error', (err) => {
      localErrorHandled = true;
      // ECONNREFUSED means the local app is temporarily down — the port is not
      // accepting connections yet. Do NOT charge this against the reconnect
      // budget (FailureTracker); just let the backoff policy handle the cadence.
      // Other errors (ECONNRESET, ETIMEDOUT, etc.) are genuine failures and do
      // count against the budget.
      if (err.code !== 'ECONNREFUSED') {
        this.failureTracker.record('localConnect');
      }
      // R6: Do NOT loop — emit dead and let Tunnel decide.
      // ECONNREFUSED is retriable: the local app may come back up.
      emitDead(err.code || err.message, 'localConnect',
        config.reconnectLocal !== false);
      remote.destroy();
    });

    local.once('connect', () => {
      debug('[%s] local connected (%s:%d)', pair.id, config.localAddress, config.localPort);

      // Pipe remote ↔ local with optional Host header rewriting
      let remoteToLocal;
      if (config.rewriteHostHeader !== false) {
        const transformer = new HeaderHostTransformer(
          `${config.localAddress}:${config.localPort}`
        );
        remote.pipe(transformer).pipe(local);
        remoteToLocal = transformer;
      } else {
        remote.pipe(local);
        remoteToLocal = remote;
      }
      local.pipe(remote);

      // Track bytes for health reset and collect data for request event + captures.
      // Node.js streams fan-out data events to all listeners — the pipe is unaffected.
      remote.on('data', chunk => {
        bytesTransferred += chunk.length;
        if (reqTotal < maxCollect) { reqBufs.push(chunk); reqTotal += chunk.length; }
      });
      local.on('data', chunk => {
        bytesTransferred += chunk.length;
        if (resTotal < maxCollect) { resBufs.push(chunk); resTotal += chunk.length; }
      });

      // WebSocket capture: fire when remote receives EOF (server gracefully closed its side).
      // local.once('close') may not fire during WS sessions due to half-open socket behavior,
      // so we capture here instead. For HTTP sessions, reqBufs won't contain an upgrade header.
      remote.once('end', () => {
        const reqMsg = _parseHttpMsg(Buffer.concat(reqBufs));
        if (!reqMsg) return;
        const isWebSocket = reqMsg.headers['upgrade']?.toLowerCase() === 'websocket';
        if (!isWebSocket) return;

        const parts = reqMsg.firstLine.split(' ');
        const path = parts[1];
        this.emit('request', { method: 'WS', path, status: 101 });

        if (this._inspector && path) {
          const resMsg = _parseHttpMsg(Buffer.concat(resBufs));
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

        // Prevent duplicate capture in local.once('close')
        reqBufs.length = 0;
      });
    });

    local.once('close', (hadError) => {
      if (bytesTransferred > 0) {
        // Successful traffic — reset health trackers
        this.failureTracker.onSuccessfulTraffic();
        this.reconnectPolicy.reset();
        debug('[%s] local closed cleanly after %d bytes — health reset', pair.id, bytesTransferred);
      }

      // Emit request event (always) and capture (when inspector configured).
      const reqMsg = _parseHttpMsg(Buffer.concat(reqBufs));
      if (reqMsg) {
        const parts = reqMsg.firstLine.split(' ');
        const method = parts[0];
        const path = parts[1];
        const isWebSocket = reqMsg.headers['upgrade']?.toLowerCase() === 'websocket';

        if (isWebSocket) {
          this.emit('request', { method: 'WS', path, status: 101 });

          if (this._inspector && path) {
            const resMsg = _parseHttpMsg(Buffer.concat(resBufs));
            const clientFrames = _parseWsFrames(reqMsg.body, true);
            const serverFrames = resMsg ? _parseWsFrames(resMsg.body, false) : [];
            const frames = [...clientFrames, ...serverFrames];

            const captureId = this._inspector.captureWebSocket({
              path,
              reqHeaders: reqMsg.headers,
              frames,
            });
            this.emit('capture', {
              captureId,
              file: `${info.tunnelId}.${captureId}.ws.yaml`,
              method: 'WS',
              path,
            });
          }
        } else {
          const resMsg = _parseHttpMsg(Buffer.concat(resBufs));
          const status = resMsg ? parseInt(resMsg.firstLine.split(' ')[1], 10) : null;

          this.emit('request', { method, path, status });

          if (this._inspector && method && path) {
            const captureId = this._inspector.captureRequest({
              method, path, headers: reqMsg.headers, body: reqMsg.body,
            });
            if (resMsg) {
              this._inspector.captureResponse({
                status, headers: resMsg.headers, body: resMsg.body,
              }, captureId);
            }
            this.emit('capture', {
              captureId,
              file: `${info.tunnelId}.${captureId}.req.yaml`,
              method,
              path,
            });
          }
        }
      }

      if (hadError) {
        // Only record if the 'error' handler didn't already record this failure.
        // Node.js always fires 'close' after 'error' on a socket, so without
        // this guard we double-count every socket error in FailureTracker.
        if (!localErrorHandled) {
          this.failureTracker.record('localDrop');
        }
        emitDead('local-closed-error', 'localDrop', config.reconnectLocal !== false);
      } else {
        emitDead('local-closed-clean', 'localDrop', true);
      }
      remote.end();
    });
  }

  close() {
    this._closed = true;
    for (const pair of this.pairs) {
      if (pair.remote) pair.remote.destroy();
      if (pair.local) pair.local.destroy();
    }
    this.pairs.clear();
  }
}

/**
 * Parse RFC 6455 WebSocket frames from a raw buffer.
 * Returns an array of frame objects suitable for YAML capture.
 * @param {Buffer} buf - raw bytes after the HTTP upgrade body
 * @param {boolean} isClient - true for client→server (masked), false for server→client
 * @returns {Array<{dir:string, opcode:number, encoding:string, data:string}>}
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
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (offset + 8 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (offset + 4 > buf.length) break;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (offset + payloadLen > buf.length) break;
    let payload = buf.slice(offset, offset + payloadLen);
    offset += payloadLen;

    if (masked && maskKey) {
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ maskKey[i % 4];
      }
      payload = unmasked;
    }

    // Skip continuation (0) and connection-level control we can't replay
    if (opcode === 0) continue;

    const dir = isClient ? 'client' : 'server';
    const text = payload.toString('utf8');
    const isBinary = opcode === 2 || _hasBinaryChars(text);

    frames.push({
      dir,
      opcode,
      encoding: isBinary ? 'base64' : 'utf8',
      data: isBinary ? payload.toString('base64') : text,
    });
  }

  return frames;
}

/**
 * Parse a raw HTTP message buffer into its first line, headers, and body.
 * Returns null if the header section is not yet complete.
 * @param {Buffer} buf
 * @returns {{ firstLine: string, headers: Record<string,string>, body: Buffer }|null}
 */
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
