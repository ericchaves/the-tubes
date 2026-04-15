import { debuglog } from 'node:util';

/**
 * Create a debug logger for the given namespace.
 * Enabled via NODE_DEBUG=tt:* (or specific namespaces).
 *
 * @param {string} ns - Namespace suffix (e.g. 'server', 'client:tunnel')
 * @returns {Function} debug(fmt, ...args)
 */
export function createDebug(ns) {
  return debuglog(`tt:${ns}`);
}
