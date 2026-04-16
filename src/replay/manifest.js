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

  const manifestDir = dirname(absPath);
  return { manifest, manifestDir };
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
