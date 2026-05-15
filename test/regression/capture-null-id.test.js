/**
 * Regression: when HttpInspector is paused, captureRequest returns null and
 * the 'capture' event must NOT be emitted with captureId: null.
 *
 * Fix: tunnel-cluster.js guards emit('capture') with `if (captureId != null)`.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpInspector } from '../../src/client/http-inspector.js';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'capture-null-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeInspector() {
  return new HttpInspector({ captureDir: tmpDir, tunnelId: 'test-tunnel', maxBodyKb: 64 });
}

describe('captureRequest when paused', () => {
  it('returns null when inspector is paused', () => {
    const insp = makeInspector();
    insp.paused = true;
    const id = insp.captureRequest({ method: 'GET', path: '/', headers: {}, body: Buffer.alloc(0) });
    assert.equal(id, null);
  });

  it('writes no files when paused', () => {
    const insp = makeInspector();
    insp.paused = true;
    insp.captureRequest({ method: 'GET', path: '/', headers: {}, body: Buffer.alloc(0) });
    assert.equal(readdirSync(tmpDir).length, 0);
  });

  it('captureResponse is a no-op when captureId is null', () => {
    const insp = makeInspector();
    // Should not throw
    insp.captureResponse({ status: 200, headers: {}, body: Buffer.alloc(0) }, null);
    assert.equal(readdirSync(tmpDir).length, 0);
  });

  it('resumes capture after unpausing', () => {
    const insp = makeInspector();
    insp.paused = true;
    insp.captureRequest({ method: 'GET', path: '/', headers: {}, body: Buffer.alloc(0) });
    assert.equal(readdirSync(tmpDir).length, 0);

    insp.paused = false;
    const id = insp.captureRequest({ method: 'POST', path: '/data', headers: {}, body: Buffer.from('hi') });
    assert.ok(id != null);
    assert.equal(readdirSync(tmpDir).length, 1);
  });
});
