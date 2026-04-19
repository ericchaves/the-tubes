import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adminPage } from './page.js';
import { loadManifest } from '../../replay/manifest.js';
import { createDebug } from '../../debug.js';

const debug = createDebug('client:admin');

/**
 * Create the expose-client admin HTTP server.
 *
 * Endpoints:
 *   GET  /tubes              → HTML dashboard
 *   GET  /tubes/events       → SSE stream (events)
 *   GET  /tubes/debug/events → SSE stream (debug log)
 *   GET  /tubes/status       → JSON state snapshot
 *   GET  /tubes/flows        → JSON list of discovered manifests
 *   POST /tubes/replay       → trigger a replay { manifest: "<name>" }
 *   POST /tubes/capture      → toggle capture { enabled: boolean }
 *   POST /tubes/debug        → toggle debug   { enabled: boolean, pattern?: string }
 *   POST /tubes/events/clear → clear event ring buffer
 *   POST /tubes/debug/clear  → clear debug ring buffer
 *
 * @param {object} opts
 * @param {import('./event-log.js').ClientEventLog} opts.log
 * @param {function(): object} opts.getState   - returns current state snapshot
 * @param {object} opts.filteredConfig         - expose config with secrets removed
 * @param {string|null} opts.flowsDir          - directory to scan for manifests
 * @param {function(object, string, string): Promise<void>} opts.onReplay
 * @param {function(): import('../tunnel.js').ClientTunnel|null} opts.getTunnel
 * @param {import('../../debug.js').debugManager} opts.debugManager
 */
export function createAdminServer({ log, getState, filteredConfig, flowsDir, onReplay, getTunnel, debugManager }) {
  let replayRunning = false;
  const absFlowsDir = flowsDir ? resolve(flowsDir) : null;

  function scanFlows() {
    if (!absFlowsDir) return [];
    try {
      return readdirSync(absFlowsDir)
        .filter(f => f.endsWith('.yaml'))
        .sort()
        .map(f => {
          const name = f.slice(0, -5);
          try {
            const { manifest } = loadManifest(join(absFlowsDir, f));
            return { name, steps: manifest.steps.length, target: manifest.target, valid: true };
          } catch (err) {
            return { name, steps: 0, valid: false, error: err.message };
          }
        });
    } catch {
      return [];
    }
  }

  function readBody(req) {
    return new Promise(resolve => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // ── GET / — redirect ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(302, { Location: '/tubes' });
      return res.end();
    }

    // ── GET /tubes — HTML page ────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/tubes') {
      const html = adminPage({ filteredConfig });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // ── GET /tubes/events — SSE stream ────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/tubes/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const tunnel = getTunnel?.();
      const initEvent = {
        type: '__init__',
        seq: 0,
        ts: new Date().toISOString(),
        state: {
          ...getState(),
          captureEnabled: tunnel?.captureEnabled ?? !!filteredConfig?.captureEnabled,
          debug: debugManager.state,
        },
        flows: scanFlows(),
      };
      log.addSseClient(res, initEvent);
      debug('SSE client connected');
      return;
    }

    // ── GET /tubes/debug/events — debug SSE ──────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/tubes/debug/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      debugManager.addSseClient(res);
      debug('debug SSE client connected');
      return;
    }

    // ── GET /tubes/status — JSON snapshot ────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/tubes/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(getState()));
    }

    // ── GET /tubes/flows — list manifests ────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/tubes/flows') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(scanFlows()));
    }

    // ── POST /tubes/capture — toggle capture ──────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/tubes/capture') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      const enabled = !!parsed.enabled;
      const tunnel = getTunnel?.();
      tunnel?.toggleCapture(enabled);
      log.push('capture.toggled', { enabled });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, enabled }));
    }

    // ── POST /tubes/debug — set debug level ───────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/tubes/debug') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      const enabled = !!parsed.enabled;
      const pattern = typeof parsed.pattern === 'string' ? parsed.pattern : 'tt:*';
      debugManager.setLevel(enabled, pattern);
      log.push('debug.changed', { enabled, pattern });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, enabled, pattern }));
    }

    // ── POST /tubes/events/clear — clear event ring buffer ────────────────────
    if (req.method === 'POST' && url.pathname === '/tubes/events/clear') {
      log.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // ── POST /tubes/debug/clear — clear debug ring buffer ────────────────────
    if (req.method === 'POST' && url.pathname === '/tubes/debug/clear') {
      debugManager.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // ── POST /tubes/replay — trigger replay ───────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/tubes/replay') {
      if (replayRunning) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'A replay is already running' }));
      }
      if (!absFlowsDir) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No flows directory configured (--flows-dir)' }));
      }

      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }

      const { manifest: manifestName } = parsed;
      if (!manifestName || typeof manifestName !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: '"manifest" name is required' }));
      }
      if (/[/\\.]/.test(manifestName.replace(/\./g, 'x'))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid manifest name' }));
      }

      const manifestPath = join(absFlowsDir, `${manifestName}.yaml`);
      let manifest, manifestDir;
      try {
        ({ manifest, manifestDir } = loadManifest(manifestPath));
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, manifest: manifestName, steps: manifest.steps.length }));

      replayRunning = true;
      onReplay(manifest, manifestDir, manifestName)
        .finally(() => { replayRunning = false; });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    listen(port, address = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, address, () => {
          debug('admin server listening on %s:%d', address, server.address().port);
          resolve(server.address().port);
        });
      });
    },
    close() { server.close(); },
  };
}
