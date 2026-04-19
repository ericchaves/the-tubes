import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createDebug } from '../debug.js';
import {
  encodeFrame, createFrameParser, computeAcceptKey,
  OP_TEXT, OP_PING, OP_PONG, OP_CLOSE,
} from '../common/ws-framing.js';
import {
  MSG, encode, decode,
  HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS,
} from '../common/control-protocol.js';
import { sign as hmacSign } from '../common/hmac.js';

const debug = createDebug('client:control');

/**
 * Client-side control channel: a persistent WebSocket to the server carrying
 * lifecycle messages. Owns reconnection with exponential backoff, heartbeat,
 * and inflight-pair tracking for resume.
 *
 * Events:
 *   'connected'       { controlId }
 *   'resumed'         { controlId, previousControlId, keep, drop }
 *   'message'         { type, ... }  — any non-hello/ack/ping/pong control frame
 *   'disconnected'    { reason }
 *   'heartbeat_timeout' {}
 */
export class ControlChannel extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.serverUrl  — http(s) URL of the API server
   * @param {string} opts.tunnelId
   * @param {string} opts.sessionToken
   * @param {string|null} [opts.hmacSecret]
   * @param {() => string[]} [opts.getInflightPairs]  — called on reconnect
   */
  constructor(opts) {
    super();
    this.serverUrl = opts.serverUrl;
    this.tunnelId = opts.tunnelId;
    this.sessionToken = opts.sessionToken;
    this.hmacSecret = opts.hmacSecret ?? null;
    this.getInflightPairs = opts.getInflightPairs ?? (() => []);

    this.controlId = randomUUID();
    this._previousControlId = null;
    this._socket = null;
    this._connected = false;
    this._closed = false;
    this._lastPongAt = 0;
    this._heartbeatTimer = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
  }

  async connect() {
    if (this._closed) return;
    const url = new URL(this.serverUrl);
    const isTls = url.protocol === 'https:';
    const port = Number(url.port) || (isTls ? 443 : 80);
    const host = url.hostname;
    const path = `/api/tunnels/${this.tunnelId}/control`;
    const wsKey = randomBytes(16).toString('base64');
    const expectedAccept = computeAcceptKey(wsKey);

    const rawSocket = isTls
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });

    await new Promise((resolve, reject) => {
      const onError = err => reject(err);
      rawSocket.once('error', onError);
      const onReady = () => { rawSocket.removeListener('error', onError); resolve(); };
      if (isTls) rawSocket.once('secureConnect', onReady);
      else rawSocket.once('connect', onReady);
    });

    const headers = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${wsKey}`,
      'Sec-WebSocket-Version: 13',
      `X-TT-Session-Token: ${this.sessionToken}`,
    ];
    if (this.hmacSecret) {
      const { header } = hmacSign({ method: 'GET', path, secret: this.hmacSecret });
      headers.push(`X-TT-Auth: ${header}`);
    }
    rawSocket.write(headers.join('\r\n') + '\r\n\r\n');

    // Read 101 response
    let handshakeBuf = Buffer.alloc(0);
    const handshake = await new Promise((resolve, reject) => {
      const onData = chunk => {
        handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
        const sep = handshakeBuf.indexOf('\r\n\r\n');
        if (sep === -1) {
          if (handshakeBuf.length > 8192) { cleanup(); reject(new Error('Handshake too large')); }
          return;
        }
        cleanup();
        const headerText = handshakeBuf.slice(0, sep).toString('utf8');
        const residual = handshakeBuf.slice(sep + 4);
        resolve({ headerText, residual });
      };
      const onError = err => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); reject(new Error('Handshake closed')); };
      const cleanup = () => {
        rawSocket.removeListener('data', onData);
        rawSocket.removeListener('error', onError);
        rawSocket.removeListener('close', onClose);
      };
      rawSocket.on('data', onData);
      rawSocket.once('error', onError);
      rawSocket.once('close', onClose);
    });

    const firstLine = handshake.headerText.split('\r\n')[0];
    if (!firstLine.startsWith('HTTP/1.1 101')) {
      rawSocket.destroy();
      throw new Error(`Control upgrade failed: ${firstLine}`);
    }
    const acceptLine = handshake.headerText
      .split('\r\n')
      .find(l => l.toLowerCase().startsWith('sec-websocket-accept:'));
    const accept = acceptLine?.split(':').slice(1).join(':').trim();
    if (accept !== expectedAccept) {
      rawSocket.destroy();
      throw new Error('Control upgrade: accept key mismatch');
    }

    this._socket = rawSocket;
    this._attachFrameHandling(handshake.residual);
    this._sendHello();
  }

  _attachFrameHandling(initial) {
    const parser = createFrameParser({
      onFrame: (opcode, payload) => this._onFrame(opcode, payload),
      onError: () => this._close('frame_error'),
    });
    this._socket.on('data', chunk => parser.push(chunk));
    this._socket.once('error', () => this._close('socket_error'));
    this._socket.once('close', () => this._close('socket_closed'));
    if (initial.length > 0) parser.push(initial);
  }

  _sendHello() {
    const inflight = this.getInflightPairs();
    this.send(MSG.HELLO, {
      sessionToken: this.sessionToken,
      tunnelId: this.tunnelId,
      controlId: this.controlId,
      resumeControlId: this._previousControlId,
      inflightPairs: inflight,
    });
  }

  send(type, data = {}) {
    if (!this._socket || this._closed) return;
    try {
      this._socket.write(encodeFrame(OP_TEXT, encode(type, data), true));
    } catch (err) {
      debug('send error: %s', err.message);
      this._close('send_error');
    }
  }

  _onFrame(opcode, payload) {
    if (this._closed) return;
    switch (opcode) {
      case OP_PING:
        try { this._socket.write(encodeFrame(OP_PONG, payload, true)); } catch {}
        return;
      case OP_PONG:
        this._lastPongAt = Date.now();
        return;
      case OP_CLOSE:
        this._close('peer_closed');
        return;
      case OP_TEXT: {
        const msg = decode(payload);
        if (!msg) return;
        if (msg.type === MSG.HELLO_ACK) {
          this._connected = true;
          this._reconnectAttempt = 0;
          this._lastPongAt = Date.now();
          this._startHeartbeat();
          if (this._previousControlId) {
            this.emit('resumed', {
              controlId: this.controlId,
              previousControlId: this._previousControlId,
              keep: msg.keep ?? [],
              drop: msg.drop ?? [],
            });
          } else {
            this.emit('connected', { controlId: this.controlId });
          }
          return;
        }
        if (msg.type === MSG.PING) {
          this.send(MSG.PONG, { ts: Date.now() });
          this._lastPongAt = Date.now();
          return;
        }
        if (msg.type === MSG.PONG) { this._lastPongAt = Date.now(); return; }
        this.emit('message', msg);
        return;
      }
      default: return;
    }
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (!this._connected) return;
      if (Date.now() - this._lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.emit('heartbeat_timeout', {});
        this._close('heartbeat_timeout');
        return;
      }
      this.send(MSG.PING, { ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
    this._heartbeatTimer.unref();
  }

  _close(reason) {
    if (!this._connected && !this._socket) return;
    const wasConnected = this._connected;
    this._connected = false;
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._socket) { try { this._socket.destroy(); } catch {} this._socket = null; }
    if (wasConnected) this.emit('disconnected', { reason });
    if (!this._closed) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const base = Math.min(30_000, 1000 * Math.pow(2, this._reconnectAttempt));
    const jitter = Math.random() * 500;
    const delay = base + jitter;
    this._reconnectAttempt++;
    debug('reconnecting control in %dms (attempt %d)', Math.round(delay), this._reconnectAttempt);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._closed) return;
      this._previousControlId = this.controlId;
      this.controlId = randomUUID();
      try {
        await this.connect();
      } catch (err) {
        debug('reconnect failed: %s', err.message);
        this._scheduleReconnect();
      }
    }, delay);
    this._reconnectTimer.unref();
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._socket) {
      try { this._socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0), true)); } catch {}
      try { this._socket.destroy(); } catch {}
      this._socket = null;
    }
    this._connected = false;
  }

  get connected() { return this._connected; }
}
