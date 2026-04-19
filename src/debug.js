import { formatWithOptions } from 'node:util';

const _fmt = (...args) => formatWithOptions({ colors: false }, ...args);
const _now = () => new Date().toISOString();

// Convert a NODE_DEBUG-style comma-separated glob pattern to a RegExp.
// 'tt:*'            → /^(tt:.*)$/
// 'tt:server,tt:client:*' → /^(tt:server|tt:client:.*)$/
function _patternToRegex(pattern) {
  if (!pattern) return null;
  const parts = pattern.split(',').map(p => p.trim()).filter(Boolean).map(p =>
    p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  );
  return parts.length ? new RegExp('^(' + parts.join('|') + ')$') : null;
}

class DebugManager {
  constructor() {
    // Honour NODE_DEBUG at startup — extract only tt: namespaces (plus bare '*')
    const env = process.env.NODE_DEBUG ?? '';
    const entries = env.split(',').map(s => s.trim()).filter(Boolean);
    const hasGlob = entries.includes('*');
    const ttEntries = hasGlob ? ['tt:*'] : entries.filter(s => s.startsWith('tt:'));
    this._enabled = ttEntries.length > 0;
    this._pattern = ttEntries.join(',') || 'tt:*';
    this._regex = this._enabled ? _patternToRegex(this._pattern) : null;
    this._buf = [];
    this._max = 500;
    this._sseClients = new Set();
    this._seq = 0;
  }

  /**
   * Return a debug function bound to the given namespace.
   * The returned function is a no-op when debug is disabled or the namespace
   * does not match the active pattern.
   * @param {string} ns  namespace suffix (e.g. 'server', 'client:tunnel')
   * @returns {Function}
   */
  createDebug(ns) {
    const fullNs = `tt:${ns}`;
    return (...args) => {
      if (!this._enabled || !this._matches(fullNs)) return;
      const msg = _fmt(...args);
      const entry = { seq: ++this._seq, ts: _now(), ns: fullNs, msg };
      this._buf.push(entry);
      if (this._buf.length > this._max) this._buf.shift();
      process.stderr.write(`${fullNs} ${msg}\n`);
      for (const res of this._sseClients) _sseWrite(res, { type: 'debug.log', ...entry });
    };
  }

  /**
   * Change the active debug level at runtime.
   * Broadcasts a 'debug.changed' event to all connected SSE clients.
   * @param {boolean} enabled
   * @param {string}  [pattern='tt:*']  comma-separated glob pattern
   */
  setLevel(enabled, pattern = 'tt:*') {
    this._enabled = enabled;
    this._pattern = pattern;
    this._regex = enabled ? _patternToRegex(pattern) : null;
    const notice = { type: 'debug.changed', seq: ++this._seq, ts: _now(), enabled, pattern };
    for (const res of this._sseClients) _sseWrite(res, notice);
  }

  /**
   * Subscribe an HTTP response to the debug SSE stream.
   * Sends current state + full history, then live entries.
   * @param {import('node:http').ServerResponse} res
   */
  addSseClient(res) {
    this._sseClients.add(res);
    res.once('close', () => this._sseClients.delete(res));
    _sseWrite(res, { type: 'debug.state', seq: this._seq, ts: _now(), enabled: this._enabled, pattern: this._pattern });
    for (const e of this._buf) _sseWrite(res, { type: 'debug.log', ...e });
  }

  /** Clear the ring buffer and broadcast 'debug.cleared' to SSE clients. */
  clear() {
    this._buf.length = 0;
    const notice = { type: 'debug.cleared', seq: ++this._seq, ts: _now() };
    for (const res of this._sseClients) _sseWrite(res, notice);
  }

  _matches(ns) { return this._regex ? this._regex.test(ns) : false; }

  get state() { return { enabled: this._enabled, pattern: this._pattern }; }
}

function _sseWrite(res, event) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
}

export const debugManager = new DebugManager();

/**
 * Create a debug logger for the given namespace.
 * Enabled/disabled and namespace-filtered at runtime via debugManager.setLevel().
 * Also honoured at startup via NODE_DEBUG=tt:* (or specific namespaces).
 *
 * @param {string} ns - Namespace suffix (e.g. 'server', 'client:tunnel')
 * @returns {Function} debug(fmt, ...args)
 */
export function createDebug(ns) {
  return debugManager.createDebug(ns);
}
