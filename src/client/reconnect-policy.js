import { createDebug } from '../debug.js';

const debug = createDebug('client:reconnect');

/**
 * Singleton backoff policy for an expose session.
 * The ONLY source of reset is onSuccessfulTraffic().
 * Backoff is NOT reset by "a socket opened" — only by actual traffic.
 */
export class ReconnectPolicy {
  /**
   * @param {object} opts
   * @param {number} opts.initialDelayMs
   * @param {number} opts.maxDelayMs
   * @param {number} opts.multiplier
   */
  constructor({ initialDelayMs = 1000, maxDelayMs = 30_000, multiplier = 2 } = {}) {
    this._initial = initialDelayMs;
    this._max = maxDelayMs;
    this._multiplier = multiplier;
    this._current = initialDelayMs;
  }

  /**
   * Return the current delay and advance to the next (exponential backoff).
   * @returns {number} milliseconds to wait before next attempt
   */
  nextDelay() {
    const delay = this._current;
    this._current = Math.min(this._current * this._multiplier, this._max);
    debug('backoff delay: %dms (next: %dms)', delay, this._current);
    return delay;
  }

  /**
   * Reset the backoff to initial delay.
   * Should only be called by onSuccessfulTraffic().
   */
  reset() {
    this._current = this._initial;
    debug('backoff reset to %dms', this._initial);
  }

  get currentDelay() { return this._current; }
}
