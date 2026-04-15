import { createDebug } from '../../debug.js';

const debug = createDebug('client:admin');
let _seq = 0;

/**
 * Client-side event ring buffer + SSE broadcaster.
 *
 * Event shape: { seq, ts, type, ...typeSpecificFields }
 *
 * Types pushed by index.js:
 *   expose.started       { serverUrl, localAddress, localPort, tunnelSubdomain }
 *   tunnel.open          { tunnelId, publicUrl, maxConnections }
 *   tunnel.closed        { reason }
 *   pair.open            { pairId }
 *   pair.dead            { pairId, reason, kind, retriable }
 *   local.down           { address, port }
 *   local.up             { address, port }
 *   request              { method, path, status }
 *   capture.saved        { captureId, file, method, path }
 *   failure.recorded     { kind, totalFailures, recentFailures }
 *   reconnect.scheduled  { delayMs }
 *   expose.exit          { code, reason }
 *   replay.started       { manifest, steps, target }
 *   replay.step          { manifest, stepIndex, total, method, url, status, durationMs }
 *   replay.step.error    { manifest, stepIndex, total, method, url, error }
 *   replay.completed     { manifest, durationMs }
 *   replay.error         { manifest, error }
 */
export class ClientEventLog {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSize=200]
   */
  constructor({ maxSize = 200 } = {}) {
    this._max = maxSize;
    this._events = [];
    this._sseClients = new Set();
  }

  /**
   * Record an event and broadcast it to SSE subscribers.
   * @param {string} type
   * @param {object} [data]
   * @returns {object} the recorded event
   */
  push(type, data = {}) {
    const event = { seq: ++_seq, ts: new Date().toISOString(), type, ...data };
    this._events.push(event);
    if (this._events.length > this._max) this._events.shift();
    for (const res of this._sseClients) _sseWrite(res, event);
    debug('%s', type);
    return event;
  }

  /**
   * Subscribe an HTTP response to receive SSE events.
   * Sends initEvent first (state snapshot), then full history, then live events.
   * @param {object} res - http.ServerResponse
   * @param {object|null} initEvent - sent before history (state snapshot)
   */
  addSseClient(res, initEvent = null) {
    this._sseClients.add(res);
    res.once('close', () => this._sseClients.delete(res));
    if (initEvent) _sseWrite(res, initEvent);
    for (const e of this._events) _sseWrite(res, e);
  }

  get events() { return [...this._events]; }
  get size() { return this._events.length; }
}

function _sseWrite(res, event) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
}
