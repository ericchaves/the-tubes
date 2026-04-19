import { EventEmitter } from 'node:events';
import { createDebug } from '../debug.js';
import { encodeFrame, createFrameParser, OP_TEXT, OP_PING, OP_PONG, OP_CLOSE } from '../common/ws-framing.js';
import {
  MSG, encode, decode,
  HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS,
} from '../common/control-protocol.js';

const debug = createDebug('server:control');

/**
 * Server-side control channel wrapping one upgraded WebSocket to a tt client.
 *
 * Lifecycle is owned by ServerTunnel: one active ControlSession at a time.
 * When the socket drops, the tunnel starts its reconnect window. A new
 * ControlSession may replace this one (client reconnects); inflight pairs
 * that survived via `REPLACES` preamble are re-attached by the TunnelAgent.
 *
 * Events emitted to ServerTunnel:
 *   'hello'   { controlId, resumeControlId, inflightPairs }
 *   'message' { type, ...frame } — any non-hello control frame
 *   'close'   { reason }
 */
export class ControlSession extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket - the upgraded TCP socket
   */
  constructor(socket) {
    super();
    this.socket = socket;
    this.controlId = null;          // set after hello received
    this.remoteAddr = socket.remoteAddress;
    this.closed = false;
    this.openedAt = Date.now();
    this._lastPongAt = Date.now();
    this._pingTimer = null;

    const parser = createFrameParser({
      onFrame: (opcode, payload) => this._onFrame(opcode, payload),
      onError: msg => this._fail(msg),
    });

    socket.on('data', chunk => parser.push(chunk));
    socket.on('error', () => this._close('socket_error'));
    socket.on('close', () => this._close('socket_closed'));

    this._startHeartbeat();
  }

  /** Send a typed control frame. */
  send(type, data = {}) {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(OP_TEXT, encode(type, data), false));
    } catch (err) {
      debug('send error: %s', err.message);
      this._close('send_error');
    }
  }

  close(reason = 'server_closing') {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0), false));
    } catch {}
    this._close(reason);
  }

  _onFrame(opcode, payload) {
    if (this.closed) return;
    switch (opcode) {
      case OP_PING:
        try { this.socket.write(encodeFrame(OP_PONG, payload, false)); } catch {}
        return;
      case OP_PONG:
        this._lastPongAt = Date.now();
        return;
      case OP_CLOSE:
        this._close('peer_closed');
        return;
      case OP_TEXT: {
        const msg = decode(payload);
        if (!msg) { this._fail('bad frame'); return; }
        if (msg.type === MSG.PONG) {
          this._lastPongAt = Date.now();
          return;
        }
        if (msg.type === MSG.HELLO) {
          this.controlId = msg.controlId;
          this.emit('hello', {
            controlId: msg.controlId,
            resumeControlId: msg.resumeControlId ?? null,
            inflightPairs: Array.isArray(msg.inflightPairs) ? msg.inflightPairs : [],
          });
          return;
        }
        this.emit('message', msg);
        return;
      }
      default:
        // Binary and other opcodes are not used on the control channel.
        return;
    }
  }

  _startHeartbeat() {
    this._pingTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this._lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.emit('heartbeat_timeout', { lastPongAgoMs: Date.now() - this._lastPongAt });
        this._close('heartbeat_timeout');
        return;
      }
      this.send(MSG.PING, { ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
    this._pingTimer.unref();
  }

  _fail(reason) {
    debug('control session fail: %s', reason);
    this._close(reason);
  }

  _close(reason) {
    if (this.closed) return;
    this.closed = true;
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    try { this.socket.destroy(); } catch {}
    this.emit('close', { reason });
  }
}
