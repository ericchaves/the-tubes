import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { HttpInspector } from '../../src/client/http-inspector.js';
import { parse } from '../../src/common/yaml-lite.js';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'http-inspector-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeInspector(maxBodyKb = 1024) {
  return new HttpInspector({ captureDir: tmpDir, tunnelId: 'test-tunnel', maxBodyKb });
}

function listFiles() {
  return readdirSync(tmpDir).sort();
}

function readYaml(filename) {
  return parse(readFileSync(join(tmpDir, filename), 'utf8'));
}

describe('HttpInspector', () => {
  it('should capture a request and produce a .req.yaml file', () => {
    const insp = makeInspector();
    const captureId = insp.captureRequest({
      method: 'POST',
      path: '/webhook',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"a":1}'),
    });

    const files = listFiles();
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.req.yaml'));
    assert.ok(files[0].includes(captureId));

    const doc = readYaml(files[0]);
    assert.equal(doc.captureId, captureId);
    assert.equal(doc.tunnelId, 'test-tunnel');
    assert.equal(doc.request.method, 'POST');
    assert.equal(doc.request.path, '/webhook');
    assert.equal(doc.request.bodyEncoding, 'utf8');
    assert.equal(doc.request.body.trim(), '{"a":1}');
  });

  it('should capture a response and produce a .res.yaml file', () => {
    const insp = makeInspector();
    const captureId = insp.captureRequest({
      method: 'GET',
      path: '/',
      headers: {},
      body: Buffer.alloc(0),
    });

    insp.captureResponse({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('OK'),
    }, captureId);

    const files = listFiles();
    assert.equal(files.length, 2);
    const resFile = files.find(f => f.endsWith('.res.yaml'));
    assert.ok(resFile);
    const doc = readYaml(resFile);
    assert.equal(doc.response.status, 200);
    assert.equal(doc.response.body.trim(), 'OK');
  });

  it('should skip responses with x-tt-source: server', () => {
    const insp = makeInspector();
    const captureId = insp.captureRequest({
      method: 'GET',
      path: '/',
      headers: {},
      body: Buffer.alloc(0),
    });

    insp.captureResponse({
      status: 503,
      headers: { 'x-tt-source': 'server' },
      body: Buffer.from('unavailable'),
    }, captureId);

    const files = listFiles();
    // Only req file, no res file
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.req.yaml'));
  });

  it('should decompress gzip bodies', () => {
    const insp = makeInspector();
    const compressed = gzipSync(Buffer.from('hello gzip'));
    const captureId = insp.captureRequest({
      method: 'POST',
      path: '/',
      headers: { 'content-encoding': 'gzip' },
      body: compressed,
    });

    const files = listFiles();
    const doc = readYaml(files[0]);
    assert.equal(doc.request.bodyEncoding, 'utf8');
    assert.ok(doc.request.body.includes('hello gzip'));
  });

  it('should encode binary bodies as base64', () => {
    const insp = makeInspector();
    // Null byte makes it binary
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const captureId = insp.captureRequest({
      method: 'POST',
      path: '/',
      headers: {},
      body: binary,
    });

    const files = listFiles();
    const doc = readYaml(files[0]);
    assert.equal(doc.request.bodyEncoding, 'base64');
    assert.equal(Buffer.from(doc.request.body, 'base64').toString('hex'), binary.toString('hex'));
  });

  it('should truncate bodies exceeding maxBodyKb', () => {
    const insp = makeInspector(1); // 1 KB max
    const body = Buffer.alloc(2048, 0x41); // 2 KB of 'A'
    const captureId = insp.captureRequest({
      method: 'POST',
      path: '/',
      headers: {},
      body,
    });

    const files = listFiles();
    const doc = readYaml(files[0]);
    assert.equal(doc.request.truncated, true);
    assert.ok(doc.request.body.length <= 1024 + 10); // +10 for encoding overhead
  });
});

describe('HttpInspector.captureWebSocket', () => {
  it('writes a .ws.yaml file with captureId, path, headers, and frames', () => {
    const insp = makeInspector();
    const frames = [
      { dir: 'client', opcode: 1, encoding: 'utf8', data: 'ping' },
      { dir: 'server', opcode: 1, encoding: 'utf8', data: 'ping' },
    ];
    const captureId = insp.captureWebSocket({
      path: '/echo',
      reqHeaders: { host: 'example.com', upgrade: 'websocket' },
      frames,
    });

    const files = listFiles();
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.ws.yaml'), `expected .ws.yaml, got ${files[0]}`);
    assert.ok(files[0].includes(captureId));

    const doc = readYaml(files[0]);
    assert.equal(doc.captureId, captureId);
    assert.equal(doc.tunnelId, 'test-tunnel');
    assert.ok(doc.timestamp);
    assert.equal(doc.websocket.path, '/echo');
    assert.equal(doc.websocket.headers['host'], 'example.com');
    assert.equal(doc.websocket.frames.length, 2);
    assert.equal(doc.websocket.frames[0].dir, 'client');
    assert.equal(doc.websocket.frames[0].data, 'ping');
    assert.equal(doc.websocket.frames[1].dir, 'server');
  });

  it('stores binary frames with base64 encoding', () => {
    const insp = makeInspector();
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64');
    const captureId = insp.captureWebSocket({
      path: '/bin',
      reqHeaders: {},
      frames: [{ dir: 'client', opcode: 2, encoding: 'base64', data: binaryData }],
    });

    const files = listFiles();
    const doc = readYaml(files[0]);
    assert.equal(doc.websocket.frames[0].encoding, 'base64');
    assert.equal(doc.websocket.frames[0].data, binaryData);
  });

  it('returns the captureId used in the filename', () => {
    const insp = makeInspector();
    const captureId = insp.captureWebSocket({ path: '/x', reqHeaders: {}, frames: [] });
    const files = listFiles();
    assert.ok(files[0].includes(captureId));
    assert.ok(files[0].startsWith(`test-tunnel.${captureId}`));
  });
});
