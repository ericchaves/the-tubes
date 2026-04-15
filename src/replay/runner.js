import { resolve } from 'node:path';
import { styleText } from 'node:util';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { loadCaptureRequest } from './manifest.js';
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
  const target = opts.targetUrl ?? manifest.target;
  const loop = opts.loop ?? manifest.loop ?? manifest.loopCount ?? 1;
  const loopPauseMs = opts.loopPauseMs ?? manifest.loopPauseMs ?? manifest.pause ?? 0;
  const warmupMs = opts.warmupMs ?? manifest.warmupMs ?? manifest.warmup ?? 0;
  const sendHostHeader = opts.sendHostHeader ?? manifest.sendHostHeader ?? false;
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
      const capturePath = resolve(manifestDir, step.capture ?? step.request);
      let reqData;
      try {
        reqData = loadCaptureRequest(capturePath);
      } catch (err) {
        console.error(styleText('red', `  [${stepIdx + 1}] Error: ${err.message}`));
        continue;
      }

      // Build headers — optionally strip Host
      const headers = {};
      for (const [k, v] of Object.entries(reqData.headers ?? {})) {
        if (k.toLowerCase() === 'host' && !sendHostHeader) continue;
        headers[k] = Array.isArray(v) ? v[0] : String(v);
      }

      // Apply step overrides
      if (step.overrides?.headers) {
        Object.assign(headers, step.overrides.headers);
      }

      // Build body
      let body;
      const bodyEncoding = reqData.bodyEncoding ?? 'utf8';
      if (reqData.body || reqData.body === '') {
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

      const total = manifest.steps.length;

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

      const idleMs = step.idleMs ?? step.idle ?? 0;
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
