import { verify } from '../common/hmac.js';
import { NonceCache } from '../common/nonce-cache.js';
import { createDebug } from '../debug.js';

const debug = createDebug('server:hmac');

/**
 * Create an HMAC verification function.
 * Returns a function (req, body) → { valid, reason }
 *
 * @param {object} opts
 * @param {string} opts.secret
 * @param {number} opts.clockSkewS
 * @param {number} opts.nonceCacheTtlS
 * @returns {(req: import('node:http').IncomingMessage, body?: string) => { valid: boolean, reason?: string }}
 */
export function createHmacMiddleware({ secret, clockSkewS, nonceCacheTtlS }) {
  const nonceCache = new NonceCache({ ttlS: nonceCacheTtlS });

  function verify_req(req, body = '') {
    const authHeader = req.headers['x-tt-auth'];
    const method = req.method.toUpperCase();
    const path = req.url;

    const result = verify({ method, path, secret, authHeader, body, clockSkewS });
    if (!result.valid) {
      debug('HMAC verification failed: %s (method=%s path=%s)', result.reason, method, path);
      return result;
    }

    // Anti-replay: check nonce
    if (nonceCache.isSeen(result.nonce)) {
      debug('HMAC nonce replay detected (nonce=%s)', result.nonce);
      return { valid: false, reason: 'nonce already used (replay attack)' };
    }

    return { valid: true };
  }

  verify_req.destroy = () => nonceCache.destroy();

  return verify_req;
}
