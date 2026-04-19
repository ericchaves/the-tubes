/**
 * Regression tests — HTTP request event early detection in TunnelCluster.
 *
 * Bug: the 'request' event was deferred to local socket close, which never
 * fires during HTTP keep-alive sessions.  For a typical webhook handled by a
 * Node.js HTTP server the response was delivered but no event appeared in the
 * /tubes admin console until the keep-alive timeout expired (~5 s).
 *
 * Root cause: detection was only in local.once('close').  A Node.js HTTP server
 * uses keep-alive by default, so the socket stays open after responding, and
 * local.once('close') never fires until the idle timeout expires.
 *
 * Fix: tryEmitResponseComplete() examines incoming response bytes and emits the
 * 'request' event as soon as the HTTP message is complete:
 *
 *   HTTP-EV-1  Content-Length          → emits before socket close
 *   HTTP-EV-2  Transfer-Encoding: chunked → emits on terminal chunk
 *   HTTP-EV-3  No-body status (204/304) → emits immediately on headers
 *   HTTP-EV-4  No length hint (HTTP/1.0) → falls back to socket close
 *   HTTP-EV-5  No double emission when socket closes after early emit
 *   HTTP-EV-6  SSE stream (long-lived)  → no premature emit; fires on close
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { FailureTracker } from '../../src/client/failure-tracker.js';
import { ReconnectPolicy } from '../../src/client/reconnect-policy.js';
import { TunnelCluster } from '../../src/client/tunnel-cluster.js';

// ─── HTTP message helpers ─────────────────────────────────────────────────────

const HTTP_POST_REQUEST =
  'POST /webhook HTTP/1.1\r\n' +
  'Host: test.example.com\r\n' +
  'Content-Type: application/json\r\n' +
  'Content-Length: 2\r\n' +
  '\r\n' +
  '{}';

const HTTP_GET_REQUEST =
  'GET /events HTTP/1.1\r\n' +
  'Host: test.example.com\r\n' +
  'Accept: text/event-stream\r\n' +
  '\r\n';

/**
 * Build a minimal HTTP/1.1 response string.
 * @param {number} status
 * @param {string} statusText
 * @param {string} [extraHeaders]  Each header must include its trailing \r\n.
 * @param {string} [body]
 */
function httpResponse(status, statusText, extraHeaders = '', body = '') {
  return `HTTP/1.1 ${status} ${statusText}\r\n${extraHeaders}\r\n${body}`;
}

// ─── Test infrastructure ──────────────────────────────────────────────────────

function makeCluster(tunnelPort, localPort) {
  const info = {
    tunnelId: 'http-ev-test',
    tunnelHost: '127.0.0.1',
    tunnelPort,
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
  const tracker = new FailureTracker({ windowS: 60, maxInWindow: 20, maxTotal: 100 });
  const policy  = new ReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 100 });
  return new TunnelCluster(info, config, tracker, policy);
}

/** TCP server that tracks accepted sockets so teardown never hangs. */
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

function listen(server) {
  return new Promise(r => server.listen(0, '127.0.0.1', r));
}

function stopTracked(server) {
  for (const s of server._trackedSockets ?? []) s.destroy();
  return new Promise(r => server.close(r));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Resolve with the first 'request' event from cluster, or reject after timeoutMs.
 */
function awaitRequest(cluster, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('Timeout: no request event received')),
      timeoutMs,
    );
    cluster.once('request', ev => { clearTimeout(t); resolve(ev); });
  });
}

// ─── HTTP-EV-1: Content-Length ────────────────────────────────────────────────

describe('HTTP-EV-1: request_event_content_length — emits before socket close on Content-Length response', () => {
  it('emits request immediately when Content-Length body is fully received, socket still open', async () => {
    // Local service: write response only after the request arrives, then keep
    // the socket open (simulates HTTP keep-alive — this was the original bug).
    const localServer = createTrackedServer(sock => {
      sock.once('data', () => {
        sock.write(httpResponse(200, 'OK', 'Content-Length: 5\r\n', 'hello'));
        // Intentionally do NOT close sock — simulates HTTP keep-alive.
      });
    });
    await listen(localServer);

    const tunnelServer = createTrackedServer(sock => {
      sock.write(HTTP_POST_REQUEST);
    });
    await listen(tunnelServer);

    const cluster = makeCluster(tunnelServer.address().port, localServer.address().port);
    const reqP = awaitRequest(cluster);
    cluster.openOne().catch(() => {});

    const ev = await reqP;
    assert.equal(ev.method, 'POST');
    assert.equal(ev.path, '/webhook');
    assert.equal(ev.status, 200);

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(tunnelServer);
  });
});

// ─── HTTP-EV-2: Transfer-Encoding: chunked ───────────────────────────────────

describe('HTTP-EV-2: request_event_chunked — emits on chunked terminal chunk, socket still open', () => {
  it('emits request when \\r\\n0\\r\\n\\r\\n terminator arrives, connection still open', async () => {
    // Chunked body: one 5-byte chunk + terminal chunk.
    const chunkedBody = '5\r\nhello\r\n0\r\n\r\n';
    const localServer = createTrackedServer(sock => {
      sock.once('data', () => {
        sock.write(httpResponse(200, 'OK', 'Transfer-Encoding: chunked\r\n', chunkedBody));
        // Keep socket open — early detection must fire regardless.
      });
    });
    await listen(localServer);

    const tunnelServer = createTrackedServer(sock => {
      sock.write(HTTP_POST_REQUEST);
    });
    await listen(tunnelServer);

    const cluster = makeCluster(tunnelServer.address().port, localServer.address().port);
    const reqP = awaitRequest(cluster);
    cluster.openOne().catch(() => {});

    const ev = await reqP;
    assert.equal(ev.method, 'POST');
    assert.equal(ev.path, '/webhook');
    assert.equal(ev.status, 200);

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(tunnelServer);
  });
});

// ─── HTTP-EV-3: no-body status codes (204 / 304) ─────────────────────────────

describe('HTTP-EV-3: request_event_no_body_status — emits immediately after headers for 204/304', () => {
  it('emits request on 204 No Content as soon as headers arrive, socket still open', async () => {
    const localServer = createTrackedServer(sock => {
      sock.once('data', () => {
        sock.write(httpResponse(204, 'No Content'));
        // Keep socket open.
      });
    });
    await listen(localServer);

    const tunnelServer = createTrackedServer(sock => {
      sock.write(HTTP_POST_REQUEST);
    });
    await listen(tunnelServer);

    const cluster = makeCluster(tunnelServer.address().port, localServer.address().port);
    const reqP = awaitRequest(cluster);
    cluster.openOne().catch(() => {});

    const ev = await reqP;
    assert.equal(ev.method, 'POST');
    assert.equal(ev.path, '/webhook');
    assert.equal(ev.status, 204);

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(tunnelServer);
  });

  it('emits request on 304 Not Modified as soon as headers arrive, socket still open', async () => {
    const localServer = createTrackedServer(sock => {
      sock.once('data', () => {
        sock.write(httpResponse(304, 'Not Modified'));
      });
    });
    await listen(localServer);

    const tunnelServer = createTrackedServer(sock => {
      sock.write(HTTP_POST_REQUEST);
    });
    await listen(tunnelServer);

    const cluster = makeCluster(tunnelServer.address().port, localServer.address().port);
    const reqP = awaitRequest(cluster);
    cluster.openOne().catch(() => {});

    const ev = await reqP;
    assert.equal(ev.status, 304);

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(tunnelServer);
  });
});

// ─── HTTP-EV-4: fallback on socket close ─────────────────────────────────────

describe('HTTP-EV-4: request_event_fallback — falls back to local.once("close") when no length hint', () => {
  it('emits request when socket closes for HTTP/1.0-style response with no Content-Length', async () => {
    // No Content-Length + not chunked — tryEmitResponseComplete() cannot detect
    // completion, so the event must fall back to local.once('close').
    // The close is triggered by destroying the tunnel-server socket: remote.once('close')
    // → pair.local.destroy() → local.once('close') → emitHttpRequest().
    const localServer = createTrackedServer(sock => {
      sock.once('data', () => {
        sock.write(httpResponse(200, 'OK', '', 'response body'));
        // Keep socket open — no close here.  Fallback fires only on full connection teardown.
      });
    });
    await listen(localServer);

    const tunnelServer = createTrackedServer(sock => {
      sock.write(HTTP_POST_REQUEST);
      // Keep open — we destroy manually after the response has propagated.
    });
    await listen(tunnelServer);

    const cluster = makeCluster(tunnelServer.address().port, localServer.address().port);
    cluster.openOne().catch(() => {});

    // Give the request/response cycle time to complete so resBufs is populated.
    await sleep(30);

    // Trigger close chain from the tunnel side: RST → remote.once('close')
    // → pair.local.destroy() → local.once('close') → emitHttpRequest() (fallback).
    const reqP = awaitRequest(cluster);
    for (const s of tunnelServer._trackedSockets) s.destroy();

    const ev = await reqP;
    assert.equal(ev.method, 'POST');
    assert.equal(ev.path, '/webhook');
    assert.equal(ev.status, 200);

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(tunnelServer);
  });
});

// ─── HTTP-EV-5: no double emission ───────────────────────────────────────────

describe('HTTP-EV-5: request_event_no_double_emit — exactly one request event per pair lifecycle', () => {
  it('emits exactly one request event when early detection fires and socket later closes', async () => {
    const localServer = createTrackedServer(sock => {
      sock.once('data', () => {
        sock.write(httpResponse(200, 'OK', 'Content-Length: 5\r\n', 'hello'));
        // Close shortly after — both the early path and the close path could
        // potentially trigger.  The requestEmitted guard must prevent the second.
        setTimeout(() => sock.destroy(), 40);
      });
    });
    await listen(localServer);

    const tunnelServer = createTrackedServer(sock => {
      sock.write(HTTP_POST_REQUEST);
    });
    await listen(tunnelServer);

    const cluster = makeCluster(tunnelServer.address().port, localServer.address().port);

    let count = 0;
    const firstP = new Promise(resolve => {
      cluster.on('request', ev => { count++; resolve(ev); });
    });
    cluster.openOne().catch(() => {});

    const ev = await firstP;
    assert.equal(ev.method, 'POST');
    assert.equal(ev.status, 200);

    // Wait for the socket close so any spurious second emission would have arrived.
    await sleep(80);
    assert.equal(count, 1, 'requestEmitted guard must prevent a second request event');

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(tunnelServer);
  });
});

// ─── HTTP-EV-6: SSE stream — no premature emit ───────────────────────────────

describe('HTTP-EV-6: request_event_sse_no_premature_emit — SSE stream must not trigger early emit', () => {
  it('does not emit request while SSE connection is open; emits exactly once after close', async () => {
    // Local service: SSE server with no Content-Length and no chunked encoding.
    // The connection is intentionally kept open while events are streamed,
    // confirming that none of the early-detection paths fire for SSE.
    const localServer = createTrackedServer(sock => {
      sock.once('data', () => {
        sock.write(
          'HTTP/1.1 200 OK\r\n' +
          'Content-Type: text/event-stream\r\n' +
          'Cache-Control: no-cache\r\n' +
          '\r\n',
        );
        // Stream a few events while the connection stays open.
        setTimeout(() => sock.write('data: {"seq":1}\n\n'), 10);
        setTimeout(() => sock.write('data: {"seq":2}\n\n'), 20);
        // Do NOT close — the socket must stay open for the duration of the test.
      });
    });
    await listen(localServer);

    const tunnelServer = createTrackedServer(sock => {
      sock.write(HTTP_GET_REQUEST);
    });
    await listen(tunnelServer);

    const cluster = makeCluster(tunnelServer.address().port, localServer.address().port);

    let eventCount = 0;
    cluster.on('request', () => { eventCount++; });
    cluster.openOne().catch(() => {});

    // Wait past the SSE event stream — no request event must have fired yet.
    await sleep(60);
    assert.equal(eventCount, 0,
      'request event must not fire while SSE connection is open (no Content-Length / not chunked)');

    // Simulate the external caller disconnecting by closing the tunnel-server
    // socket (this is how remote-side close propagates to local in production).
    const reqP = awaitRequest(cluster);
    for (const s of tunnelServer._trackedSockets) s.destroy();

    const ev = await reqP;
    assert.equal(eventCount, 1, 'exactly one request event must fire after SSE connection closes');
    assert.equal(ev.method, 'GET');
    assert.equal(ev.path, '/events');
    assert.equal(ev.status, 200);

    cluster.close();
    await stopTracked(localServer);
    await stopTracked(tunnelServer);
  });
});
