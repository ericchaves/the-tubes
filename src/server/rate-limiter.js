/**
 * IP-based sliding-window rate limiter for tunnel_not_found responses.
 *
 * Each IP gets a hit counter within a rolling time window. When the counter
 * exceeds `maxHits` the IP is temporarily blocked for `blockDurationMs`.
 * Blocked IPs that call hit() stay blocked (their block timer is NOT reset).
 *
 * Emits events to an optional GlobalEventLog:
 *   ip.blocked          { ip, reason:'auto', threshold, windowMs, blockedUntil }
 *   ip.unblocked        { ip, reason:'expired' }
 *   server.request_blocked { ip, method, host, reason:'rate_limited' }
 *
 * The `server.request_blocked` event is throttled to at most 1 per IP per
 * `blockEventThrottleMs` to avoid flooding the event log.
 */

import { createDebug } from '../debug.js';

const debug = createDebug('server:rate-limiter');

export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} [opts.windowMs=60_000]          Rolling window duration
   * @param {number} [opts.maxHits=30]               Max tunnel_not_found hits before block
   * @param {number} [opts.blockDurationMs=300_000]  How long to block after exceeding limit
   * @param {number} [opts.gcIntervalMs]             GC interval (default: windowMs * 2)
   * @param {number} [opts.blockEventThrottleMs=30_000] Min ms between block-log events per IP
   * @param {import('./admin/event-log.js').GlobalEventLog} [opts.globalLog]
   */
  constructor({
    windowMs = 60_000,
    maxHits = 30,
    blockDurationMs = 300_000,
    gcIntervalMs,
    blockEventThrottleMs = 30_000,
    globalLog = null,
  } = {}) {
    this._windowMs = windowMs;
    this._maxHits = maxHits;
    this._blockDurationMs = blockDurationMs;
    this._blockEventThrottleMs = blockEventThrottleMs;
    this._globalLog = globalLog;

    /** @type {Map<string, { count: number, windowStart: number }>} */
    this._hits = new Map();
    /** @type {Map<string, number>} ip → unblock timestamp */
    this._blocked = new Map();
    /** @type {Map<string, number>} ip → last block-event timestamp (throttle) */
    this._lastBlockEvent = new Map();

    this._gcInterval = setInterval(
      () => this._gc(),
      gcIntervalMs ?? windowMs * 2,
    );
    // Don't hold the process open
    this._gcInterval.unref?.();
  }

  /**
   * Record a hit for this IP.
   * @param {string} ip  Normalized IP address
   * @param {object} [reqMeta]  Optional { method, host } for event logging
   * @returns {boolean} true if the IP should be blocked (429)
   */
  hit(ip, reqMeta = {}) {
    const now = Date.now();

    // Already blocked?
    const unblockAt = this._blocked.get(ip);
    if (unblockAt !== undefined) {
      if (now < unblockAt) {
        this._emitRequestBlocked(ip, reqMeta, now);
        return true;
      }
      // Block expired — clean up and fall through to counting
      this._blocked.delete(ip);
      this._globalLog?.push('ip.unblocked', { ip, reason: 'expired' });
      debug('auto-block expired for %s', ip);
    }

    // Sliding window hit counting
    let rec = this._hits.get(ip);
    if (!rec || now - rec.windowStart > this._windowMs) {
      rec = { count: 0, windowStart: now };
      this._hits.set(ip, rec);
    }
    rec.count++;

    if (rec.count > this._maxHits) {
      const blockedUntil = now + this._blockDurationMs;
      this._blocked.set(ip, blockedUntil);
      this._hits.delete(ip);
      this._globalLog?.push('ip.blocked', {
        ip,
        reason: 'auto',
        threshold: this._maxHits,
        windowMs: this._windowMs,
        blockedUntil: new Date(blockedUntil).toISOString(),
      });
      debug('auto-blocking %s until %s', ip, new Date(blockedUntil).toISOString());
      this._emitRequestBlocked(ip, reqMeta, now);
      return true;
    }

    return false;
  }

  /**
   * Manually unblock an IP (admin action).
   * @param {string} ip
   * @returns {boolean} true if the IP was blocked and is now unblocked
   */
  unblock(ip) {
    if (!this._blocked.has(ip)) return false;
    this._blocked.delete(ip);
    this._hits.delete(ip);
    this._lastBlockEvent.delete(ip);
    this._globalLog?.push('ip.unblocked', { ip, reason: 'manual' });
    debug('manually unblocked %s', ip);
    return true;
  }

  /**
   * List all currently blocked IPs.
   * @returns {Array<{ ip: string, blockedUntil: string }>}
   */
  listBlocked() {
    const now = Date.now();
    const result = [];
    for (const [ip, until] of this._blocked) {
      if (until > now) {
        result.push({ ip, blockedUntil: new Date(until).toISOString() });
      }
    }
    return result;
  }

  destroy() {
    clearInterval(this._gcInterval);
    this._hits.clear();
    this._blocked.clear();
    this._lastBlockEvent.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _emitRequestBlocked(ip, { method, host } = {}, now) {
    if (!this._globalLog) return;
    const last = this._lastBlockEvent.get(ip) ?? 0;
    if (now - last < this._blockEventThrottleMs) return;
    this._lastBlockEvent.set(ip, now);
    this._globalLog.push('server.request_blocked', {
      ip,
      method: method ?? '?',
      host: host ?? '?',
      reason: 'rate_limited',
    });
  }

  _gc() {
    const now = Date.now();
    for (const [ip, until] of this._blocked) {
      if (until <= now) this._blocked.delete(ip);
    }
    for (const [ip, rec] of this._hits) {
      if (now - rec.windowStart > this._windowMs) this._hits.delete(ip);
    }
    for (const [ip, ts] of this._lastBlockEvent) {
      if (now - ts > this._blockDurationMs) this._lastBlockEvent.delete(ip);
    }
  }
}
