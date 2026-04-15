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
 *   GET /         → HTML dashboard
 *   GET /events   → SSE stream
 *   GET /status   → JSON state snapshot
 *   GET /flows    → JSON list of discovered manifests
 *   POST /replay  → trigger a replay { manifest: "<name>" }
 *
 * @param {object} opts
 * @param {import('./event-log.js').ClientEventLog} opts.log
 * @param {function(): object} opts.getState  - returns current state snapshot
 * @param {object} opts.filteredConfig        - expose config with secrets removed
 * @param {string|null} opts.flowsDir         - directory to scan for manifests
 * @param {function(object, string, string): Promise<void>} opts.onReplay
 *   Called with (manifest, manifestDir, name) when a replay is triggered.
 */
export function createAdminServer({ log, getState, filteredConfig, flowsDir, onReplay }) {
  let replayRunning = false;
  const absFlowsDir = flowsDir ? resolve(flowsDir) : null;

  function scanFlows() {
    if (!absFlowsDir) return [];
    try {
      return readdirSync(absFlowsDir)
        .filter(f => f.endsWith('.yaml'))
        .sort()
        .map(f => {
          const name = f.slice(0, -5); // strip .yaml
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

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // ── GET / — HTML page ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/') {
      const html = adminPage({ filteredConfig });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // ── GET /events — SSE stream ───────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const initEvent = {
        type: '__init__',
        seq: 0,
        ts: new Date().toISOString(),
        state: getState(),
        flows: scanFlows(),
      };
      log.addSseClient(res, initEvent);
      debug('SSE client connected');
      return;
    }

    // ── GET /status — JSON snapshot ────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(getState()));
    }

    // ── GET /flows — list manifests ────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/flows') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(scanFlows()));
    }

    // ── POST /replay — trigger replay ──────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/replay') {
      if (replayRunning) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'A replay is already running' }));
      }
      if (!absFlowsDir) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No flows directory configured (--flows-dir)' }));
      }

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
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
        // Guard against path traversal
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
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    /**
     * @param {number} port
     * @param {string} [address='127.0.0.1']
     * @returns {Promise<number>} bound port
     */
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
