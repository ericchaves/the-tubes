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

// Write manifest as raw YAML string (needed when values contain {{ }})
function writeManifestRaw(name, yamlStr) {
  const path = join(tmpDir, name);
  writeFileSync(path, yamlStr);
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
  return new Promise(r => {
    server.closeAllConnections?.();
    server.close(r);
  });
}

// ─── Original tests ──────────────────────────────────────────────────────────

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

describe('runReplaySession — existing behavior', () => {
  let tmpDir2;
  before(() => { tmpDir2 = mkdtempSync(join(tmpdir(), 'replay-run-')); });
  after(() => { rmSync(tmpDir2, { recursive: true, force: true }); });

  it('sends each step to the target', async () => {
    let { server, reqs, url } = await startTarget((req, res) => {
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

// ─── New tests: inline steps ─────────────────────────────────────────────────

describe('runReplaySession — inline HTTP steps', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'replay-inline-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('sends an inline HTTP step without a capture file', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifest = {
      target: url,
      steps: [{
        method: 'POST',
        path: '/inline',
        headers: {},
        body: '{"source":"inline"}',
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].method, 'POST');
    assert.equal(reqs[0].path, '/inline');
    assert.deepEqual(JSON.parse(reqs[0].body.toString()), { source: 'inline' });
    await stopTarget(server);
  });

  it('defaults method to POST when not specified in inline step', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifest = { target: url, steps: [{ path: '/default-method', body: 'x' }] };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].method, 'POST');
    await stopTarget(server);
  });

  it('sends inline GET step without body', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifest = { target: url, steps: [{ method: 'GET', path: '/ping' }] };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].method, 'GET');
    assert.equal(reqs[0].body.length, 0);
    await stopTarget(server);
  });
});

// ─── New tests: global vars ───────────────────────────────────────────────────

describe('runReplaySession — global vars', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'replay-gvars-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('injects global vars into inline step body', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifest = {
      target: url,
      vars: { env: 'staging' },
      steps: [{
        method: 'POST',
        path: '/x',
        body: '{"env":"{{ env }}"}',
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(JSON.parse(reqs[0].body.toString()).env, 'staging');
    await stopTarget(server);
  });

  it('injects global vars into inline step headers', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifest = {
      target: url,
      vars: { token: 'secret-123' },
      steps: [{
        method: 'GET',
        path: '/x',
        headers: { 'x-token': '{{ token }}' },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].headers['x-token'], 'secret-123');
    await stopTarget(server);
  });

  it('global vars resolved with faker produce a valid UUID', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifestPath = join(dir, 'faker-vars.yaml');
    writeFileSync(manifestPath, [
      `target: ${url}`,
      'vars:',
      '  sessionId: "{{ faker.string.uuid() }}"',
      'steps:',
      '  - method: POST',
      '    path: /x',
      '    body: \'{"id":"{{ sessionId }}"}\' ',
    ].join('\n'));

    const { manifest, manifestDir } = loadManifest(manifestPath);
    await runReplaySession(manifest, manifestDir, {});

    const body = JSON.parse(reqs[0].body.toString());
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    await stopTarget(server);
  });

  it('global vars are stable across loop iterations', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifestPath = join(dir, 'stable-gvars.yaml');
    writeFileSync(manifestPath, [
      `target: ${url}`,
      'vars:',
      '  sessionId: "{{ faker.string.uuid() }}"',
      'steps:',
      '  - method: POST',
      '    path: /x',
      '    body: \'{"id":"{{ sessionId }}"}\' ',
    ].join('\n'));

    const { manifest, manifestDir } = loadManifest(manifestPath);
    await runReplaySession(manifest, manifestDir, { loop: 3 });

    assert.equal(reqs.length, 3);
    const ids = reqs.map(r => JSON.parse(r.body.toString()).id);
    // All three iterations must have the same sessionId
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[1], ids[2]);
    await stopTarget(server);
  });

  it('global vars with nested objects are injected correctly', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifest = {
      target: url,
      vars: { user: { name: 'Alice', role: 'admin' } },
      steps: [{
        method: 'POST',
        path: '/x',
        body: '{"name":"{{ user.name }}","role":"{{ user.role }}"}',
      }],
    };
    await runReplaySession(manifest, dir, {});

    const body = JSON.parse(reqs[0].body.toString());
    assert.equal(body.name, 'Alice');
    assert.equal(body.role, 'admin');
    await stopTarget(server);
  });
});

// ─── New tests: step-level vars ───────────────────────────────────────────────

describe('runReplaySession — step vars', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'replay-svars-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('injects step vars into inline step body', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifest = {
      target: url,
      steps: [{
        method: 'POST',
        path: '/x',
        vars: { label: 'from-step' },
        body: '{"label":"{{ label }}"}',
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(JSON.parse(reqs[0].body.toString()).label, 'from-step');
    await stopTarget(server);
  });

  it('step vars re-render per loop iteration (faker produces different values)', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifestPath = join(dir, 'step-faker.yaml');
    writeFileSync(manifestPath, [
      `target: ${url}`,
      'steps:',
      '  - method: POST',
      '    path: /x',
      '    vars:',
      '      eventId: "{{ faker.string.uuid() }}"',
      '    body: \'{"id":"{{ eventId }}"}\' ',
    ].join('\n'));

    const { manifest, manifestDir } = loadManifest(manifestPath);
    await runReplaySession(manifest, manifestDir, { loop: 3 });

    assert.equal(reqs.length, 3);
    const ids = reqs.map(r => JSON.parse(r.body.toString()).id);
    // At least two of the three UUIDs should differ (faker re-renders each iteration)
    const unique = new Set(ids);
    assert.ok(unique.size > 1, `Expected different UUIDs across iterations, got: ${ids.join(', ')}`);
    await stopTarget(server);
  });

  it('step vars can reference global vars in their template', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifest = {
      target: url,
      vars: { prefix: 'event' },
      steps: [{
        method: 'POST',
        path: '/x',
        vars: { label: '{{ prefix }}-001' },
        body: '{"label":"{{ label }}"}',
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(JSON.parse(reqs[0].body.toString()).label, 'event-001');
    await stopTarget(server);
  });

  it('step vars override global vars with same name', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const manifest = {
      target: url,
      vars: { color: 'blue' },
      steps: [{
        method: 'POST',
        path: '/x',
        vars: { color: 'red' },
        body: '{"color":"{{ color }}"}',
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(JSON.parse(reqs[0].body.toString()).color, 'red');
    await stopTarget(server);
  });
});

// ─── New tests: overrides ─────────────────────────────────────────────────────

describe('runReplaySession — overrides (path, body, bodyPatch)', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'replay-overrides-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('overrides.path changes the request path', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'path-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/original', headers: {}, body: 'x' },
    }));

    const manifest = {
      target: url,
      steps: [{
        capture: './path-cap.req.yaml',
        overrides: { path: '/overridden' },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].path, '/overridden');
    await stopTarget(server);
  });

  it('overrides.path supports template syntax', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'path-tmpl-cap.req.yaml'), stringify({
      request: { method: 'GET', path: '/original', headers: {} },
    }));

    const manifest = {
      target: url,
      vars: { version: 'v2' },
      steps: [{
        capture: './path-tmpl-cap.req.yaml',
        overrides: { path: '/api/{{ version }}/resource' },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].path, '/api/v2/resource');
    await stopTarget(server);
  });

  it('overrides.body replaces the entire body', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'body-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: '{"original":true}' },
    }));

    const manifest = {
      target: url,
      steps: [{
        capture: './body-cap.req.yaml',
        overrides: { body: '{"replaced":true}' },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.deepEqual(JSON.parse(reqs[0].body.toString()), { replaced: true });
    await stopTarget(server);
  });

  it('overrides.body supports template syntax', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'body-tmpl-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: '{}' },
    }));

    const manifestPath = join(dir, 'body-tmpl-manifest.yaml');
    writeFileSync(manifestPath, [
      `target: ${url}`,
      'vars:',
      '  name: Alice',
      'steps:',
      '  - capture: ./body-tmpl-cap.req.yaml',
      '    overrides:',
      '      body: \'{"name":"{{ name }}"}\' ',
    ].join('\n'));

    const { manifest, manifestDir } = loadManifest(manifestPath);
    await runReplaySession(manifest, manifestDir, {});

    assert.equal(JSON.parse(reqs[0].body.toString()).name, 'Alice');
    await stopTarget(server);
  });

  it('overrides.bodyPatch modifies a specific field leaving others intact', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'patch-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: '{"a":1,"b":2,"c":3}' },
    }));

    const manifest = {
      target: url,
      steps: [{
        capture: './patch-cap.req.yaml',
        overrides: { bodyPatch: { a: '99' } },
      }],
    };
    await runReplaySession(manifest, dir, {});

    const body = JSON.parse(reqs[0].body.toString());
    assert.equal(body.a, '99');
    assert.equal(body.b, 2);
    assert.equal(body.c, 3);
    await stopTarget(server);
  });

  it('overrides.bodyPatch uses dot notation for nested field', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'patch-nested-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: '{"user":{"name":"old","age":30}}' },
    }));

    const manifest = {
      target: url,
      steps: [{
        capture: './patch-nested-cap.req.yaml',
        overrides: { bodyPatch: { 'user.name': 'new' } },
      }],
    };
    await runReplaySession(manifest, dir, {});

    const body = JSON.parse(reqs[0].body.toString());
    assert.equal(body.user.name, 'new');
    assert.equal(body.user.age, 30);
    await stopTarget(server);
  });

  it('overrides.bodyPatch uses bracket notation for array element', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'patch-arr-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: '{"entry":[{"id":"old","v":1}]}' },
    }));

    const manifest = {
      target: url,
      steps: [{
        capture: './patch-arr-cap.req.yaml',
        overrides: { bodyPatch: { 'entry[0].id': 'new-id' } },
      }],
    };
    await runReplaySession(manifest, dir, {});

    const body = JSON.parse(reqs[0].body.toString());
    assert.equal(body.entry[0].id, 'new-id');
    assert.equal(body.entry[0].v, 1);
    await stopTarget(server);
  });

  it('overrides.bodyPatch renders template values', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'patch-tmpl-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: '{"name":"old"}' },
    }));

    const manifest = {
      target: url,
      vars: { newName: 'Alice' },
      steps: [{
        capture: './patch-tmpl-cap.req.yaml',
        overrides: { bodyPatch: { name: '{{ newName }}' } },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(JSON.parse(reqs[0].body.toString()).name, 'Alice');
    await stopTarget(server);
  });

  it('overrides.headers supports template values', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'hdr-tmpl-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: 'x' },
    }));

    const manifest = {
      target: url,
      vars: { token: 'tok-abc' },
      steps: [{
        capture: './hdr-tmpl-cap.req.yaml',
        overrides: { headers: { 'x-token': '{{ token }}' } },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].headers['x-token'], 'tok-abc');
    await stopTarget(server);
  });
});

// ─── New tests: capture files not rendered ────────────────────────────────────

describe('dotenv[] — .env file loading', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'replay-dotenv-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeEnv(name, content) {
    writeFileSync(join(dir, name), content);
  }

  function writeCapFile(name) {
    writeFileSync(join(dir, name), stringify({
      request: { method: 'POST', path: '/x', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    }));
  }

  it('makes dotenv vars available in overrides.path', async () => {
    writeEnv('.env', 'API_VERSION=v3\n');
    writeCapFile('cap.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      steps: [{ capture: './cap.req.yaml', overrides: { path: '/api/{{ API_VERSION }}/events' } }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].path, '/api/v3/events');
    await stopTarget(server);
  });

  it('makes dotenv vars available in overrides.headers', async () => {
    writeEnv('.env', 'SESSION_TOKEN=tok-xyz\n');
    writeCapFile('cap2.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      steps: [{ capture: './cap2.req.yaml', overrides: { headers: { 'x-token': '{{ SESSION_TOKEN }}' } } }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].headers['x-token'], 'tok-xyz');
    await stopTarget(server);
  });

  it('makes dotenv vars available in overrides.body', async () => {
    writeEnv('.env', 'TENANT=acme\n');
    writeCapFile('cap3.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      steps: [{ capture: './cap3.req.yaml', overrides: { body: '{"tenant":"{{ TENANT }}"}' } }],
    };
    await runReplaySession(manifest, dir, {});

    const body = JSON.parse(reqs[0].body.toString());
    assert.equal(body.tenant, 'acme');
    await stopTarget(server);
  });

  it('makes dotenv vars available in overrides.bodyPatch', async () => {
    writeEnv('.env', 'REGION=us-east-1\n');
    writeCapFile('cap4.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      steps: [{ capture: './cap4.req.yaml', overrides: { bodyPatch: { region: '{{ REGION }}' } } }],
    };
    await runReplaySession(manifest, dir, {});

    const body = JSON.parse(reqs[0].body.toString());
    assert.equal(body.region, 'us-east-1');
    await stopTarget(server);
  });

  it('makes dotenv vars available as context for manifest global vars', async () => {
    writeEnv('.env', 'BASE_URL=http://example.com\n');
    writeCapFile('cap5.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      vars: { apiUrl: '{{ BASE_URL }}/api' },
      steps: [{ capture: './cap5.req.yaml', overrides: { path: '/?url={{ apiUrl }}' } }],
    };
    await runReplaySession(manifest, dir, {});

    assert.ok(reqs[0].path.includes('http://example.com/api'), `expected apiUrl in path, got: ${reqs[0].path}`);
    await stopTarget(server);
  });

  it('makes dotenv vars available as context for step vars', async () => {
    writeEnv('.env', 'PREFIX=pfx\n');
    writeCapFile('cap6.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      steps: [{
        capture: './cap6.req.yaml',
        vars: { tag: '{{ PREFIX }}-001' },
        overrides: { path: '/items/{{ tag }}' },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].path, '/items/pfx-001');
    await stopTarget(server);
  });

  it('renders manifest.target as a template using dotenv vars', async () => {
    writeCapFile('cap7.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    // Extract host:port from url to use in .env
    const urlObj = new URL(url);
    writeEnv('.env', `TARGET_HOST=${urlObj.hostname}\nTARGET_PORT=${urlObj.port}\n`);

    const manifest = {
      target: `http://{{ TARGET_HOST }}:{{ TARGET_PORT }}`,
      dotenv: ['.env'],
      steps: [{ capture: './cap7.req.yaml' }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs.length, 1);
    await stopTarget(server);
  });

  it('renders manifest.loop as a template using dotenv vars', async () => {
    writeEnv('.env', 'LOOP_COUNT=3\n');
    writeCapFile('cap8.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      loop: '{{ LOOP_COUNT }}',
      steps: [{ capture: './cap8.req.yaml' }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs.length, 3);
    await stopTarget(server);
  });

  it('renders step.idleMs as a template using dotenv vars (no blocking)', async () => {
    writeEnv('.env', 'STEP_DELAY=0\n');
    writeCapFile('cap9.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      steps: [{ capture: './cap9.req.yaml', idleMs: '{{ STEP_DELAY }}' }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs.length, 1);
    await stopTarget(server);
  });

  it('renders step.capture path as a template using dotenv vars', async () => {
    writeEnv('.env', 'CAP_NAME=dyn-cap\n');
    writeFileSync(join(dir, 'dyn-cap.req.yaml'), stringify({
      request: { method: 'GET', path: '/dynamic', headers: {}, body: '' },
    }));
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      steps: [{ capture: './{{ CAP_NAME }}.req.yaml' }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].path, '/dynamic');
    await stopTarget(server);
  });

  it('global vars override dotenv vars with the same name', async () => {
    writeEnv('.env', 'PRIORITY=from-dotenv\n');
    writeCapFile('cap10.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env'],
      vars: { PRIORITY: 'from-globalvars' },
      steps: [{ capture: './cap10.req.yaml', overrides: { path: '/x?p={{ PRIORITY }}' } }],
    };
    await runReplaySession(manifest, dir, {});

    assert.ok(reqs[0].path.includes('from-globalvars'), `expected global var to win, got: ${reqs[0].path}`);
    await stopTarget(server);
  });

  it('merges two .env files — second overrides first on collision', async () => {
    writeEnv('.env.first', 'KEY=first\nONLY_FIRST=yes\n');
    writeEnv('.env.second', 'KEY=second\nONLY_SECOND=yes\n');
    writeCapFile('cap11.req.yaml');
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end(); });

    const manifest = {
      target: url,
      dotenv: ['.env.first', '.env.second'],
      steps: [{
        capture: './cap11.req.yaml',
        overrides: { path: '/x?key={{ KEY }}&a={{ ONLY_FIRST }}&b={{ ONLY_SECOND }}' },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.ok(reqs[0].path.includes('key=second'));
    assert.ok(reqs[0].path.includes('a=yes'));
    assert.ok(reqs[0].path.includes('b=yes'));
    await stopTarget(server);
  });

  it('throws when a declared .env file is missing', async () => {
    const manifest = {
      target: 'http://localhost:9999',
      dotenv: ['.env.does-not-exist'],
      steps: [{ path: '/x', method: 'GET' }],
    };
    await assert.rejects(
      () => runReplaySession(manifest, dir, {}),
      /\.env file not found/i,
    );
  });
});

describe('runReplaySession — capture files not rendered', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'replay-norender-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('leaves {{ }} literal in capture file body untouched', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    // Simulate a body that happens to contain {{ }} (e.g. from a Handlebars app)
    writeFileSync(join(dir, 'literal-braces.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: '{"tmpl":"{{not_a_var}}"}' },
    }));

    const manifest = {
      target: url,
      steps: [{ capture: './literal-braces.req.yaml' }],
    };
    await runReplaySession(manifest, dir, {});

    const body = JSON.parse(reqs[0].body.toString());
    assert.equal(body.tmpl, '{{not_a_var}}');
    await stopTarget(server);
  });

  it('bodyPatch still applies to capture file body after skipping render', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'patch-over-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: '{"a":1,"b":2}' },
    }));

    const manifest = {
      target: url,
      steps: [{
        capture: './patch-over-cap.req.yaml',
        overrides: { bodyPatch: { a: 'patched' } },
      }],
    };
    await runReplaySession(manifest, dir, {});

    const body = JSON.parse(reqs[0].body.toString());
    assert.equal(body.a, 'patched');
    assert.equal(body.b, 2);
    await stopTarget(server);
  });
});

// ─── excludeHeaders ───────────────────────────────────────────────────────────

describe('runReplaySession — excludeHeaders', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'replay-exclude-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('manifest-level excludeHeaders drops header from captured request', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'exc-cap.req.yaml'), stringify({
      request: {
        method: 'POST', path: '/x',
        headers: { 'x-forwarded-for': '1.2.3.4', 'content-type': 'application/json' },
        body: '{}',
      },
    }));

    const manifest = {
      target: url,
      excludeHeaders: ['x-forwarded-for'],
      steps: [{ capture: './exc-cap.req.yaml' }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].headers['x-forwarded-for'], undefined);
    assert.equal(reqs[0].headers['content-type'], 'application/json');
    await stopTarget(server);
  });

  it('step-level overrides.excludeHeaders drops header only for that step', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'step-exc-cap1.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: { 'x-internal': 'secret', 'x-keep': 'yes' }, body: '{}' },
    }));
    writeFileSync(join(dir, 'step-exc-cap2.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: { 'x-internal': 'secret', 'x-keep': 'yes' }, body: '{}' },
    }));

    const manifest = {
      target: url,
      steps: [
        { capture: './step-exc-cap1.req.yaml', overrides: { excludeHeaders: ['x-internal'] } },
        { capture: './step-exc-cap2.req.yaml' },
      ],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].headers['x-internal'], undefined);
    assert.equal(reqs[0].headers['x-keep'], 'yes');
    assert.equal(reqs[1].headers['x-internal'], 'secret');
    await stopTarget(server);
  });

  it('step-level excludeHeaders combines with manifest-level', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'combined-exc-cap.req.yaml'), stringify({
      request: {
        method: 'POST', path: '/x',
        headers: { 'x-global': 'a', 'x-local': 'b', 'x-keep': 'c' },
        body: '{}',
      },
    }));

    const manifest = {
      target: url,
      excludeHeaders: ['x-global'],
      steps: [{
        capture: './combined-exc-cap.req.yaml',
        overrides: { excludeHeaders: ['x-local'] },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].headers['x-global'], undefined);
    assert.equal(reqs[0].headers['x-local'], undefined);
    assert.equal(reqs[0].headers['x-keep'], 'c');
    await stopTarget(server);
  });

  it('excludeHeaders matching is case-insensitive', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'case-exc-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: { 'X-Custom-Header': 'value' }, body: '{}' },
    }));

    const manifest = {
      target: url,
      excludeHeaders: ['x-custom-header'],
      steps: [{ capture: './case-exc-cap.req.yaml' }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].headers['x-custom-header'], undefined);
    await stopTarget(server);
  });

  it('headers added via overrides.headers are NOT excluded', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'no-exc-override-cap.req.yaml'), stringify({
      request: { method: 'POST', path: '/x', headers: { 'x-captured': 'drop-me' }, body: '{}' },
    }));

    const manifest = {
      target: url,
      excludeHeaders: ['x-captured'],
      steps: [{
        capture: './no-exc-override-cap.req.yaml',
        overrides: { headers: { 'x-captured': 'injected' } },
      }],
    };
    await runReplaySession(manifest, dir, {});

    assert.equal(reqs[0].headers['x-captured'], 'injected');
    await stopTarget(server);
  });
});

// ─── verbose output ───────────────────────────────────────────────────────────

describe('runReplaySession — verbose output', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'replay-verbose-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  function collectOutput() {
    const lines = [];
    const log = (...args) => lines.push(args.map(a => String(a)).join(' '));
    const write = (data) => { lines.push(String(data)); return true; };
    const getOutput = () => lines.join('\n');
    return { log, write, getOutput };
  }

  it('verbose=0 (default) does not print response body', async () => {
    const { server, url } = await startTarget((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });

    const { log, write, getOutput } = collectOutput();
    const manifest = { target: url, steps: [{ method: 'GET', path: '/ping' }] };
    await runReplaySession(manifest, dir, { verbose: 0, log, write });
    const out = getOutput();

    assert.ok(!out.includes('"status"'), `expected no body in output, got: ${out}`);
    await stopTarget(server);
  });

  it('verbose=1 prints response body', async () => {
    const { server, url } = await startTarget((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });

    const { log, write, getOutput } = collectOutput();
    const manifest = { target: url, steps: [{ method: 'GET', path: '/ping' }] };
    await runReplaySession(manifest, dir, { verbose: 1, log, write });
    const out = getOutput();

    assert.ok(out.includes('"status"'), `expected body in output, got: ${out}`);
    assert.ok(!out.includes('content-type:'), `expected no headers in verbose=1, got: ${out}`);
    await stopTarget(server);
  });

  it('verbose=1 pretty-prints JSON response body', async () => {
    const { server, url } = await startTarget((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a":1,"b":2}');
    });

    const { log, write, getOutput } = collectOutput();
    const manifest = { target: url, steps: [{ method: 'GET', path: '/ping' }] };
    await runReplaySession(manifest, dir, { verbose: 1, log, write });
    const out = getOutput();

    assert.ok(out.includes('"a": 1'), `expected pretty-printed JSON, got: ${out}`);
    await stopTarget(server);
  });

  it('verbose=2 prints response headers and body', async () => {
    const { server, url } = await startTarget((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-custom': 'hello' });
      res.end('{"status":"ok"}');
    });

    const { log, write, getOutput } = collectOutput();
    const manifest = { target: url, steps: [{ method: 'GET', path: '/ping' }] };
    await runReplaySession(manifest, dir, { verbose: 2, log, write });
    const out = getOutput();

    assert.ok(out.includes('content-type:'), `expected content-type header, got: ${out}`);
    assert.ok(out.includes('x-custom:'), `expected x-custom header, got: ${out}`);
    assert.ok(out.includes('"status"'), `expected body, got: ${out}`);
    assert.ok(out.includes('response'), `expected response section label, got: ${out}`);
    await stopTarget(server);
  });

  it('verbose=3 prints request and response', async () => {
    const { server, url } = await startTarget((req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"created":true}');
    });

    const { log, write, getOutput } = collectOutput();
    const manifest = {
      target: url,
      steps: [{
        method: 'POST',
        path: '/items',
        headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
        body: '{"name":"test"}',
      }],
    };
    await runReplaySession(manifest, dir, { verbose: 3, log, write });
    const out = getOutput();

    assert.ok(out.includes('request'), `expected request section label, got: ${out}`);
    assert.ok(out.includes('POST /items'), `expected request line, got: ${out}`);
    assert.ok(out.includes('x-trace:'), `expected request header, got: ${out}`);
    assert.ok(out.includes('response'), `expected response section label, got: ${out}`);
    assert.ok(out.includes('"created"'), `expected response body, got: ${out}`);
    await stopTarget(server);
  });

  it('verbose=1 prints plain text body as-is', async () => {
    const { server, url } = await startTarget((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello world');
    });

    const { log, write, getOutput } = collectOutput();
    const manifest = { target: url, steps: [{ method: 'GET', path: '/ping' }] };
    await runReplaySession(manifest, dir, { verbose: 1, log, write });
    const out = getOutput();

    assert.ok(out.includes('hello world'), `expected plain text body, got: ${out}`);
    await stopTarget(server);
  });

  it('verbose=1 shows [binary N bytes] for non-text responses', async () => {
    const { server, url } = await startTarget((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    });

    const { log, write, getOutput } = collectOutput();
    const manifest = { target: url, steps: [{ method: 'GET', path: '/bin' }] };
    await runReplaySession(manifest, dir, { verbose: 1, log, write });
    const out = getOutput();

    assert.ok(out.includes('[binary'), `expected binary label, got: ${out}`);
    assert.ok(out.includes('bytes]'), `expected byte count, got: ${out}`);
    await stopTarget(server);
  });

  it('verbose=1 prints nothing for empty response body', async () => {
    const { server, url } = await startTarget((req, res) => {
      res.writeHead(204);
      res.end();
    });

    const { log, write, getOutput } = collectOutput();
    const manifest = { target: url, steps: [{ method: 'DELETE', path: '/item/1' }] };
    await runReplaySession(manifest, dir, { verbose: 1, log, write });
    const out = getOutput();

    assert.ok(!out.includes('┌─'), `expected no response section box, got: ${out}`);
    assert.ok(!out.includes('[binary'), `expected no binary label, got: ${out}`);
    await stopTarget(server);
  });
});

// ─── content-length recalculation ────────────────────────────────────────────

describe('runReplaySession — content-length recalculation', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'replay-clen-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('content-length from capture is not forwarded — recalculated from actual body', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    const originalBody = '{"a":1}';
    writeFileSync(join(dir, 'clen-cap.req.yaml'), stringify({
      request: {
        method: 'POST', path: '/x',
        headers: { 'content-type': 'application/json', 'content-length': '9999' },
        body: originalBody,
      },
    }));

    const manifest = {
      target: url,
      steps: [{ capture: './clen-cap.req.yaml' }],
    };
    await runReplaySession(manifest, dir, {});

    const actualLen = Buffer.byteLength(originalBody);
    assert.equal(reqs[0].headers['content-length'], String(actualLen));
    await stopTarget(server);
  });

  it('content-length recalculated after overrides.body changes body size', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'clen-override-cap.req.yaml'), stringify({
      request: {
        method: 'POST', path: '/x',
        headers: { 'content-type': 'application/json', 'content-length': '7' },
        body: '{"a":1}',
      },
    }));

    const newBody = '{"a":1,"b":2,"c":3,"extra":"field"}';
    const manifest = {
      target: url,
      steps: [{
        capture: './clen-override-cap.req.yaml',
        overrides: { body: newBody },
      }],
    };
    await runReplaySession(manifest, dir, {});

    const expected = Buffer.byteLength(JSON.stringify(JSON.parse(newBody)));
    assert.equal(reqs[0].headers['content-length'], String(expected));
    await stopTarget(server);
  });

  it('content-length recalculated after overrides.bodyPatch changes body size', async () => {
    const { server, reqs, url } = await startTarget((req, res) => { res.writeHead(200); res.end('ok'); });

    writeFileSync(join(dir, 'clen-patch-cap.req.yaml'), stringify({
      request: {
        method: 'POST', path: '/x',
        headers: { 'content-type': 'application/json', 'content-length': '7' },
        body: '{"a":1}',
      },
    }));

    const manifest = {
      target: url,
      steps: [{
        capture: './clen-patch-cap.req.yaml',
        overrides: { bodyPatch: { a: 'a-much-longer-replacement-value' } },
      }],
    };
    await runReplaySession(manifest, dir, {});

    const receivedBody = reqs[0].body.toString();
    const expectedLen = Buffer.byteLength(receivedBody);
    assert.equal(reqs[0].headers['content-length'], String(expectedLen));
    await stopTarget(server);
  });
});
