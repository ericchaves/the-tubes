/**
 * the-tubes control protocol v1.
 *
 * Carries lifecycle messages between tt client and tt server over a persistent
 * WebSocket (the "control channel"). The raw HTTP/WebSocket traffic itself
 * flows through short-lived TCP "data sockets" that start with a plain-text
 * preamble identifying which pair they belong to.
 *
 * Design principles:
 *  - All control frames are JSON text (opcode 0x1). Small volume, human debuggable.
 *  - Every frame carries {v, type}; unknown types are ignored (forward-compatible).
 *  - Data sockets open on demand, 1:1 with external requests. No pre-opened pool.
 */

export const PROTOCOL_VERSION = 1;
export const DATA_PREAMBLE_PREFIX = 'TT/1 PAIR ';
export const DATA_PREAMBLE_MAX_BYTES = 256;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;

export const MSG = Object.freeze({
  HELLO: 'hello',
  HELLO_ACK: 'hello.ack',
  PING: 'ping',
  PONG: 'pong',
  PAIR_OPEN: 'pair.open',     // server → client: please open a data socket for this external request
  PAIR_CLOSE: 'pair.close',   // server → client: external peer is gone, tear down this pair
  PAIR_FAILED: 'pair.failed', // client → server: cannot fulfill pair.open (e.g. ECONNREFUSED)
  PAIR_CLOSED: 'pair.closed', // client → server: local side of this pair closed normally
});

/**
 * Build the first-line preamble that every data socket writes before any HTTP bytes.
 * Newline-terminated; parsed by the server's data-socket listener.
 *
 * @param {string} pairId
 * @param {string} [replacesControlId] - if present, marks this socket as a replacement
 *   for a pair whose previous data socket died during a control channel outage.
 */
export function buildPreamble(pairId, replacesControlId = null) {
  const line = replacesControlId
    ? `${DATA_PREAMBLE_PREFIX}${pairId} REPLACES ${replacesControlId}\r\n`
    : `${DATA_PREAMBLE_PREFIX}${pairId}\r\n`;
  return Buffer.from(line, 'utf8');
}

/**
 * Parse a preamble line (without CRLF).
 * @param {string} line
 * @returns {{pairId: string, replacesControlId: string|null}|null}
 */
export function parsePreamble(line) {
  if (!line.startsWith(DATA_PREAMBLE_PREFIX)) return null;
  const rest = line.slice(DATA_PREAMBLE_PREFIX.length).trim();
  const parts = rest.split(/\s+/);
  if (parts.length === 1) return { pairId: parts[0], replacesControlId: null };
  if (parts.length === 3 && parts[1] === 'REPLACES') {
    return { pairId: parts[0], replacesControlId: parts[2] };
  }
  return null;
}

/**
 * Serialize a control frame as a JSON string.
 * @param {string} type - one of MSG.*
 * @param {object} [data]
 */
export function encode(type, data = {}) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...data });
}

/**
 * Parse + minimally validate an incoming control frame.
 * Returns null if the payload is malformed or wrong version.
 * @param {string|Buffer} payload
 */
export function decode(payload) {
  let obj;
  try {
    obj = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.v !== PROTOCOL_VERSION) return null;
  if (typeof obj.type !== 'string') return null;
  return obj;
}
