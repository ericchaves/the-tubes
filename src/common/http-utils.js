/**
 * Normalize an IP address string for consistent use as a key.
 * Handles IPv4, IPv6, IPv4-mapped IPv6, link-local zones, and bracketed literals.
 *
 * @param {string|undefined} ip
 * @returns {string}
 */
export function normalizeIp(ip) {
  if (!ip) return 'unknown';
  // Remove bracket notation used in Host headers: [::1] → ::1
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    ip = end !== -1 ? ip.slice(1, end) : ip.slice(1);
  }
  // Remove link-local zone ID: fe80::1%eth0 → fe80::1
  const pct = ip.indexOf('%');
  if (pct !== -1) ip = ip.slice(0, pct);
  // Normalize IPv4-mapped IPv6: ::ffff:127.0.0.1 → 127.0.0.1
  if (ip.startsWith('::ffff:') || ip.startsWith('::FFFF:')) {
    ip = ip.slice(7);
  }
  return ip || 'unknown';
}

/**
 * Extract the real client IP from a request.
 * Used only for logging and rate-limiting — never for identity.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustForwardHeaders
 * @returns {string}
 */
export function getClientIp(req, trustForwardHeaders = false) {
  if (trustForwardHeaders) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return normalizeIp(forwarded.split(',')[0].trim());
    const realIp = req.headers['x-real-ip'];
    if (realIp) return normalizeIp(realIp.trim());
  }
  return normalizeIp(req.socket?.remoteAddress);
}

/**
 * Summarize a socket for debug logging.
 * @param {import('node:net').Socket} socket
 * @returns {string}
 */
export function getSocketInfo(socket) {
  if (!socket) return 'unknown';
  const addr = socket.remoteAddress ?? '?';
  const port = socket.remotePort ?? '?';
  return `${addr}:${port}`;
}
