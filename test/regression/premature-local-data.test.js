/**
 * Regression tests — premature local data (poisoned socket) detection.
 *
 * Root cause:
 *   TunnelCluster pre-connects N sockets to the tunnel server before any request
 *   arrives. Node.js HTTP servers (e.g. n8n) have a headersTimeout (~60s) that
 *   sends HTTP/1.1 408 Request Timeout on idle connections that never sent headers.
 *   That 408 lands in the local socket buffer. When a real request finally arrives,
 *   socket.pipe(res) immediately discharges the buffered 408 as the response body.
 *
 * Fix (tunnel-cluster.js):
 *   In local.on('data'), if reqTotal === 0 (no request received yet), the socket is
 *   stale. Emit dead('premature-local-data', 'localDrop', retriable=true) and
 *   destroy both sockets.
 *
 * R11a — single poisoned pair: correct tunnel:dead payload, pair removed, failure
 *        budget untouched.
 * R11c — N simultaneous poisoned pairs (full headersTimeout storm): no pair
 *        survives, failure budget stays clean, shouldGiveUp() stays false.
 * R11d — a new pair opens cleanly after a premature-local-data death (retriable).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { FailureTracker } from '../../src/client/failure-tracker.js';
import { ReconnectPolicy } from '../../src/client/reconnect-policy.js';
import { TunnelCluster } from '../../src/client/tunnel-cluster.js';
import { waitFor } from '../helpers/wait-for.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HTTP_408 = Buffer.from(
  'HTTP/1.1 408 Request Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
);

/**
 * TCP server that accepts connections and immediately resumes them (consumes data).
 * sock.resume() is required so that write()+destroy() from the client side sends
 * RST cleanly without leaving the server socket in a half-open state.
 */
function createRemoteServer() {
  return new Promise(resolve => {
    const server = createTcpServer(sock => sock.resume());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Local server that sends HTTP 408 immediately when a socket connects. */
function createPoisonedLocalServer() {
  return new Promise(resolve => {
    const server = createTcpServer(sock => {
      sock.write(HTTP_408);
      sock.resume();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeInfo(tunnelPort) {
  return {
    tunnelId: 'test-tunnel',
    tunnelHost: '127.0.0.1',
    tunnelPort,
    maxConnections: 2,
    publicUrl: 'http://test.example.com',
    reconnectWindowMs: 100,
  };
}

function makeConfig(localPort, overrides = {}) {
  return {
    localAddress: '127.0.0.1',
    localPort,
    localTls: false,
    rewriteHostHeader: false,
    reconnectLocal: true,
    captureDir: null,
    ...overrides,
  };
}

function stopServer(server) {
  return new Promise(r => {
    server.closeAllConnections?.();
    server.close(r);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── R11a: single poisoned pair emits correct dead event ──────────────────────

describe('R11a: premature_local_data_dead_event — poisoned socket emits correct tunnel:dead', () => {
  it('emits tunnel:dead with reason=premature-local-data, kind=localDrop, retriable=true', async () => {
    const remoteServer = await createRemoteServer();
    const localServer = await createPoisonedLocalServer();

    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 10, maxTotal: 50 });
    const policy = new ReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 100 });
    const info = makeInfo(remoteServer.address().port);
    const config = makeConfig(localServer.address().port);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    const dead = await new Promise(resolve => {
      cluster.once('tunnel:dead', resolve);
      cluster.openOne().catch(() => {});
    });

    assert.equal(dead.reason, 'premature-local-data',
      'reason must identify the premature-data condition');
    assert.equal(dead.kind, 'localDrop',
      'kind must be localDrop');
    assert.equal(dead.retriable, true,
      'retriable must be true so the client opens a fresh pair');
    assert.equal(cluster.pairs.size, 0,
      'poisoned pair must be removed from the live pair set');
    assert.equal(tracker.totalFailures, 0,
      'premature-local-data must NOT consume the FailureTracker budget — it is normal n8n keep-alive behaviour');
    assert.equal(tracker.shouldGiveUp(), false,
      'a single poisoned socket must never trigger shouldGiveUp');

    await sleep(50);
    cluster.close();
    await stopServer(remoteServer);
    await stopServer(localServer);
  });
});

// ─── R11c: n8n headersTimeout storm — all N pairs poisoned simultaneously ────

describe('R11c: premature_local_data_storm — all pre-connected pairs poisoned simultaneously', () => {
  it('N simultaneous HTTP 408 events do not consume failure budget or trigger shouldGiveUp', async () => {
    const MAX_CONN = 5;

    const remoteServer = await createRemoteServer();
    const localServer = await createPoisonedLocalServer();

    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 10, maxTotal: 50 });
    const policy = new ReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 100 });
    const info = { ...makeInfo(remoteServer.address().port), maxConnections: MAX_CONN };
    const config = makeConfig(localServer.address().port);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    let deadCount = 0;
    const allDead = new Promise(resolve => {
      cluster.on('tunnel:dead', ({ reason }) => {
        assert.equal(reason, 'premature-local-data',
          'every dead event in a 408 storm must have reason=premature-local-data');
        if (++deadCount >= MAX_CONN) resolve();
      });
    });

    await Promise.allSettled(
      Array.from({ length: MAX_CONN }, () => cluster.openOne().catch(() => {}))
    );
    await allDead;

    assert.equal(deadCount, MAX_CONN, `all ${MAX_CONN} pairs must die with premature-local-data`);
    assert.equal(tracker.totalFailures, 0,
      `a ${MAX_CONN}-pair 408 storm must record 0 failures — this is normal n8n idle behaviour`);
    assert.equal(tracker.shouldGiveUp(), false,
      'a headersTimeout storm must never trigger shouldGiveUp');
    assert.equal(cluster.pairs.size, 0, 'all poisoned pairs must be removed');

    await sleep(50);
    cluster.close();
    await stopServer(remoteServer);
    await stopServer(localServer);
  });
});

// ─── R11d: recovery — new pair opens cleanly after premature-local-data ──────

describe('R11d: premature_local_data_recovery — fresh pair opens after poisoned one dies', () => {
  it('openOne succeeds when the next local connection is clean (no premature data)', async () => {
    let connectionCount = 0;
    const localServer = await new Promise(resolve => {
      const server = createTcpServer(sock => {
        connectionCount++;
        sock.resume();
        if (connectionCount === 1) {
          sock.write(HTTP_408); // First connection: send 408 (simulates idle headersTimeout)
        }
        // Subsequent connections: stay idle, waiting for request (normal behaviour)
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });

    const remoteServer = await createRemoteServer();

    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 10, maxTotal: 50 });
    const policy = new ReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 100 });
    const info = makeInfo(remoteServer.address().port);
    const config = makeConfig(localServer.address().port);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    // Phase 1: first pair dies with premature-local-data
    const dead = await new Promise(resolve => {
      cluster.once('tunnel:dead', resolve);
      cluster.openOne().catch(() => {});
    });
    assert.equal(dead.reason, 'premature-local-data', 'first pair must die with premature-local-data');
    assert.equal(dead.retriable, true, 'must be retriable');

    // Phase 2: open a replacement pair — must succeed (second connection is clean)
    const openP = new Promise(resolve => cluster.once('open', resolve));
    await cluster.openOne();
    await openP;

    await waitFor(() => cluster.pairs.size >= 1, {
      timeoutMs: 1000,
      message: 'replacement pair to be live',
    });

    assert.equal(cluster.pairs.size, 1,
      'a clean replacement pair must open after a poisoned one was discarded');

    cluster.close();
    await stopServer(remoteServer);
    await stopServer(localServer);
  });
});
