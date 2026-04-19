import { createDebug } from '../../debug.js';

const debug = createDebug('server:admin');
let _seq = 0;

// Header values to redact when logging requests
const REDACT = new Set([
  'authorization', 'cookie', 'set-cookie',
  'x-tt-auth', 'x-tt-session-token',
  'x-hub-signature', 'x-hub-signature-256',
  'x-api-key', 'x-amz-security-token',
]);

/**
 * Mask sensitive header values, preserving header names for diagnostics.
 * @param {Record<string, string|string[]>} headers
 * @returns {Record<string, string>}
 */
export function maskHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT.has(k.toLowerCase())
      ? '[redacted]'
      : Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/**
 * Per-tunnel event ring buffer + SSE broadcaster.
 *
 * Event shape:
 *   { seq, ts, type, tunnelId, ...typeSpecificFields }
 *
 * Types emitted by ServerTunnel:
 *   tunnel.created       { port, maxConnections, reconnectWindowMs, sessionTokenPrefix }
 *   tunnel.window_expired {}
 *   tunnel.destroyed     {}
 *   control.connected    { controlId, remoteAddr, keptPairs, droppedPairs }
 *   control.resumed      { controlId, previousControlId, remoteAddr, keptPairs, droppedPairs }
 *   control.disconnected { controlId, reason, durationMs, inflightPairs }
 *   control.heartbeat_timeout { controlId, lastPongAgoMs }
 *   pair.requested       { pairId, requestId, kind, method, path, remoteAddr }
 *   pair.opened          { pairId, requestId }
 *   pair.replaced        { pairId, previousControlId }
 *   pair.local_refused   { pairId, requestId, reason }
 *   pair.closed          { pairId, requestId, reason, bytesIn, bytesOut, durationMs }
 *   request.received     { requestId, method, path, headers }
 *   request.delivered    { requestId, method, path, pairId }
 *   request.failed       { requestId, method, path, reason, statusSent }
 *   response.complete    { requestId, method, path, status, bytesIn, bytesOut, durationMs }
 *   response.aborted     { requestId, method, path, reason, status, bytesIn, bytesOut, durationMs }
 *   ws.received          { requestId, path, remoteAddr }
 *   ws.delivered         { requestId, path, pairId }
 *   ws.failed            { requestId, path, reason }
 *   ws.closed            { requestId, path, reason, bytesIn, bytesOut, durationMs }
 *
 * Types emitted directly by the server to GlobalEventLog (tunnelId: '__global__'):
 *   server.error         { reason, statusSent, method?, path?, host?, detail? }
 *     reason: 'tunnel_not_found' | 'internal_error' | 'auth_rejected' | 'bad_request'
 */
export class EventLog {
  /**
   * @param {string} tunnelId
   * @param {number} [maxEvents=500]
   */
  constructor(tunnelId, maxEvents = 500) {
    this.tunnelId = tunnelId;
    this._max = maxEvents;
    this._events = [];
    this._sseClients = new Set();
    this._forwarders = new Set();
  }

  /**
   * Record an event and broadcast it to all subscribers.
   * @param {string} type
   * @param {object} [data]
   * @returns {object} the recorded event
   */
  push(type, data = {}) {
    const event = {
      seq: ++_seq,
      ts: new Date().toISOString(),
      type,
      tunnelId: this.tunnelId,
      ...data,
    };
    this._events.push(event);
    if (this._events.length > this._max) this._events.shift();
    this._notify(event);
    debug('[%s] %s', this.tunnelId, type);
    return event;
  }

  /**
   * Subscribe an HTTP response to receive SSE events.
   * Sends the full history immediately, then live events.
   */
  addSseClient(res) {
    this._sseClients.add(res);
    res.once('close', () => this._sseClients.delete(res));
    for (const e of this._events) _sseWrite(res, e);
  }

  /**
   * Add a forwarder function called on every new event (used by GlobalEventLog).
   * @param {function(object): void} fn
   */
  addForwarder(fn) {
    this._forwarders.add(fn);
  }

  removeForwarder(fn) {
    this._forwarders.delete(fn);
  }

  _notify(event) {
    for (const res of this._sseClients) _sseWrite(res, event);
    for (const fn of this._forwarders) fn(event);
  }

  get events() { return [...this._events]; }
  get subscriberCount() { return this._sseClients.size; }

  destroy() {
    for (const res of this._sseClients) { try { res.end(); } catch {} }
    this._sseClients.clear();
    this._events.length = 0;
    this._forwarders.clear();
  }
}

/**
 * Global event log: aggregates events from all tunnels + tunnel lifecycle events.
 * Tunnel events are forwarded here via EventLog.addForwarder().
 */
export class GlobalEventLog extends EventLog {
  constructor() {
    super('__global__', 1000);
  }

  /**
   * Accept an already-created event from a per-tunnel log.
   * Preserves original seq/ts; does not re-notify the source tunnel's subscribers.
   */
  forward(event) {
    this._events.push(event);
    if (this._events.length > this._max) this._events.shift();
    for (const res of this._sseClients) _sseWrite(res, event);
    for (const fn of this._forwarders) fn(event);
  }
}

function _sseWrite(res, event) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
}
