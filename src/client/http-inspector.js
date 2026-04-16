import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { stringify } from '../common/yaml-lite.js';
import { generateCaptureId } from '../common/id-generator.js';
import { createDebug } from '../debug.js';

const debug = createDebug('client:inspector');

const MAX_INLINE_BINARY_BYTES = 16 * 1024; // 16 KB

/**
 * HTTP request/response inspector that saves captures as YAML.
 * Captures are skipped for responses with X-TT-Source: server.
 */
export class HttpInspector {
  /**
   * @param {object} opts
   * @param {string} opts.captureDir
   * @param {string} opts.tunnelId
   * @param {number} [opts.maxBodyKb=1024]
   */
  constructor({ captureDir, tunnelId, maxBodyKb = 1024 }) {
    this._dir = captureDir;
    this._tunnelId = tunnelId;
    this._maxBodyBytes = maxBodyKb * 1024;
    mkdirSync(captureDir, { recursive: true });
  }

  /**
   * Save a captured request. Returns the captureId for pairing with the response.
   *
   * @param {object} data
   * @param {string} data.method
   * @param {string} data.path
   * @param {Record<string, string|string[]>} data.headers
   * @param {Buffer} data.body
   * @returns {string} captureId
   */
  captureRequest({ method, path, headers, body }) {
    const captureId = generateCaptureId();

    const bodyResult = this._encodeBody(body, headers['content-encoding'], captureId, 'req');

    const doc = {
      captureId,
      tunnelId: this._tunnelId,
      timestamp: new Date().toISOString(),
      request: {
        method,
        path,
        headers: _flattenHeaders(headers),
        bodyEncoding: bodyResult.encoding,
        ...(bodyResult.encoding === 'file' ? { bodyFile: bodyResult.file } : { body: bodyResult.data }),
        ...(bodyResult.truncated ? { truncated: true } : {}),
      },
    };

    const filename = `${this._tunnelId}.${captureId}.req.yaml`;
    writeFileSync(join(this._dir, filename), stringify(doc));
    debug('captured request (id=%s, path=%s)', captureId, path);
    return captureId;
  }

  /**
   * Save a captured response.
   *
   * @param {object} data
   * @param {number} data.status
   * @param {Record<string, string|string[]>} data.headers
   * @param {Buffer} data.body
   * @param {string} captureId - from captureRequest()
   */
  captureResponse({ status, headers, body }, captureId) {
    // Skip server-generated responses (e.g., 503, 404 from our own server)
    if (headers['x-tt-source'] === 'server') {
      debug('skipping server-generated response (id=%s)', captureId);
      return;
    }

    const bodyResult = this._encodeBody(body, headers['content-encoding'], captureId, 'res');

    const doc = {
      captureId,
      tunnelId: this._tunnelId,
      timestamp: new Date().toISOString(),
      response: {
        status,
        headers: _flattenHeaders(headers),
        bodyEncoding: bodyResult.encoding,
        ...(bodyResult.encoding === 'file' ? { bodyFile: bodyResult.file } : { body: bodyResult.data }),
        ...(bodyResult.truncated ? { truncated: true } : {}),
      },
    };

    const filename = `${this._tunnelId}.${captureId}.res.yaml`;
    writeFileSync(join(this._dir, filename), stringify(doc));
    debug('captured response (id=%s, status=%d)', captureId, status);
  }

  /**
   * Save a captured WebSocket exchange.
   *
   * @param {object} data
   * @param {string} data.path - request path (e.g. /echo)
   * @param {Record<string, string>} data.reqHeaders - HTTP upgrade request headers
   * @param {Array} data.frames - parsed frames with dir/opcode/encoding/data fields
   * @returns {string} captureId
   */
  captureWebSocket({ path, reqHeaders, frames }) {
    const captureId = generateCaptureId();

    const doc = {
      captureId,
      tunnelId: this._tunnelId,
      timestamp: new Date().toISOString(),
      websocket: {
        path,
        headers: _flattenHeaders(reqHeaders),
        frames,
      },
    };

    const filename = `${this._tunnelId}.${captureId}.ws.yaml`;
    writeFileSync(join(this._dir, filename), stringify(doc));
    debug('captured websocket (id=%s, path=%s, frames=%d)', captureId, path, frames.length);
    return captureId;
  }

  /**
   * Decompress and encode body for storage.
   * @returns {{ encoding: 'utf8'|'base64'|'file', data?: string, file?: string, truncated?: boolean }}
   */
  _encodeBody(rawBody, contentEncoding, captureId, suffix) {
    if (!rawBody || rawBody.length === 0) {
      return { encoding: 'utf8', data: '' };
    }

    // Decompress
    let body = rawBody;
    try {
      const enc = (contentEncoding || '').toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') body = gunzipSync(rawBody);
      else if (enc === 'deflate') body = inflateSync(rawBody);
      else if (enc === 'br') body = brotliDecompressSync(rawBody);
    } catch {
      // Decompression failed — use raw body
    }

    // Truncate if too large
    let truncated = false;
    if (body.length > this._maxBodyBytes) {
      body = body.slice(0, this._maxBodyBytes);
      truncated = true;
    }

    // Try UTF-8 text
    const text = body.toString('utf8');
    if (!_hasBinaryChars(text)) {
      return { encoding: 'utf8', data: text, ...(truncated ? { truncated } : {}) };
    }

    // Binary: small → base64 inline, large → external file
    if (body.length <= MAX_INLINE_BINARY_BYTES) {
      return { encoding: 'base64', data: body.toString('base64'), ...(truncated ? { truncated } : {}) };
    }

    const binFile = `${this._tunnelId}.${captureId}.${suffix}.bin`;
    writeFileSync(join(this._dir, binFile), body);
    return { encoding: 'file', file: `./${binFile}`, ...(truncated ? { truncated } : {}) };
  }
}

function _flattenHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function _hasBinaryChars(str) {
  // Quick heuristic: check for null bytes or high-proportion non-printable chars
  for (let i = 0; i < Math.min(str.length, 512); i++) {
    const code = str.charCodeAt(i);
    if (code === 0) return true;
  }
  return false;
}
