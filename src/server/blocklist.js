/**
 * IP blocklist manager.
 *
 * Manages two layers of IP blocking:
 *   - Temporary blocks: delegated to RateLimiter (in-memory, auto-expire)
 *   - Permanent blocks: stored in <dataDir>/blocklist.json, survive restarts
 *
 * Permanently blocked IPs are rejected with 403 before the rate limiter runs,
 * so they don't pollute the rate-limit counters.
 *
 * Emits events to an optional GlobalEventLog:
 *   ip.added_permanent   { ip }
 *   ip.removed_permanent { ip }
 *   server.request_blocked { ip, method, host, reason:'permanent_block' }
 *
 * The `server.request_blocked` event for permanent blocks is throttled to at
 * most 1 per IP per `blockEventThrottleMs` (default 30s).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeIp } from '../common/http-utils.js';
import { createDebug } from '../debug.js';

const debug = createDebug('server:blocklist');

export class BlocklistManager {
  /**
   * @param {object} opts
   * @param {string}  opts.dataDir                    Directory where blocklist.json is stored
   * @param {number}  [opts.blockEventThrottleMs=30_000]
   * @param {import('./admin/event-log.js').GlobalEventLog} [opts.globalLog]
   */
  constructor({ dataDir, blockEventThrottleMs = 30_000, globalLog = null }) {
    this._filePath = join(dataDir, 'blocklist.json');
    this._blockEventThrottleMs = blockEventThrottleMs;
    this._globalLog = globalLog;

    /** @type {Set<string>} normalized IPs */
    this._permanent = new Set();
    /** @type {Map<string, number>} ip → last block-event timestamp */
    this._lastBlockEvent = new Map();

    this._load();
  }

  /**
   * Check if an IP is permanently blocked.
   * @param {string} ip  Already-normalized IP
   * @returns {boolean}
   */
  isPermanentlyBlocked(ip) {
    return this._permanent.has(ip);
  }

  /**
   * Add an IP to the permanent blocklist.
   * @param {string} ip  Raw or normalized IP
   * @returns {boolean} true if the IP was added (false if already present)
   */
  addPermanent(ip) {
    ip = normalizeIp(ip);
    if (this._permanent.has(ip)) return false;
    this._permanent.add(ip);
    this._persist();
    this._globalLog?.push('ip.added_permanent', { ip });
    debug('permanently blocked %s', ip);
    return true;
  }

  /**
   * Remove an IP from the permanent blocklist.
   * @param {string} ip  Raw or normalized IP
   * @returns {boolean} true if the IP was removed (false if not found)
   */
  removePermanent(ip) {
    ip = normalizeIp(ip);
    if (!this._permanent.has(ip)) return false;
    this._permanent.delete(ip);
    this._lastBlockEvent.delete(ip);
    this._persist();
    this._globalLog?.push('ip.removed_permanent', { ip });
    debug('removed permanent block for %s', ip);
    return true;
  }

  /**
   * List all permanently blocked IPs.
   * @returns {string[]}
   */
  listPermanent() {
    return [...this._permanent];
  }

  /**
   * Emit a throttled `server.request_blocked` event for a permanently blocked IP.
   * Call this when a request is rejected due to permanent block.
   * @param {string} ip
   * @param {{ method?: string, host?: string }} [reqMeta]
   */
  emitRequestBlocked(ip, { method, host } = {}) {
    if (!this._globalLog) return;
    const now = Date.now();
    const last = this._lastBlockEvent.get(ip) ?? 0;
    if (now - last < this._blockEventThrottleMs) return;
    this._lastBlockEvent.set(ip, now);
    this._globalLog.push('server.request_blocked', {
      ip,
      method: method ?? '?',
      host: host ?? '?',
      reason: 'permanent_block',
    });
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _load() {
    if (!existsSync(this._filePath)) {
      debug('no blocklist file found at %s — starting empty', this._filePath);
      return;
    }
    try {
      const raw = readFileSync(this._filePath, 'utf8');
      const data = JSON.parse(raw);
      const ips = Array.isArray(data?.permanent) ? data.permanent : [];
      for (const ip of ips) {
        const norm = normalizeIp(ip);
        if (norm && norm !== 'unknown') this._permanent.add(norm);
      }
      debug('loaded %d permanent blocked IPs from %s', this._permanent.size, this._filePath);
    } catch (err) {
      debug('failed to load blocklist from %s: %s', this._filePath, err.message);
    }
  }

  _persist() {
    try {
      mkdirSync(join(this._filePath, '..'), { recursive: true });
      writeFileSync(
        this._filePath,
        JSON.stringify({ permanent: [...this._permanent] }, null, 2),
        'utf8',
      );
    } catch (err) {
      debug('failed to persist blocklist: %s', err.message);
    }
  }
}
