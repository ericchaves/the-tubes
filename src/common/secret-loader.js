import { readFileSync } from 'node:fs';
import { ConfigError } from './errors.js';

/**
 * Load a secret from env var or file fallback.
 *
 * Priority: TT_<NAME>_SECRET > TT_<NAME>_SECRET_FILE
 *
 * @param {string} name - Variable name prefix (e.g. 'HMAC')
 * @param {Record<string,string>} env - process.env or override
 * @returns {string|null} secret or null if not configured
 */
export function loadSecret(name, env = process.env) {
  const direct = env[`TT_${name}_SECRET`];
  if (direct) return direct.trim();

  const filePath = env[`TT_${name}_SECRET_FILE`];
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').split('\n')[0].trim();
    } catch (err) {
      throw new ConfigError(`Cannot read TT_${name}_SECRET_FILE at "${filePath}": ${err.message}`);
    }
  }

  return null;
}
