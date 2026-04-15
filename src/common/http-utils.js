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
    if (forwarded) return forwarded.split(',')[0].trim();
    const realIp = req.headers['x-real-ip'];
    if (realIp) return realIp.trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
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
