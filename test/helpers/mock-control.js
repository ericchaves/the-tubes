/**
 * Shared mock helpers for testing the on-demand socket architecture.
 *
 * MockControlSession  — server-side: attaches to ServerTunnel and intercepts
 *   pair.open messages, connecting real data sockets with the correct preamble
 *   so the relay logic under test runs end-to-end.
 *
 * MockControlChannel  — client-side: passed as the 5th arg to TunnelCluster.
 *   Emits pair.open messages to trigger on-demand pair creation.
 */

import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';
import { MSG } from '../../src/common/control-protocol.js';

// ─── Server-side ─────────────────────────────────────────────────────────────

/**
 * Stands in for a real ControlSession attached to ServerTunnel.
 *
 * Usage:
 *   const session = new MockControlSession(tunnel.agent._assignedPort);
 *   tunnel.attachControlSession(session);
 *   session.handshake();           // establishes tunnel.connected = true
 *   session.prepareResponse(fn);   // register handler for the next pair
 *   const res = await fetch(url);  // triggers pair.open → data socket → response
 */
export class MockControlSession extends EventEmitter {
  /**
   * @param {number} agentPort - tunnel.agent._assignedPort
   */
  constructor(agentPort) {
    super();
    this.agentPort = agentPort;
    this.closed = false;
    this.remoteAddr = '127.0.0.1';
    this._nextResponse = null;
    this._sockets = new Set();
  }

  /**
   * Called by ServerTunnel to send a control frame.
   * When type === MSG.PAIR_OPEN, connects a data socket with the preamble
   * and calls the registered response handler once the HTTP request arrives.
   */
  send(type, data) {
    if (type !== MSG.PAIR_OPEN) return;
    const { pairId } = data;
    const respondFn = this._nextResponse;
    this._nextResponse = null;

    const sock = netConnect({ host: '127.0.0.1', port: this.agentPort });
    this._sockets.add(sock);
    sock.on('error', () => {});
    sock.once('close', () => this._sockets.delete(sock));

    sock.once('connect', () => {
      sock.write(`TT/1 PAIR ${pairId}\r\n`);
      if (!respondFn) return;

      let buf = Buffer.alloc(0);
      let replied = false;
      sock.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        if (replied) return;
        if (buf.indexOf('\r\n\r\n') === -1) return;
        replied = true;
        const result = respondFn(buf);
        if (!result) return;
        if (typeof result === 'string' || Buffer.isBuffer(result)) {
          sock.write(result);
          sock.end();
        } else if (result.close) {
          sock.end();
        } else if (result.reply) {
          sock.write(result.reply);
          if (!result.keepAlive) sock.end();
        }
      });
    });
  }

  /** Register a response handler for the next incoming pair.open. */
  prepareResponse(fn) { this._nextResponse = fn; }

  /**
   * Trigger the hello handshake so ServerTunnel sets connected = true.
   * Must be called after tunnel.attachControlSession(this).
   */
  handshake(controlId = 'ctrl-test-1') {
    this.emit('hello', { controlId, resumeControlId: null, inflightPairs: [] });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of this._sockets) try { s.destroy(); } catch {}
    this.emit('close', { reason: 'mock_closed' });
  }
}

// ─── Client-side ─────────────────────────────────────────────────────────────

let _pairSeq = 0;

/**
 * Stands in for a real ControlChannel passed to TunnelCluster.
 *
 * Usage:
 *   const control = new MockControlChannel();
 *   const cluster = new TunnelCluster(info, config, tracker, policy, control);
 *   const pairId = control.openPair({ kind: 'http', method: 'POST', path: '/webhook' });
 *   // cluster._openPair is called, connects local + data sockets
 */
export class MockControlChannel extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this._sent = [];
  }

  /** Called by TunnelCluster to report events back (pair.failed, pair.closed). */
  send(type, data) { this._sent.push({ type, data }); }

  /**
   * Simulate a pair.open message arriving from the server.
   * @param {object} [opts]
   * @returns {string} pairId used
   */
  openPair(opts = {}) {
    const pairId = opts.pairId ?? `p${Date.now().toString(36)}${(++_pairSeq).toString(36)}`;
    this.emit('message', {
      type: MSG.PAIR_OPEN,
      pairId,
      requestId: opts.requestId ?? 'req-test-1',
      kind: opts.kind ?? 'http',
      method: opts.method ?? 'POST',
      path: opts.path ?? '/webhook',
    });
    return pairId;
  }
}
