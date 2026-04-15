/**
 * In-memory nonce cache for HMAC anti-replay protection.
 * TTL is derived from hmacClockSkewToleranceS × 4.
 */
export class NonceCache {
  /** @param {{ ttlS?: number, cleanupIntervalMs?: number }} opts */
  constructor({ ttlS = 240, cleanupIntervalMs = 60_000 } = {}) {
    this._ttlMs = ttlS * 1000;
    /** @type {Map<string, number>} nonce → expiresAt (ms) */
    this._cache = new Map();
    this._timer = setInterval(() => this._cleanup(), cleanupIntervalMs);
    this._timer.unref();
  }

  /**
   * Check if nonce is already seen (replay) and record it.
   * @param {string} nonce
   * @returns {boolean} true if nonce was already seen (replay attack)
   */
  isSeen(nonce) {
    const now = Date.now();
    const exp = this._cache.get(nonce);
    if (exp !== undefined && exp > now) return true;
    this._cache.set(nonce, now + this._ttlMs);
    return false;
  }

  _cleanup() {
    const now = Date.now();
    for (const [nonce, exp] of this._cache) {
      if (exp <= now) this._cache.delete(nonce);
    }
  }

  destroy() {
    clearInterval(this._timer);
    this._cache.clear();
  }
}
