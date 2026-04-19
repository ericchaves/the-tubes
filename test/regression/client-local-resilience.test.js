/**
 * Regression tests — client local-service resilience.
 *
 * These tests guard against two specific bugs that caused tt-expose to exit
 * unexpectedly when the local app went down:
 *
 *   Bug 1 (R7): ECONNREFUSED was hardcoded as retriable=false.
 *               When the local app stopped, all pairs died non-retriably and
 *               tt-expose called process.exit(0) instead of waiting.
 *
 *   Bug 2 (R8): Node.js fires both 'error' AND 'close' (hadError=true) on the
 *               same socket. Without the localErrorHandled guard, each crash event
 *               was counted twice in FailureTracker. With maxConnections=5 and
 *               maxInWindow=10, a single app crash generated 10 failures, immediately
 *               triggering reconnect_loop_detected before any retry could happen.
 *
 *   R9 validates the recovery path: after ECONNREFUSED (budget untouched), a new
 *   pair.open must succeed once the local app is back on the same port.
 *
 * Architecture note: pairs are opened on demand via MockControlChannel.openPair().
 * The data server (accepting server representing the tt-server data port) accepts
 * the cluster's data socket — there is no data exchange in these tests, only
 * local connection lifecycle events are under test.
 *
 * NOTE on RST simulation (R8):
 *   socket.destroy() on an idle TCP connection sends FIN (clean close), not RST.
 *   socket.resetAndDestroy() (Node.js ≥ 18.3) forces RST and reliably triggers
 *   ECONNRESET on the client side, which is the condition the double-count bug
 *   required to manifest.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { FailureTracker } from '../../src/client/failure-tracker.js';
import { ReconnectPolicy } from '../../src/client/reconnect-policy.js';
import { TunnelCluster } from '../../src/client/tunnel-cluster.js';
import { MockControlChannel } from '../helpers/mock-control.js';
import { waitFor } from '../helpers/wait-for.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createAcceptingServer() {
  return new Promise(resolve => {
    const sockets = new Set();
    const server = createTcpServer(sock => {
      sockets.add(sock);
      sock.resume(); // flowing mode so FIN from data.end() is processed immediately
      sock.on('error', () => {});
      sock.once('close', () => sockets.delete(sock));
    });
    server._trackedSockets = sockets;
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeCluster(dataPort, localPort, opts = {}) {
  const control = new MockControlChannel();
  const info = {
    tunnelId: 'test-tunnel',
    tunnelHost: '127.0.0.1',
    tunnelPort: dataPort,
    maxConnections: opts.maxConnections ?? 2,
    publicUrl: 'http://test.example.com',
    reconnectWindowMs: 100,
  };
  const config = {
    localAddress: '127.0.0.1',
    localPort,
    localTls: false,
    rewriteHostHeader: false,
    reconnectLocal: true,
    captureDir: null,
  };
  const tracker = new FailureTracker(opts.tracker ?? { windowS: 60, maxInWindow: 10, maxTotal: 50 });
  const policy = new ReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 100 });
  const cluster = new TunnelCluster(info, config, tracker, policy, control);
  return { cluster, control, tracker };
}

function stopServer(server) {
  return new Promise(r => {
    // Use end() not destroy() so the peer doesn't receive ECONNRESET (which
    // would trigger error handlers in still-live client sockets).
    for (const s of server._trackedSockets ?? []) {
      try { s.end(); } catch {}
    }
    server.close(r);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── R7: ECONNREFUSED is retriable and does not consume FailureTracker budget ─

describe('R7: econnrefused_retriable — ECONNREFUSED is retriable and does not consume FailureTracker budget', () => {
  it('single ECONNREFUSED emits retriable=true and records zero failures', async () => {
    const dataServer = await createAcceptingServer();

    // Port 1: system-reserved, never listening → guaranteed ECONNREFUSED on non-root
    const { cluster, control, tracker } = makeCluster(dataServer.address().port, 1, {
      tracker: { windowS: 60, maxInWindow: 10, maxTotal: 50 },
    });

    const dead = await new Promise(resolve => {
      cluster.once('tunnel:dead', resolve);
      control.openPair();
    });

    assert.equal(dead.retriable, true,
      'ECONNREFUSED must produce retriable=true so the expose client keeps waiting');
    assert.equal(dead.kind, 'localConnect');
    assert.equal(dead.reason, 'ECONNREFUSED');
    assert.equal(tracker.totalFailures, 0,
      'ECONNREFUSED must NOT consume the FailureTracker budget — it is not a loop failure');
    assert.equal(tracker.shouldGiveUp(), false,
      'single ECONNREFUSED must not trigger shouldGiveUp');

    cluster.close();
    await stopServer(dataServer);
  });

  it('maxConnections simultaneous ECONNREFUSED events do not trigger shouldGiveUp', async () => {
    const MAX_CONN = 5;
    const dataServer = await createAcceptingServer();

    const { cluster, control, tracker } = makeCluster(dataServer.address().port, 1, {
      maxConnections: MAX_CONN,
      tracker: { windowS: 60, maxInWindow: 10, maxTotal: 50 },
    });

    let deadCount = 0;
    const allDead = new Promise(resolve => {
      cluster.on('tunnel:dead', () => { if (++deadCount >= MAX_CONN) resolve(); });
    });

    for (let i = 0; i < MAX_CONN; i++) control.openPair();
    await allDead;

    assert.equal(tracker.totalFailures, 0,
      `${MAX_CONN} simultaneous ECONNREFUSED must record 0 failures in FailureTracker`);
    assert.equal(tracker.shouldGiveUp(), false,
      'ECONNREFUSED storm must not trigger shouldGiveUp — local app may come back up');

    cluster.close();
    await stopServer(dataServer);
  });
});

// ─── R8: ECONNRESET on established connection is counted once, not twice ─────

describe('R8: crash_no_double_count — ECONNRESET on established connection is counted once, not twice', () => {
  it('ECONNRESET on one established local socket registers exactly 1 failure', async () => {
    const serverSockets = [];
    const rstServer = createTcpServer(sock => serverSockets.push(sock));
    await new Promise(r => rstServer.listen(0, '127.0.0.1', r));
    const rstPort = rstServer.address().port;

    const dataServer = await createAcceptingServer();
    const { cluster, control, tracker } = makeCluster(dataServer.address().port, rstPort, {
      tracker: { windowS: 60, maxInWindow: 20, maxTotal: 100 },
    });

    const openP = new Promise(resolve => cluster.once('open', resolve));
    control.openPair();
    await openP;

    await waitFor(() => serverSockets.length >= 1, {
      timeoutMs: 1000, message: 'local connection accepted by server',
    });

    const deadP = new Promise(resolve => cluster.once('tunnel:dead', resolve));
    serverSockets[0].resetAndDestroy();
    await deadP;
    await sleep(30);

    assert.equal(tracker.totalFailures, 1,
      'ECONNRESET should register exactly 1 failure — error+close must not double-count');

    cluster.close();
    await stopServer(rstServer);
    await stopServer(dataServer);
  });

  it('maxConnections simultaneous app crashes register N failures, not 2N', async () => {
    const MAX_CONN = 5;

    const serverSockets = [];
    const rstServer = createTcpServer(sock => serverSockets.push(sock));
    await new Promise(r => rstServer.listen(0, '127.0.0.1', r));
    const rstPort = rstServer.address().port;

    const dataServer = await createAcceptingServer();
    const { cluster, control, tracker } = makeCluster(dataServer.address().port, rstPort, {
      maxConnections: MAX_CONN,
      tracker: { windowS: 60, maxInWindow: 10, maxTotal: 50 },
    });

    let openCount = 0;
    const allOpened = new Promise(resolve => {
      cluster.on('open', () => { if (++openCount >= MAX_CONN) resolve(); });
    });
    for (let i = 0; i < MAX_CONN; i++) control.openPair();
    await allOpened;

    await waitFor(() => serverSockets.length >= MAX_CONN, {
      timeoutMs: 2000, message: `all ${MAX_CONN} local connections accepted`,
    });

    let deadCount = 0;
    const allDead = new Promise(resolve => {
      cluster.on('tunnel:dead', () => { if (++deadCount >= MAX_CONN) resolve(); });
    });
    for (const s of serverSockets) s.resetAndDestroy();
    await allDead;
    await sleep(50);

    assert.equal(tracker.totalFailures, MAX_CONN,
      `app crash with ${MAX_CONN} connections must register ${MAX_CONN} failures, not ${MAX_CONN * 2}`);
    assert.equal(tracker.shouldGiveUp(), false,
      'a single app crash must not trigger shouldGiveUp — the expose client must stay alive');

    cluster.close();
    await stopServer(rstServer);
    await stopServer(dataServer);
  });
});

// ─── R9: pairs reopen successfully once the local app comes back ──────────────

describe('R9: local_app_recovery — pairs reopen successfully once the local app comes back', () => {
  it('pair opens successfully after the local app restarts following ECONNREFUSED', async () => {
    const portClaimer = await createAcceptingServer();
    const localPort = portClaimer.address().port;
    await stopServer(portClaimer);

    const dataServer = await createAcceptingServer();
    const { cluster, control, tracker } = makeCluster(dataServer.address().port, localPort);

    // Phase 1: local port closed → ECONNREFUSED → retriable, budget untouched
    const dead = await new Promise(resolve => {
      cluster.once('tunnel:dead', resolve);
      control.openPair();
    });

    assert.equal(dead.retriable, true, 'ECONNREFUSED must be retriable');
    assert.equal(dead.reason, 'ECONNREFUSED');
    assert.equal(tracker.totalFailures, 0,
      'FailureTracker budget must be untouched while waiting for local app');

    // Phase 2: restart local app on the same port
    const localServer = createTcpServer();
    await new Promise(resolve => localServer.listen(localPort, '127.0.0.1', resolve));

    // Phase 3: next pair.open must succeed
    const openP = new Promise(resolve => cluster.once('open', resolve));
    control.openPair();
    await openP;

    assert.ok(cluster.pairs.size >= 1,
      'pair must open successfully once the local app is back on the same port');

    cluster.close();
    await stopServer(localServer);
    await stopServer(dataServer);
  });
});
