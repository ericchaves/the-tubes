import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const DEFAULT_SESSION_FILE = resolve(homedir(), '.tt', 'session');

/**
 * Resolve the session file path, expanding ~ if needed.
 */
function resolvePath(filePath) {
  const p = filePath ?? DEFAULT_SESSION_FILE;
  if (p.startsWith('~')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/**
 * Load an existing session token from file, or return null.
 * @param {string} [filePath]
 * @returns {string|null}
 */
export function loadSessionToken(filePath) {
  const p = resolvePath(filePath);
  try {
    return readFileSync(p, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Generate a new session token, persist it to file, and return it.
 * @param {string} [filePath]
 * @returns {string}
 */
export function generateAndSaveSessionToken(filePath) {
  const p = resolvePath(filePath);
  const token = randomBytes(16).toString('hex');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, token, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* non-critical */ }
  return token;
}

/**
 * Load or generate (and persist) a session token.
 * @param {string} [filePath]
 * @returns {{ token: string, persisted: boolean }}
 */
export function resolveSessionToken(filePath) {
  const existing = loadSessionToken(filePath);
  if (existing) return { token: existing, persisted: true };
  const token = generateAndSaveSessionToken(filePath);
  return { token, persisted: false };
}

/**
 * Delete the session file (reset).
 * @param {string} [filePath]
 */
export function resetSessionFile(filePath) {
  const p = resolvePath(filePath);
  try {
    unlinkSync(p);
  } catch {
    // File may not exist — that's fine
  }
}
