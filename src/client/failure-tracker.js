import { createDebug } from '../debug.js';

const debug = createDebug('client:failure');

/**
 * Singleton failure tracker for an expose session.
 * Tracks failures in a sliding time window and as an absolute total.
 * The ONLY source of health reset is onSuccessfulTraffic().
 *
 * Causes of failure tracked:
 *   - 'remoteConnect'  — could not connect to the tunnel server's TCP port
 *   - 'localConnect'   — could not connect to the local service
 *   - 'localDrop'      — local service closed abruptly (RST / error)
 *   - 'remoteDrop'     — tunnel server closed the connection
 */
export class FailureTracker {
  /**
   * @param {object} opts
   * @param {number} opts.windowS - sliding window size in seconds
   * @param {number} opts.maxInWindow - max failures in window before giving up
   * @param {number} opts.maxTotal - hard total cap
   */
  constructor({ windowS = 60, maxInWindow = 10, maxTotal = 50 } = {}) {
    this._windowMs = windowS * 1000;
    this._maxInWindow = maxInWindow;
    this._maxTotal = maxTotal;
    /** @type {number[]} timestamps of recent failures */
    this._timestamps = [];
    this._totalCount = 0;
    /** @type {Record<string, number>} per-kind counts */
    this.recordCount = { remoteConnect: 0, localConnect: 0, localDrop: 0, remoteDrop: 0 };
  }

  /**
   * Record a failure of the given kind.
   * @param {'remoteConnect'|'localConnect'|'localDrop'|'remoteDrop'} kind
   */
  record(kind) {
    const now = Date.now();
    this._timestamps.push(now);
    this._totalCount++;
    if (kind in this.recordCount) this.recordCount[kind]++;
    this._pruneWindow(now);
    debug('failure recorded (kind=%s, inWindow=%d, total=%d)',
      kind, this._timestamps.length, this._totalCount);
  }

  /**
   * Reset tracking after successful traffic.
   * Call this when a request/response pair completes with bytes > 0.
   */
  onSuccessfulTraffic() {
    this._timestamps = [];
    this._totalCount = 0;
    this.recordCount = { remoteConnect: 0, localConnect: 0, localDrop: 0, remoteDrop: 0 };
    debug('failure tracker reset by successful traffic');
  }

  /**
   * @returns {boolean} true if the session should be terminated
   */
  shouldGiveUp() {
    this._pruneWindow(Date.now());
    if (this._totalCount >= this._maxTotal) return true;
    if (this._timestamps.length >= this._maxInWindow) return true;
    return false;
  }

  get totalFailures() { return this._totalCount; }
  get recentFailures() {
    this._pruneWindow(Date.now());
    return this._timestamps.length;
  }

  _pruneWindow(now) {
    const cutoff = now - this._windowMs;
    while (this._timestamps.length > 0 && this._timestamps[0] < cutoff) {
      this._timestamps.shift();
    }
  }
}
