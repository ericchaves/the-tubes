/**
 * Regression tests — WebSocket capture in TunnelCluster.
 *
 * Three bugs are covered:
 *
 *   WS-1: WS captures were silently deferred to container shutdown.
 *     Root cause: capture was only in local.once('close'), which never fires
 *     during a live WS session — the pipe remote→local keeps local open until
 *     remote sends EOF, and handleUpgrade uses socket.destroy() (RST), not end().
 *     Fix: remote.once('end') registered inside local.once('connect') fires
 *     immediately on graceful FIN and captures the exchange right away.
 *
 *   WS-2: After remote is force-closed (RST/destroy), local was never destroyed,
 *     so local.once('close') never fired even for cleanup captures.
 *     Fix: remote.once('close') now calls pair.local.destroy() unconditionally,
 *     ensuring local.once('close') always fires regardless of how remote closed.
 *
 *   WS-3: Both remote.once('end') and local.once('close') could fire for the same
 *     session, producing two .ws.yaml files for one exchange.
 *     Fix: remote.once('end') zeroes reqBufs after capturing so the local.once('close')
 *     handler finds no data and skips the second write.
 *
 * Architecture note: tests use MockControlChannel to trigger pair creation.
 * The data server reads the TT/1 PAIR preamble before writing upgrade bytes.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createTcpServer } from 'node:net';
import { FailureTracker } from '../../src/client/failure-tracker.js';
import { ReconnectPolicy } from '../../src/client/reconnect-policy.js';
import { TunnelCluster } from '../../src/client/tunnel-cluster.js';
import { MockControlChannel } from '../helpers/mock-control.js';
import { parse } from '../../src/common/yaml-lite.js';

// ─── WS frame helpers ─────────────────────────────────────────────────────────

function clientTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const maskKey = Buffer.from([0x37, 0x42, 0x1a, 0x2b]);
  const frame = Buffer.allocUnsafe(2 + 4 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  maskKey.copy(frame, 2);
  for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ maskKey[i % 4];
  return frame;
}

function serverTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const frame = Buffer.allocUnsafe(2 + payload.length);
  frame[0] = 0x81;
  frame[1] = payload.length;
  payload.copy(frame, 2);
  return frame;
}

const HTTP_UPGRADE_REQUEST =
  'GET /echo HTTP/1.1\r\n' +
  'Host: test.example.com\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
  'Sec-WebSocket-Version: 13\r\n' +
  '\r\n';

const HTTP_101_RESPONSE =
  'HTTP/1.1 101 Switching Protocols\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  '\r\n';

// ─── Test infrastructure ──────────────────────────────────────────────────────

function makeCluster(tunnelPort, localPort, captureDir) {
  const control = new MockControlChannel();
  const info = {
    tunnelId: 'ws-test',
    tunnelHost: '127.0.0.1',
    tunnelPort,
    publicUrl: 'http://ws-test.example.com',
    reconnectWindowMs: 100,
  };
  const config = {
    localAddress: '127.0.0.1',
    localPort,
    localTls: false,
    rewriteHostHeader: false,
    reconnectLocal: true,
    captureDir,
    captureEnabled: true,
  };
  const tracker = new FailureTracker({ windowS: 60, maxInWindow: 20, maxTotal: 100 });
  const policy = new ReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 100 });
  return { cluster: new TunnelCluster(info, config, tracker, policy, control), control };
}

function createTrackedServer(handler) {
  const sockets = new Set();
  const server = createTcpServer(sock => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.once('close', () => sockets.delete(sock));
    handler(sock);
  });
  server._trackedSockets = sockets;
  return server;
}

/**
 * Data server that consumes the TT/1 PAIR preamble before handing the socket
 * to the provided handler.
 */
function createDataServer(handler) {
  return createTrackedServer(sock => {
    let buf = Buffer.alloc(0);
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.indexOf('\n') === -1) return;
      sock.removeListener('data', onData);
      handler(sock);
    };
    sock.on('data', onData);
  });
}

function listen(server) {
  return new Promise(r => server.listen(0, '127.0.0.1', r));
}

function stopTracked(server) {
  for (const s of server._trackedSockets ?? []) s.destroy();
  return new Promise(r => server.close(r));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function wsFiles(dir) {
  return readdirSync(dir).filter(f => f.endsWith('.ws.yaml'));
}

function awaitCapture(cluster, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timeout: no capture event received')),
      timeoutMs,
    );
    cluster.once('capture', data => { clearTimeout(timer); resolve(data); });
  });
}

// ─── WS-1: capture via remote.once('end') on graceful FIN ────────────────────

describe('WS-1: ws_graceful_capture — capture fires immediately via remote.once("end")', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ws-cap-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes a .ws.yaml when tunnel server sends FIN (graceful close)', async () => {
    const localServer = createTrackedServer(sock => {
      sock.write(Buffer.concat([
        Buffer.from(HTTP_101_RESPONSE),
        serverTextFrame('echo: hi'),
      ]));
    });
    await listen(localServer);

    // Data server: consume preamble, then send Upgrade request + client frame, then FIN.
    const dataServer = createDataServer(sock => {
      sock.write(Buffer.concat([
        Buffer.from(HTTP_UPGRADE_REQUEST),
        clientTextFrame('hi'),
      ]));
      setTimeout(() => sock.end(), 30);
    });
    await listen(dataServer);

    const { cluster, control } = makeCluster(
      dataServer.address().port,
      localServer.address().port,
      tmpDir,
    );

    const captureP = awaitCapture(cluster);
    control.openPair({ kind: 'ws', method: 'GET', path: '/echo' });
    const captured = await captureP;

    assert.equal(captured.method, 'WS');
    assert.ok(captured.captureId, 'captureId must be present');
    assert.equal(captured.file, `ws-test.${captured.captureId}.ws.yaml`);

    const files = wsFiles(tmpDir);
    assert.equal(files.length, 1, 'exactly one .ws.yaml must be written');

    const doc = parse(readFileSync(join(tmpDir, files[0]), 'utf8'));
    assert.equal(doc.websocket.path, '/echo');
    assert.ok(Array.isArray(doc.websocket.frames));

    const clientF = doc.websocket.frames.find(f => f.dir === 'client' && f.opcode === 1);
    assert.ok(clientF, 'client text frame must be captured');
    assert.equal(clientF.data, 'hi', 'client frame payload must be unmasked correctly');

    const serverF = doc.websocket.frames.find(f => f.dir === 'server' && f.opcode === 1);
    assert.ok(serverF, 'server text frame must be captured');
    assert.equal(serverF.data, 'echo: hi');

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(dataServer);
  });
});

// ─── WS-2: local.destroy() called when remote is force-closed ────────────────

describe('WS-2: ws_force_close_capture — local.destroy() called on remote RST so local.once("close") fires', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ws-rst-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes a .ws.yaml when tunnel server is destroyed (RST) — local.once("close") must fire', async () => {
    const localServer = createTrackedServer(sock => {
      sock.write(Buffer.concat([
        Buffer.from(HTTP_101_RESPONSE),
        serverTextFrame('echo: hello'),
      ]));
    });
    await listen(localServer);

    const dataServer = createDataServer(sock => {
      sock.write(Buffer.concat([
        Buffer.from(HTTP_UPGRADE_REQUEST),
        clientTextFrame('hello'),
      ]));
      setTimeout(() => sock.resetAndDestroy(), 20);
    });
    await listen(dataServer);

    const { cluster, control } = makeCluster(
      dataServer.address().port,
      localServer.address().port,
      tmpDir,
    );

    const captureP = awaitCapture(cluster);
    control.openPair({ kind: 'ws', method: 'GET', path: '/echo' });
    const captured = await captureP;

    assert.equal(captured.method, 'WS');
    assert.ok(captured.captureId);

    const files = wsFiles(tmpDir);
    assert.equal(files.length, 1, '.ws.yaml must be written even when remote was RST-closed');

    const doc = parse(readFileSync(join(tmpDir, files[0]), 'utf8'));
    assert.equal(doc.websocket.path, '/echo');

    const clientF = doc.websocket.frames.find(f => f.dir === 'client' && f.opcode === 1);
    assert.ok(clientF, 'client frame must be captured via local.once("close") path');
    assert.equal(clientF.data, 'hello');

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(dataServer);
  });
});

// ─── WS-3: no double capture ──────────────────────────────────────────────────

describe('WS-3: ws_no_double_capture — exactly one .ws.yaml written per session', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ws-dedup-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes exactly one .ws.yaml even when both remote.once("end") and local.once("close") fire', async () => {
    const localServer = createTrackedServer(sock => {
      sock.write(Buffer.concat([
        Buffer.from(HTTP_101_RESPONSE),
        serverTextFrame('pong'),
      ]));
    });
    await listen(localServer);

    const dataServer = createDataServer(sock => {
      sock.write(Buffer.concat([
        Buffer.from(HTTP_UPGRADE_REQUEST),
        clientTextFrame('ping'),
      ]));
      setTimeout(() => sock.end(), 30);
    });
    await listen(dataServer);

    const { cluster, control } = makeCluster(
      dataServer.address().port,
      localServer.address().port,
      tmpDir,
    );

    const captureP = awaitCapture(cluster);
    control.openPair({ kind: 'ws', method: 'GET', path: '/echo' });
    await captureP;

    await sleep(80);

    const files = wsFiles(tmpDir);
    assert.equal(files.length, 1,
      'reqBufs.length=0 guard must prevent a second .ws.yaml from local.once("close")');

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(dataServer);
  });
});
