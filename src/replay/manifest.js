import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse } from '../common/yaml-lite.js';
import { ConfigError } from '../common/errors.js';

/**
 * Load and validate a replay manifest.
 *
 * @param {string} manifestPath
 * @returns {{ manifest: object, manifestDir: string }}
 */
export function loadManifest(manifestPath) {
  const absPath = resolve(manifestPath);
  if (!existsSync(absPath)) {
    throw new ConfigError(`Manifest file not found: ${absPath}`);
  }

  let manifest;
  try {
    manifest = parse(readFileSync(absPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Failed to parse manifest: ${err.message}`);
  }

  if (!manifest.target && !manifest.webhook) {
    throw new ConfigError('Manifest must have a "target" field (webhook URL)');
  }
  // Support legacy "webhook" field from old replay format
  if (!manifest.target && manifest.webhook) {
    manifest.target = manifest.webhook;
  }

  if (!Array.isArray(manifest.steps) && !Array.isArray(manifest.sources)) {
    throw new ConfigError('Manifest must have a "steps" array');
  }
  // Support legacy "sources" field
  if (!manifest.steps && manifest.sources) {
    manifest.steps = manifest.sources.map(s => ({
      capture: s.request,
      idleMs: s.idle,
    }));
  }

  for (const [i, step] of manifest.steps.entries()) {
    _validateStep(step, i);
  }

  if (manifest.dotenv != null && !Array.isArray(manifest.dotenv)) {
    throw new ConfigError('Manifest "dotenv" must be an array of file paths');
  }

  if (manifest.excludeHeaders != null && !Array.isArray(manifest.excludeHeaders)) {
    throw new ConfigError('Manifest "excludeHeaders" must be an array of header names');
  }

  const manifestDir = dirname(absPath);
  return { manifest, manifestDir };
}

/**
 * Load and merge a list of .env files into a plain object.
 * Later files override earlier ones on key collision.
 *
 * @param {string[]} dotenvList - paths relative to manifestDir
 * @param {string} manifestDir
 * @returns {object} merged key→value pairs
 */
export function loadDotEnvFiles(dotenvList, manifestDir) {
  if (!dotenvList?.length) return {};
  const result = {};
  for (const relPath of dotenvList) {
    const absPath = resolve(manifestDir, relPath);
    if (!existsSync(absPath)) {
      throw new ConfigError(`.env file not found: ${absPath}`);
    }
    let text;
    try {
      text = readFileSync(absPath, 'utf8');
    } catch (err) {
      throw new ConfigError(`Failed to read .env file "${absPath}": ${err.message}`);
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!key) continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return result;
}

function _validateStep(step, idx) {
  const isCapture = !!(step.capture ?? step.request);
  const isWs = step.type === 'ws';

  if (step.overrides?.excludeHeaders != null && !Array.isArray(step.overrides.excludeHeaders)) {
    throw new ConfigError(`Step ${idx + 1}: "overrides.excludeHeaders" must be an array of header names`);
  }

  if (isCapture) return;

  // Inline step — validate minimum required fields
  if (isWs) {
    if (!step.path) {
      throw new ConfigError(`Step ${idx + 1}: inline WebSocket step must have a "path" field`);
    }
  } else {
    if (!step.path) {
      throw new ConfigError(`Step ${idx + 1}: inline HTTP step must have a "path" field`);
    }
  }
}

/**
 * Load a WebSocket capture file (.ws.yaml).
 *
 * @param {string} captureFile - absolute path
 * @returns {{ path: string, headers: object, frames: Array }} websocket capture data
 */
export function loadCaptureWs(captureFile) {
  if (!existsSync(captureFile)) {
    throw new ConfigError(`Capture file not found: ${captureFile}`);
  }

  let doc;
  try {
    doc = parse(readFileSync(captureFile, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Failed to parse capture file "${captureFile}": ${err.message}`);
  }

  const ws = doc.websocket;
  if (!ws) {
    throw new ConfigError(`Capture file "${captureFile}" is not a WebSocket capture (missing websocket key)`);
  }
  if (!ws.path) {
    throw new ConfigError(`Capture file "${captureFile}" missing websocket.path`);
  }

  return ws;
}

/**
 * Load and validate a capture request file.
 *
 * @param {string} captureFile - absolute path
 * @returns {object} the request data
 */
export function loadCaptureRequest(captureFile) {
  if (!existsSync(captureFile)) {
    throw new ConfigError(`Capture file not found: ${captureFile}`);
  }

  let doc;
  try {
    doc = parse(readFileSync(captureFile, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Failed to parse capture file "${captureFile}": ${err.message}`);
  }

  // Support both new format (doc.request) and old format (doc itself has method/path/headers/body)
  const req = doc.request ?? doc;
  if (!req.method) {
    throw new ConfigError(`Capture file "${captureFile}" missing request.method`);
  }

  return req;
}
