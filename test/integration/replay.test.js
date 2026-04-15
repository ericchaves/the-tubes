import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { stringify } from '../../src/common/yaml-lite.js';
import { loadManifest, loadCaptureRequest } from '../../src/replay/manifest.js';
import { runReplaySession } from '../../src/replay/runner.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'replay-test-'));
}

function teardown() {
  rmSync(tmpDir, { recursive: true, force: true });
}

function writeCapture(name, reqDoc) {
  const path = join(tmpDir, name);
  writeFileSync(path, stringify(reqDoc));
  return path;
}

function writeManifest(name, manifestObj) {
  const path = join(tmpDir, name);
  writeFileSync(path, stringify(manifestObj));
  return path;
}

function startTarget(handler) {
  return new Promise((resolve) => {
    const reqs = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        reqs.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        handler(req, res, reqs);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, reqs, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopTarget(server) {
  return new Promise(r => server.close(r));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadManifest', () => {
  before(setup);
  after(teardown);

  it('loads a valid manifest', () => {
    const capPath = writeCapture('cap.req.yaml', {
      request: { method: 'POST', path: '/webhook', headers: {}, body: '{}' },
    });
    const manifestPath = writeManifest('manifest.yaml', {
      target: 'http://localhost:3000',
      steps: [{ capture: './cap.req.yaml' }],
    });

    const { manifest, manifestDir } = loadManifest(manifestPath);
    assert.equal(manifest.target, 'http://localhost:3000');
    assert.equal(manifest.steps.length, 1);
    assert.equal(manifestDir, tmpDir);
  });

  it('supports legacy webhook field', () => {
    const manifestPath = writeManifest('legacy.yaml', {
      webhook: 'http://old.example.com',
      steps: [{ capture: './none.yaml' }],
    });
    const { manifest } = loadManifest(manifestPath);
    assert.equal(manifest.target, 'http://old.example.com');
  });

  it('supports legacy sources field', () => {
    const manifestPath = writeManifest('legacy-sources.yaml', {
      target: 'http://x',
      sources: [{ request: './a.yaml', idle: 10 }, { request: './b.yaml' }],
    });
    const { manifest } = loadManifest(manifestPath);
    assert.equal(manifest.steps.length, 2);
    assert.equal(manifest.steps[0].capture, './a.yaml');
    assert.equal(manifest.steps[0].idleMs, 10);
  });

  it('throws ConfigError for missing target', () => {
    const manifestPath = writeManifest('bad.yaml', {
      steps: [{ capture: './x.yaml' }],
    });
    assert.throws(() => loadManifest(manifestPath), /target/);
  });

  it('throws ConfigError for missing steps', () => {
    const manifestPath = writeManifest('bad2.yaml', { target: 'http://x' });
    assert.throws(() => loadManifest(manifestPath), /steps/);
  });

  it('throws ConfigError if file not found', () => {
    assert.throws(() => loadManifest('/nonexistent/manifest.yaml'), /not found/i);
  });
});

describe('loadCaptureRequest', () => {
  before(setup);
  after(teardown);

  it('loads new-format capture', () => {
    const p = writeCapture('new.yaml', {
      request: { method: 'POST', path: '/x', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    });
    const req = loadCaptureRequest(p);
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/x');
  });

  it('loads old-format capture (flat)', () => {
    const p = writeCapture('old.yaml', {
      method: 'POST', path: '/y', headers: {}, body: '{}',
    });
    const req = loadCaptureRequest(p);
    assert.equal(req.method, 'POST');
  });

  it('throws if method missing', () => {
    const p = writeCapture('bad.yaml', {
      request: { path: '/x', headers: {} },
    });
    assert.throws(() => loadCaptureRequest(p), /method/i);
  });
});

describe('runReplaySession', () => {
  let tmpDir2;
  before(() => { tmpDir2 = mkdtempSync(join(tmpdir(), 'replay-run-')); });
  after(() => { rmSync(tmpDir2, { recursive: true, force: true }); });

  it('sends each step to the target', async () => {
    let { server, port, reqs, url } = await startTarget((req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    writeFileSync(join(tmpDir2, 'cap1.req.yaml'), stringify({
      request: { method: 'POST', path: '/webhook', headers: {}, body: '{"step":1}' },
    }));
    writeFileSync(join(tmpDir2, 'cap2.req.yaml'), stringify({
      request: { method: 'POST', path: '/webhook', headers: {}, body: '{"step":2}' },
    }));

    const manifest = {
      target: url,
      steps: [
        { capture: './cap1.req.yaml' },
        { capture: './cap2.req.yaml' },
      ],
    };

    await runReplaySession(manifest, tmpDir2, {});

    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].body.toString(), '{"step":1}');
    assert.equal(reqs[1].body.toString(), '{"step":2}');

    await stopTarget(server);
  });

  it('respects --dry-run: no requests sent', async () => {
    let { server, reqs, url } = await startTarget((req, res) => {
      res.writeHead(200); res.end('ok');
    });

    writeFileSync(join(tmpDir2, 'dry-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/dry', headers: {}, body: 'payload' },
    }));

    const manifest = { target: url, steps: [{ capture: './dry-cap.req.yaml' }] };
    await runReplaySession(manifest, tmpDir2, { dryRun: true });

    assert.equal(reqs.length, 0);
    await stopTarget(server);
  });

  it('repeats steps when loop > 1', async () => {
    let { server, reqs, url } = await startTarget((req, res) => {
      res.writeHead(200); res.end('ok');
    });

    writeFileSync(join(tmpDir2, 'loop-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/loop', headers: {}, body: 'x' },
    }));

    const manifest = { target: url, steps: [{ capture: './loop-cap.req.yaml' }] };
    await runReplaySession(manifest, tmpDir2, { loop: 3 });

    assert.equal(reqs.length, 3);
    await stopTarget(server);
  });

  it('respects targetUrl override', async () => {
    let { server: s1, url: url1 } = await startTarget((req, res) => { res.writeHead(404); res.end(); });
    let { server: s2, reqs: reqs2, url: url2 } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(tmpDir2, 'override-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: 'z' },
    }));

    const manifest = { target: url1, steps: [{ capture: './override-cap.req.yaml' }] };
    await runReplaySession(manifest, tmpDir2, { targetUrl: url2 });

    assert.equal(reqs2.length, 1);
    await stopTarget(s1);
    await stopTarget(s2);
  });

  it('applies step overrides.headers', async () => {
    let { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(tmpDir2, 'override-hdr-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: { 'x-original': 'yes' }, body: 'payload' },
    }));

    const manifest = {
      target: url,
      steps: [{
        capture: './override-hdr-cap.req.yaml',
        overrides: { headers: { 'x-test-marker': 'injected' } },
      }],
    };
    await runReplaySession(manifest, tmpDir2, {});

    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].headers['x-test-marker'], 'injected');
    await stopTarget(server);
  });

  it('respects idleMs between steps', async () => {
    let { server, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(tmpDir2, 'idle-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/idle', headers: {}, body: 'x' },
    }));
    writeFileSync(join(tmpDir2, 'idle-cap2.req.yaml'), stringify({
      request: { method: 'POST', path: '/idle2', headers: {}, body: 'y' },
    }));

    const manifest = {
      target: url,
      steps: [
        { capture: './idle-cap.req.yaml', idleMs: 50 },
        { capture: './idle-cap2.req.yaml' },
      ],
    };

    const start = Date.now();
    await runReplaySession(manifest, tmpDir2, {});
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 50, `Expected ≥50ms elapsed, got ${elapsed}ms`);
    await stopTarget(server);
  });
});
