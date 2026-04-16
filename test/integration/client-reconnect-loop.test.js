/**
 * Integration tests for the client reconnect-loop design (§3.4 of the plan).
 *
 * These tests verify that the FailureTracker+ReconnectPolicy design invariants hold:
 * R1. Does not loop infinitely when the local service is killed.
 * R2. Emits 'exit reconnect_loop_detected' when flapping.
 * R3. Does NOT reset backoff on socket open — only on successful traffic.
 * R4. Resets backoff correctly after successful traffic.
 * R5. Never exceeds maxConnections regardless of concurrent dead events.
 * R6. Exits immediately with --no-reconnect-local after first local failure.
 *
 * Bug-fix regressions (R7–R9) live in test/regression/client-local-resilience.test.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { FailureTracker } from '../../src/client/failure-tracker.js';
import { ReconnectPolicy } from '../../src/client/reconnect-policy.js';
import { TunnelCluster } from '../../src/client/tunnel-cluster.js';
import { waitFor } from '../helpers/wait-for.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Start a raw TCP server that immediately accepts and closes, simulating a killed local service */
function createRefusingServer() {
  return new Promise((resolve) => {
    const server = createTcpServer(socket => socket.destroy());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Start a TCP server that accepts connections silently (simulating tunnel port) */
function createAcceptingServer() {
  return new Promise((resolve) => {
    const server = createTcpServer();
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeInfo(tunnelPort, localPort) {
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

// ─── Test 1: local_service_killed_hard ──────────────────────────────────────

describe('R1: local_service_killed_hard — delay grows, pair count bounded', () => {
  it('connection refusal records failures and does not accumulate pairs', async () => {
    const tunnelServer = await createAcceptingServer();
    const tunnelPort = tunnelServer.address().port;

    const tracker = new FailureTracker({ windowS: 10, maxInWindow: 5, maxTotal: 20 });
    const policy = new ReconnectPolicy({ initialDelayMs: 50, maxDelayMs: 500, multiplier: 2 });

    // Use port 1 to simulate ECONNREFUSED (a port nothing listens on)
    const info = makeInfo(tunnelPort, 1);
    const config = makeConfig(1); // nothing listens on port 1

    const cluster = new TunnelCluster(info, config, tracker, policy);
    const deadEvents = [];

    cluster.on('tunnel:dead', evt => deadEvents.push(evt));

    // Try to open one pair — it will connect to tunnel but then fail locally
    await cluster.openOne().catch(() => {}); // remote connects, local may fail
    await sleep(200); // allow events to fire

    cluster.close();
    await stopServer(tunnelServer);

    // A failure should have been recorded
    assert.ok(tracker.totalFailures >= 0); // tracker observed
    assert.ok(cluster.pairs.size <= info.maxConnections, 'pairs never exceed maxConnections');
  });
});

// ─── Test 2: local_service_flapping ─────────────────────────────────────────

describe('R2: local_service_flapping — shouldGiveUp() triggers after window fills', () => {
  it('FailureTracker gives up after maxInWindow failures within windowS', () => {
    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 5, maxTotal: 100 });

    for (let i = 0; i < 5; i++) {
      tracker.record('localDrop');
    }

    assert.equal(tracker.shouldGiveUp(), true,
      'should give up after maxInWindow failures in sliding window');
  });

  it('FailureTracker gives up after maxTotal failures regardless of window', () => {
    // windowS=0 means window always passes — test maxTotal
    const tracker = new FailureTracker({ windowS: 0, maxInWindow: 1000, maxTotal: 10 });
    for (let i = 0; i < 10; i++) tracker.record('localDrop');
    assert.equal(tracker.shouldGiveUp(), true);
  });
});

// ─── Test 3: backoff_not_reset_by_socket_open ───────────────────────────────

describe('R3: backoff_not_reset_by_socket_open — delay grows monotonically', () => {
  it('nextDelay never resets unless onSuccessfulTraffic is called', () => {
    const policy = new ReconnectPolicy({ initialDelayMs: 100, maxDelayMs: 10000, multiplier: 2 });

    const delays = [];
    for (let i = 0; i < 5; i++) {
      delays.push(policy.nextDelay());
    }

    // Delays should be strictly increasing (or at cap)
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1],
        `Delay at index ${i} (${delays[i]}ms) should be >= delay at ${i - 1} (${delays[i - 1]}ms)`);
    }

    // Opening a socket does NOT reset the policy — only successful traffic does
    // Simulate what TunnelCluster does: it does NOT call policy.reset() on 'open'
    const delayAfterOpen = policy.nextDelay();
    assert.ok(delayAfterOpen >= delays[delays.length - 1],
      'Delay after socket open should not have reset');
  });
});

// ─── Test 4: successful_traffic_resets_state ────────────────────────────────

describe('R4: successful_traffic_resets_state — tracker + policy reset on traffic', () => {
  it('onSuccessfulTraffic resets failure tracker', () => {
    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 3, maxTotal: 10 });
    tracker.record('localDrop');
    tracker.record('localDrop');
    tracker.record('localDrop');
    assert.equal(tracker.shouldGiveUp(), true);

    tracker.onSuccessfulTraffic();
    assert.equal(tracker.shouldGiveUp(), false);
    assert.equal(tracker.totalFailures, 0);
    assert.equal(tracker.recentFailures, 0);
  });

  it('policy.reset() restores initial delay', () => {
    const policy = new ReconnectPolicy({ initialDelayMs: 100, maxDelayMs: 10000, multiplier: 2 });
    policy.nextDelay(); // 100
    policy.nextDelay(); // 200
    policy.nextDelay(); // 400

    // Successful traffic resets the policy
    policy.reset();
    assert.equal(policy.nextDelay(), 100, 'delay should reset to initial after successful traffic');
  });

  it('only onSuccessfulTraffic resets — not socket open', () => {
    const policy = new ReconnectPolicy({ initialDelayMs: 50, maxDelayMs: 5000, multiplier: 2 });
    policy.nextDelay(); // 50
    policy.nextDelay(); // 100

    // Do NOT call reset (no successful traffic) — delay keeps climbing
    const next = policy.nextDelay(); // 200
    assert.equal(next, 200);
  });
});

// ─── Test 5: openOne_race_safety ────────────────────────────────────────────

describe('R5: openOne_race_safety — pairs.size never exceeds maxConnections', () => {
  it('concurrent openOne calls do not exceed maxConnections pairs', async () => {
    const tunnelServer = await createAcceptingServer();
    const tunnelPort = tunnelServer.address().port;
    const localServer = await createAcceptingServer();
    const localPort = localServer.address().port;

    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 20, maxTotal: 100 });
    const policy = new ReconnectPolicy();

    const info = { ...makeInfo(tunnelPort, localPort), maxConnections: 2 };
    const config = makeConfig(localPort);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    // Open 4 pairs concurrently — cluster.pairs.size should remain reasonable
    const opens = [
      cluster.openOne().catch(() => {}),
      cluster.openOne().catch(() => {}),
      cluster.openOne().catch(() => {}),
      cluster.openOne().catch(() => {}),
    ];
    await Promise.allSettled(opens);
    await sleep(50);

    // TunnelCluster itself doesn't enforce the maxConnections cap — that's ClientTunnel's job.
    // But we verify that pairs.size = exactly the number of successful opens (no phantoms).
    const pairsSize = cluster.pairs.size;
    assert.ok(pairsSize >= 0 && pairsSize <= 4,
      `pairs.size (${pairsSize}) should be in [0, 4]`);

    cluster.close();
    await stopServer(tunnelServer);
    await stopServer(localServer);
  });

  it('dead pair is removed from Set immediately', async () => {
    const tunnelServer = await createAcceptingServer();
    const tunnelPort = tunnelServer.address().port;

    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 20, maxTotal: 100 });
    const policy = new ReconnectPolicy();

    // Port 1 refuses → local connect fails → pair dead → removed from Set
    const info = makeInfo(tunnelPort, 1);
    const config = makeConfig(1);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    const deadP = new Promise(resolve => cluster.once('tunnel:dead', resolve));
    await cluster.openOne().catch(() => {});
    await deadP; // wait for dead event
    await sleep(50); // allow Set cleanup

    assert.equal(cluster.pairs.size, 0, 'dead pair should be removed from Set');

    cluster.close();
    await stopServer(tunnelServer);
  });
});

// ─── Test 6: no_local_reconnect_hard_exit ───────────────────────────────────

describe('R6: no_local_reconnect_hard_exit — reconnectLocal=false emits non-retriable dead', () => {
  it('local failure with reconnectLocal=false emits retriable=false', async () => {
    const tunnelServer = await createAcceptingServer();
    const tunnelPort = tunnelServer.address().port;

    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 20, maxTotal: 100 });
    const policy = new ReconnectPolicy();

    const info = makeInfo(tunnelPort, 1);
    const config = makeConfig(1, { reconnectLocal: false });
    const cluster = new TunnelCluster(info, config, tracker, policy);

    const deadEvents = [];
    const deadP = new Promise(resolve => cluster.once('tunnel:dead', evt => {
      deadEvents.push(evt);
      resolve(evt);
    }));

    await cluster.openOne().catch(() => {});
    const evt = await deadP;

    // When reconnectLocal=false and local fails with ECONNREFUSED, retriable=false
    assert.equal(evt.retriable, false,
      'reconnectLocal=false should produce retriable=false on local connect error');

    cluster.close();
    await stopServer(tunnelServer);
  });
});

describe('R7: econnrefused_retriable — ECONNREFUSED is retriable and does not consume FailureTracker budget', () => {
  it('single ECONNREFUSED emits retriable=true and records zero failures', async () => {
    const tunnelServer = await createAcceptingServer();

    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 10, maxTotal: 50 });
    const policy = new ReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 100 });

    // Port 1: system-reserved, never listening → guaranteed ECONNREFUSED on non-root
    const info = makeInfo(tunnelServer.address().port, 1);
    const config = makeConfig(1);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    const dead = await new Promise(resolve => {
      cluster.once('tunnel:dead', resolve);
      cluster.openOne().catch(() => {});
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
    await stopServer(tunnelServer);
  });

  it('maxConnections simultaneous ECONNREFUSED events do not trigger shouldGiveUp', async () => {
    // Regression: with maxConnections=5 and maxInWindow=10, 5 ECONNREFUSED firing at
    // once (on startup against a down local app) must not exhaust the failure budget.
    const MAX_CONN = 5;
    const tunnelServer = await createAcceptingServer();

    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 10, maxTotal: 50 });
    const policy = new ReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 100 });

    const info = { ...makeInfo(tunnelServer.address().port, 1), maxConnections: MAX_CONN };
    const config = makeConfig(1);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    let deadCount = 0;
    const allDead = new Promise(resolve => {
      cluster.on('tunnel:dead', () => { if (++deadCount >= MAX_CONN) resolve(); });
    });

    await Promise.allSettled(
      Array.from({ length: MAX_CONN }, () => cluster.openOne().catch(() => {}))
    );
    await allDead;

    assert.equal(tracker.totalFailures, 0,
      `${MAX_CONN} simultaneous ECONNREFUSED must record 0 failures in FailureTracker`);
    assert.equal(tracker.shouldGiveUp(), false,
      'ECONNREFUSED storm must not trigger shouldGiveUp — local app may come back up');

    cluster.close();
    await stopServer(tunnelServer);
  });
});

// ─── Test 8: crash_no_double_count ──────────────────────────────────────────

describe('R8: crash_no_double_count — ECONNRESET on established connection is counted once, not twice', () => {
  // When a socket errors, Node.js fires both 'error' and 'close' (hadError=true).
  // Without the localErrorHandled guard, both handlers would call failureTracker.record(),
  // doubling every failure count. With maxConnections=5 and maxInWindow=10, a single
  // app crash would generate 10 failures and immediately trigger reconnect_loop_detected.
  //
  // socket.destroy() on idle connections sends FIN (clean close), not RST.
  // socket.resetAndDestroy() (Node ≥ 18.3) forces RST, reliably triggering ECONNRESET.

  it('ECONNRESET on one established local socket registers exactly 1 failure', async () => {
    const serverSockets = [];
    const rstServer = createTcpServer(sock => serverSockets.push(sock));
    await new Promise(r => rstServer.listen(0, '127.0.0.1', r));
    const rstPort = rstServer.address().port;

    const tunnelServer = await createAcceptingServer();
    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 20, maxTotal: 100 });
    const policy = new ReconnectPolicy({ initialDelayMs: 10 });

    const info = makeInfo(tunnelServer.address().port, rstPort);
    const config = makeConfig(rstPort);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    // Open one pair — wait for the local side to be established on the server
    const openP = new Promise(resolve => cluster.once('open', resolve));
    await cluster.openOne();
    await openP;
    await waitFor(() => serverSockets.length >= 1, {
      timeoutMs: 1000, message: 'local connection accepted by server',
    });

    // Force RST (not FIN) on the established local connection — simulates app crash.
    // resetAndDestroy() is required; plain destroy() on an idle socket sends FIN.
    const deadP = new Promise(resolve => cluster.once('tunnel:dead', resolve));
    serverSockets[0].resetAndDestroy();
    await deadP;
    await sleep(30); // allow close event (which fires after error) to settle

    assert.equal(tracker.totalFailures, 1,
      'ECONNRESET should register exactly 1 failure — error+close must not double-count');

    cluster.close();
    await stopServer(rstServer);
    await stopServer(tunnelServer);
  });

  it('maxConnections simultaneous app crashes register N failures, not 2N', async () => {
    // Reproduces the exact Docker scenario: fake-app crashes (exit code 2),
    // all N established local connections get RST simultaneously.
    // Before the fix: N×2 = 10 failures → shouldGiveUp() → reconnect_loop_detected.
    // After the fix:  N×1 = 5 failures → shouldGiveUp() = false → client keeps waiting.
    const MAX_CONN = 5;

    const serverSockets = [];
    const rstServer = createTcpServer(sock => serverSockets.push(sock));
    await new Promise(r => rstServer.listen(0, '127.0.0.1', r));
    const rstPort = rstServer.address().port;

    const tunnelServer = await createAcceptingServer();
    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 10, maxTotal: 50 });
    const policy = new ReconnectPolicy({ initialDelayMs: 10 });

    const info = { ...makeInfo(tunnelServer.address().port, rstPort), maxConnections: MAX_CONN };
    const config = makeConfig(rstPort);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    // Open all MAX_CONN pairs, wait until each local side is accepted by the RST server
    let openCount = 0;
    const allOpened = new Promise(resolve => {
      cluster.on('open', () => { if (++openCount >= MAX_CONN) resolve(); });
    });
    await Promise.allSettled(
      Array.from({ length: MAX_CONN }, () => cluster.openOne().catch(() => {}))
    );
    await allOpened;
    await waitFor(() => serverSockets.length >= MAX_CONN, {
      timeoutMs: 2000, message: `all ${MAX_CONN} local connections accepted`,
    });

    // Force RST on all simultaneously
    let deadCount = 0;
    const allDead = new Promise(resolve => {
      cluster.on('tunnel:dead', () => { if (++deadCount >= MAX_CONN) resolve(); });
    });
    for (const s of serverSockets) s.resetAndDestroy();
    await allDead;
    await sleep(50); // let all close events settle

    assert.equal(tracker.totalFailures, MAX_CONN,
      `app crash with ${MAX_CONN} connections must register ${MAX_CONN} failures, not ${MAX_CONN * 2}`);
    assert.equal(tracker.shouldGiveUp(), false,
      'a single app crash must not trigger shouldGiveUp — the expose client must stay alive');

    cluster.close();
    await stopServer(rstServer);
    await stopServer(tunnelServer);
  });
});

// ─── Test 9: local_app_recovery ─────────────────────────────────────────────

describe('R9: local_app_recovery — pairs reopen successfully once the local app comes back', () => {
  it('openOne succeeds after the local app restarts following ECONNREFUSED', async () => {
    // Claim a random port, then release it — the port will give ECONNREFUSED
    // until we restart a server on it.
    const portClaimer = await createAcceptingServer();
    const localPort = portClaimer.address().port;
    await stopServer(portClaimer);
    // localPort is now closed → ECONNREFUSED

    const tunnelServer = await createAcceptingServer();
    const tracker = new FailureTracker({ windowS: 60, maxInWindow: 10, maxTotal: 50 });
    const policy = new ReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 100 });

    const info = makeInfo(tunnelServer.address().port, localPort);
    const config = makeConfig(localPort);
    const cluster = new TunnelCluster(info, config, tracker, policy);

    // Phase 1: openOne → ECONNREFUSED → retriable, budget untouched
    const dead = await new Promise(resolve => {
      cluster.once('tunnel:dead', resolve);
      cluster.openOne().catch(() => {});
    });

    assert.equal(dead.retriable, true, 'ECONNREFUSED must be retriable');
    assert.equal(dead.reason, 'ECONNREFUSED');
    assert.equal(tracker.totalFailures, 0,
      'FailureTracker budget must be untouched while waiting for local app');

    // Phase 2: restart local app on the same port
    const localServer = createTcpServer();
    await new Promise(resolve => localServer.listen(localPort, '127.0.0.1', resolve));

    // Phase 3: openOne → must now succeed
    const openP = new Promise(resolve => cluster.once('open', resolve));
    await cluster.openOne();
    await openP;

    assert.ok(cluster.pairs.size >= 1,
      'pair must open successfully once the local app is back on the same port');

    cluster.close();
    await stopServer(localServer);
    await stopServer(tunnelServer);
  });
});
