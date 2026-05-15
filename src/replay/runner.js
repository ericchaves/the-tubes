import { resolve } from 'node:path';
import { styleText } from 'node:util';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { loadCaptureRequest, loadCaptureWs, loadDotEnvFiles } from './manifest.js';
import { resolveVars, renderDeep, renderString, applyBodyPatch } from './template.js';
import { createDebug } from '../debug.js';

const debug = createDebug('replay');

/**
 * Execute a replay run.
 *
 * @param {object} manifest - parsed manifest object
 * @param {string} manifestDir - directory of the manifest (for resolving relative paths)
 * @param {object} opts
 * @param {string} opts.targetUrl - override target (or use manifest.target)
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.sendHostHeader]
 * @param {number} [opts.loop]
 * @param {number} [opts.loopPauseMs]
 * @param {number} [opts.warmupMs]
 * @param {function} [opts.onStep] - called after each step:
 *   { stepIdx, total, method, url, status, durationMs, error }
 */
export async function runReplaySession(manifest, manifestDir, opts = {}) {
  // Load .env files declared in manifest.dotenv (resolved once, before loop)
  const dotenvVars = loadDotEnvFiles(manifest.dotenv ?? [], manifestDir);

  // Resolve global vars with dotenvVars as extra context
  const globalVars = resolveVars(manifest.vars, dotenvVars);

  // Context for manifest-level template fields
  const manifestCtx = { ...dotenvVars, ...globalVars };

  const target = opts.targetUrl ?? _renderStr(manifest.target, manifestCtx);
  const loop = opts.loop ?? _renderInt(manifest.loop ?? manifest.loopCount ?? 1, manifestCtx);
  const loopPauseMs = opts.loopPauseMs ?? _renderInt(manifest.loopPauseMs ?? manifest.pause ?? 0, manifestCtx);
  const warmupMs = opts.warmupMs ?? _renderInt(manifest.warmupMs ?? manifest.warmup ?? 0, manifestCtx);
  const sendHostHeader = opts.sendHostHeader ?? _renderBool(manifest.sendHostHeader ?? false, manifestCtx);
  const dryRun = opts.dryRun ?? false;
  const onStep = opts.onStep ?? null;

  console.log(styleText('cyan', `Replay: ${manifest.steps.length} steps → ${target}`));
  if (dryRun) console.log(styleText('yellow', '  DRY RUN — no requests will be sent'));
  console.log(`  loops: ${loop}  loop-pause: ${loopPauseMs}ms  warmup: ${warmupMs}ms`);

  if (warmupMs > 0) {
    debug('warmup %dms', warmupMs);
    await sleep(warmupMs);
  }

  for (let loopIdx = 0; loopIdx < loop; loopIdx++) {
    if (loop > 1) console.log(`\n── Loop ${loopIdx + 1}/${loop} ──`);

    for (const [stepIdx, step] of manifest.steps.entries()) {
      const total = manifest.steps.length;
      const isWs = step.type === 'ws';
      const isInline = !(step.capture ?? step.request);

      // Step vars re-resolve each iteration; they can reference global vars and dotenv vars
      const stepVars = resolveVars(step.vars, { ...dotenvVars, ...globalVars });
      const context = { ...dotenvVars, ...globalVars, ...stepVars };

      if (isWs) {
        // ── WebSocket step ──────────────────────────────────────────────────
        let wsData;
        if (isInline) {
          wsData = renderDeep({
            path: step.path ?? '/',
            headers: step.headers ?? {},
            frames: step.frames ?? [],
          }, context);
        } else {
          const capturePath = resolve(manifestDir, renderString(step.capture ?? step.request, context));
          try {
            wsData = loadCaptureWs(capturePath);
          } catch (err) {
            console.error(styleText('red', `  [${stepIdx + 1}] Error: ${err.message}`));
            onStep?.({ stepIdx, total, method: 'WS', url: capturePath, status: null, durationMs: 0, error: err.message });
            continue;
          }
        }

        // Apply overrides
        if (step.overrides?.path) {
          wsData.path = renderString(step.overrides.path, context);
        }

        // Build WS URL: convert http(s) target to ws(s), then append captured path
        const baseWs = target.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '');
        const finalUrl = `${baseWs}${wsData.path}`;

        // Build headers — optionally strip Host and WS handshake headers
        const headers = {};
        for (const [k, v] of Object.entries(wsData.headers ?? {})) {
          if (k.toLowerCase() === 'host' && !sendHostHeader) continue;
          const kl = k.toLowerCase();
          if (['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version',
               'sec-websocket-extensions', 'sec-websocket-protocol'].includes(kl)) continue;
          headers[k] = Array.isArray(v) ? v[0] : String(v);
        }
        if (step.overrides?.headers) {
          Object.assign(headers, renderDeep(step.overrides.headers, context));
        }

        if (dryRun) {
          const clientCount = (wsData.frames ?? []).filter(f => f.dir === 'client').length;
          console.log(`  [${stepIdx + 1}] DRY WS → ${finalUrl} (${clientCount} frames)`);
        } else {
          process.stdout.write(`  [${stepIdx + 1}] WS ${finalUrl} ... `);
          const t0 = Date.now();
          try {
            await wsSend(finalUrl, wsData.frames ?? [], headers);
            const durationMs = Date.now() - t0;
            console.log(styleText('green', '101'));
            debug('step %d → ws 101', stepIdx + 1);
            onStep?.({ stepIdx, total, method: 'WS', url: finalUrl, status: 101, durationMs, error: null });
          } catch (err) {
            const durationMs = Date.now() - t0;
            console.log(styleText('red', `ERROR: ${err.message}`));
            debug('step %d ws error: %s', stepIdx + 1, err.message);
            onStep?.({ stepIdx, total, method: 'WS', url: finalUrl, status: null, durationMs, error: err.message });
          }
        }
      } else {
        // ── HTTP step ───────────────────────────────────────────────────────
        let reqData;
        if (isInline) {
          reqData = renderDeep({
            method: step.method ?? 'POST',
            path: step.path ?? '/',
            headers: step.headers ?? {},
            body: step.body,
            bodyEncoding: step.bodyEncoding ?? 'utf8',
          }, context);
        } else {
          const capturePath = resolve(manifestDir, renderString(step.capture ?? step.request, context));
          try {
            reqData = loadCaptureRequest(capturePath);
          } catch (err) {
            console.error(styleText('red', `  [${stepIdx + 1}] Error: ${err.message}`));
            continue;
          }
        }

        // Apply overrides
        if (step.overrides?.path) {
          reqData.path = renderString(step.overrides.path, context);
        }

        // Build headers — optionally strip Host
        const headers = {};
        for (const [k, v] of Object.entries(reqData.headers ?? {})) {
          if (k.toLowerCase() === 'host' && !sendHostHeader) continue;
          headers[k] = Array.isArray(v) ? v[0] : String(v);
        }
        if (step.overrides?.headers) {
          Object.assign(headers, renderDeep(step.overrides.headers, context));
        }

        // Apply body overrides before body processing
        if (step.overrides?.body != null) {
          reqData.body = renderString(String(step.overrides.body), context);
        } else if (step.overrides?.bodyPatch) {
          const raw = String(reqData.body ?? '{}');
          reqData.body = applyBodyPatch(raw, step.overrides.bodyPatch, context);
        }

        // Build body buffer
        let body;
        const bodyEncoding = reqData.bodyEncoding ?? 'utf8';
        if (reqData.body != null) {
          const rawBody = String(reqData.body);
          if (bodyEncoding === 'base64') {
            body = Buffer.from(rawBody, 'base64');
          } else {
            // Normalize JSON bodies
            const trimmed = rawBody.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              try {
                body = JSON.stringify(JSON.parse(trimmed));
              } catch {
                body = rawBody;
              }
            } else {
              body = rawBody;
            }
          }
        }

        // Build final URL: preserve captured path and querystring against target base
        const dumpUrl = new URL(`http://dummy${reqData.path ?? '/'}`);
        const base = target.replace(/\/$/, '');
        const pathPart = dumpUrl.pathname !== '/' ? dumpUrl.pathname : '';
        const finalUrl = `${base}${pathPart}${dumpUrl.search}` || target;

        const method = (reqData.method ?? 'POST').toUpperCase();

        // GET and HEAD must not carry a body
        const reqBody = (method === 'GET' || method === 'HEAD') ? undefined : (body || undefined);

        if (dryRun) {
          console.log(`  [${stepIdx + 1}] DRY ${method} → ${finalUrl}`);
          if (reqBody) console.log(`    body: ${String(reqBody).slice(0, 80)}...`);
        } else {
          process.stdout.write(`  [${stepIdx + 1}] ${method} ${finalUrl} ... `);
          const t0 = Date.now();
          try {
            const status = await httpSend(finalUrl, method, headers, reqBody);
            const durationMs = Date.now() - t0;
            console.log(styleText(status < 400 ? 'green' : 'yellow', `${status}`));
            debug('step %d → %d', stepIdx + 1, status);
            onStep?.({ stepIdx, total, method, url: finalUrl, status, durationMs, error: null });
          } catch (err) {
            const durationMs = Date.now() - t0;
            console.log(styleText('red', `ERROR: ${err.message}`));
            debug('step %d error: %s', stepIdx + 1, err.message);
            onStep?.({ stepIdx, total, method, url: finalUrl, status: null, durationMs, error: err.message });
          }
        }
      }

      const idleMs = _renderInt(step.idleMs ?? step.idle ?? 0, context);
      if (idleMs > 0) {
        debug('idle %dms after step %d', idleMs, stepIdx + 1);
        await sleep(idleMs);
      }
    }

    if (loopIdx < loop - 1 && loopPauseMs > 0) {
      debug('loop pause %dms', loopPauseMs);
      await sleep(loopPauseMs);
    }
  }

  console.log(styleText('green', '\nReplay completed.'));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _renderStr(val, ctx) {
  return typeof val === 'string' ? renderString(val, ctx) : val;
}

function _renderInt(val, ctx) {
  const s = _renderStr(val, ctx);
  return typeof s === 'string' ? (parseInt(s, 10) || 0) : (s ?? 0);
}

function _renderBool(val, ctx) {
  if (typeof val !== 'string') return Boolean(val);
  const s = renderString(val, ctx);
  return s === 'true' || s === '1';
}

/**
 * Open a WebSocket connection, send all client-direction frames, then close.
 * Uses a raw TCP socket so we can set arbitrary headers (including Host).
 *
 * @param {string} url - ws:// or wss:// URL
 * @param {Array} frames - frame objects from the capture ({dir, opcode, encoding, data})
 * @param {object} headers - extra HTTP headers to include in the upgrade request
 * @returns {Promise<101>}
 */
export function wsSend(url, frames, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const port = parseInt(urlObj.port) || (urlObj.protocol === 'wss:' ? 443 : 80);
    const path = (urlObj.pathname || '/') + (urlObj.search || '');

    const key = randomBytes(16).toString('base64');
    const upgradeHeaders = {
      host: urlObj.host,
      ...headers,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
    };

    const upgradeReq =
      `GET ${path} HTTP/1.1\r\n` +
      Object.entries(upgradeHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n';

    const tlsOpts = { host: urlObj.hostname, port };
    if (!isIP(urlObj.hostname)) tlsOpts.servername = urlObj.hostname;
    const socket = urlObj.protocol === 'wss:'
      ? tlsConnect(tlsOpts)
      : netConnect({ host: urlObj.hostname, port });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    socket.setTimeout(10000);
    socket.on('timeout', () => finish(new Error('WebSocket connection timeout')));
    socket.on('error', finish);

    socket.on('connect', () => socket.write(upgradeReq));

    socket.on('data', (chunk) => {
      if (upgraded) return;
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) return;

      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString();
      if (!statusLine.includes('101')) {
        finish(new Error(`WebSocket upgrade failed: ${statusLine.trim()}`));
        return;
      }
      upgraded = true;

      // Send all client frames
      const clientFrames = frames.filter(f => f.dir === 'client' || !f.dir);
      for (const frame of clientFrames) {
        // Only send data-bearing frames (text=1, binary=2, ping=9)
        if (![1, 2, 9].includes(frame.opcode)) continue;
        const payload = frame.encoding === 'base64'
          ? Buffer.from(frame.data ?? '', 'base64')
          : Buffer.from(frame.data ?? '', 'utf8');
        socket.write(_encodeWsFrame(frame.opcode, payload));
      }

      // Send close frame
      socket.write(_encodeWsFrame(8, Buffer.alloc(0)));
      finish(101);
    });

    socket.on('close', () => {
      if (!done) finish(upgraded ? 101 : new Error('Connection closed before WebSocket upgrade'));
    });
  });
}

/**
 * Encode a single RFC 6455 WebSocket frame (client→server, always masked).
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function _encodeWsFrame(opcode, payload) {
  const len = payload.length;
  let headerLen;
  if (len <= 125) headerLen = 2;
  else if (len <= 65535) headerLen = 4;
  else headerLen = 10;

  const frame = Buffer.allocUnsafe(headerLen + 4 + len); // header + mask key + payload
  frame[0] = 0x80 | opcode; // FIN=1 + opcode

  const maskOffset = headerLen;
  if (len <= 125) {
    frame[1] = 0x80 | len;
  } else if (len <= 65535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }

  const maskKey = randomBytes(4);
  maskKey.copy(frame, maskOffset);

  for (let i = 0; i < len; i++) {
    frame[maskOffset + 4 + i] = payload[i] ^ maskKey[i % 4];
  }

  return frame;
}

/**
 * Send an HTTP/HTTPS request using node:http/https so that all headers
 * (including Host) are sent verbatim — fetch/undici silently overrides Host.
 *
 * @returns {Promise<number>} HTTP status code
 */
function httpSend(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const makeRequest = isHttps ? httpsRequest : httpRequest;

    const bodyBuf = body != null ? Buffer.isBuffer(body) ? body : Buffer.from(String(body)) : null;
    if (bodyBuf) headers['content-length'] = String(bodyBuf.length);

    const req = makeRequest({
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}
