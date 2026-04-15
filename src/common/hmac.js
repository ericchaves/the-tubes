import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Build the canonical message string for HMAC signing.
 * Format: METHOD\nPATH\nTS\nNONCE\nBODY_SHA256_HEX
 */
function buildMessage(method, path, ts, nonce, bodyHash) {
  return `${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

/**
 * Hash a body buffer (or empty string) to hex.
 */
function hashBody(body) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : (body ?? Buffer.alloc(0));
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Sign a request.
 *
 * @param {object} params
 * @param {string} params.method - HTTP method (uppercase)
 * @param {string} params.path   - Request path + querystring
 * @param {string} params.secret - HMAC secret
 * @param {string|Buffer} [params.body] - Request body (empty for GET)
 * @returns {{ ts: string, nonce: string, sig: string, header: string }}
 */
export function sign({ method, path, secret, body = '' }) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = Date.now().toString();
  const bodyHash = hashBody(body);
  const message = buildMessage(method, path, ts, nonce, bodyHash);
  const sig = createHmac('sha256', secret).update(message).digest('hex');
  const header = Buffer.from(JSON.stringify({ ts, nonce, sig })).toString('base64');
  return { ts, nonce, sig, header };
}

/**
 * Verify a request's X-TT-Auth header.
 *
 * @param {object} params
 * @param {string} params.method
 * @param {string} params.path
 * @param {string} params.secret
 * @param {string} params.authHeader  - Value of X-TT-Auth
 * @param {string|Buffer} [params.body]
 * @param {number} [params.clockSkewS=60]
 * @returns {{ valid: boolean, reason?: string, ts?: string, nonce?: string }}
 */
export function verify({ method, path, secret, authHeader, body = '', clockSkewS = 60 }) {
  if (!authHeader) return { valid: false, reason: 'missing X-TT-Auth header' };

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(authHeader, 'base64').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed X-TT-Auth header' };
  }

  const { ts, nonce, sig } = parsed;
  if (!ts || !nonce || !sig) return { valid: false, reason: 'incomplete X-TT-Auth payload' };

  const now = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum) || Math.abs(now - tsNum) > clockSkewS) {
    return { valid: false, reason: `timestamp out of tolerance (skew=${now - tsNum}s, tolerance=${clockSkewS}s)` };
  }

  const bodyHash = hashBody(body);
  const message = buildMessage(method, path, ts, nonce, bodyHash);
  const expected = createHmac('sha256', secret).update(message).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(sig, 'hex');

  if (expectedBuf.length !== receivedBuf.length) {
    return { valid: false, reason: 'invalid signature' };
  }

  if (!timingSafeEqual(expectedBuf, receivedBuf)) {
    return { valid: false, reason: 'invalid signature' };
  }

  return { valid: true, ts, nonce };
}
