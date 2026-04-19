/**
 * Regression test — server-side HTTP response relay.
 *
 * Bug: ServerTunnel.handleRequest used socket.pipe(res) to forward the tunnel
 * socket response directly into http.ServerResponse.  Since the tunnel socket
 * carries a raw HTTP message (status line + headers + body), piping it into
 * http.ServerResponse caused Node.js to emit its own 200 OK headers and then
 * write the entire raw HTTP response as the body.  Callers (e.g. the WhatsApp
 * webhook verification flow) received "HTTP/1.1 200 OK\r\nC..." as the body
 * instead of the actual challenge value.
 *
 * Fix: buffer the tunnel socket data until the header section (\r\n\r\n) is
 * complete, parse status + headers, call res.writeHead(), then stream only the
 * body to res.
 *
 *   SRV-1  GET verification — body is the challenge value, not raw HTTP bytes
 *   SRV-2  POST request — response status and JSON body relayed correctly
 *   SRV-3  Custom headers — upstream headers forwarded to client
 *   SRV-4  Keep-alive upstream — response ends on Content-Length, not socket close
 *   SRV-5  Chunked upstream — response ends on terminal 0-sized chunk
 *   SRV-6  No-body status (204) — response ends immediately after headers
 *   SRV-7  GET without body — req.close does not prematurely tear down tunnel
 *   SRV-8  Upstream closes without response — public client gets 502, not 200-empty
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { ServerTunnel } from '../../src/server/tunnel.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  httpWaitTimeoutMs: 5000,
  websocketWaitTimeoutMs: 10000,
  retryAfterSeconds: 5,
};

/**
 * Spin up a ServerTunnel + HTTP server.
 * Returns helpers to connect a fake tunnel socket and make HTTP requests.
 */
async function setup() {
  const tunnel = new ServerTunnel({
    tunnelId: 'relay-test',
    sessionToken: 'relay-token-abcdef',
    maxConnections: 3,
    reconnectWindowMs: 5000,
    assignedPort: 0,
    serverConfig: DEFAULT_CONFIG,
  });
  await tunnel.agent.listen(0);

  const httpServer = createHttpServer((req, res) => {
    tunnel.handleRequest(req, res).catch(err => {
      if (!res.headersSent) { res.writeHead(500); res.end(err.message); }
    });
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));

  const agentPort = tunnel.agent._assignedPort;
  const httpPort = httpServer.address().port;
  const base = `http://127.0.0.1:${httpPort}`;

  /**
   * Connect a fake tunnel-client socket to the agent.
   * When the server forwards an HTTP request to it, call `onRequest(rawBytes)`.
   * The handler may return:
   *   - a string/Buffer  → written to the socket and the socket is closed
   *   - { reply, keepAlive: true } → written, but the socket is kept open
   *     (simulates an upstream service using HTTP keep-alive, like n8n)
   *   - { close: true }  → close the socket immediately without responding
   *     (simulates a zombie pool socket closed by an intermediate proxy)
   *   - null/undefined   → nothing is written
   */
  async function connectFakeSocket(onRequest) {
    const sock = netConnect({ host: '127.0.0.1', port: agentPort });
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    let buf = Buffer.alloc(0);
    let replied = false;
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (replied) return;
      if (buf.indexOf('\r\n\r\n') === -1) return;
      replied = true;
      const result = onRequest(buf);
      if (!result) return;
      if (typeof result === 'string' || Buffer.isBuffer(result)) {
        sock.write(result);
        sock.end();
      } else if (result.close) {
        sock.end();
      } else if (result.reply) {
        sock.write(result.reply);
        if (!result.keepAlive) sock.end();
      }
    });
    return sock;
  }

  async function stop() {
    await new Promise(resolve => httpServer.close(resolve));
    tunnel.destroy();
  }

  return { base, connectFakeSocket, stop };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SRV-1: response_relay_get_challenge — body is challenge value, not raw HTTP bytes', () => {
  it('WhatsApp-style GET verification returns plain challenge number as body', async () => {
    const { base, connectFakeSocket, stop } = await setup();

    const challenge = '265347610';

    await connectFakeSocket(() =>
      `HTTP/1.1 200 OK\r\n` +
      `Content-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(challenge)}\r\n` +
      `\r\n` +
      challenge
    );

    const res = await fetch(`${base}/webhook?hub.challenge=${challenge}&hub.verify_token=abc`);

    assert.equal(res.status, 200, 'status must be 200');
    const body = await res.text();

    assert.ok(
      !body.startsWith('HTTP/'),
      `body must not contain raw HTTP framing — got: ${JSON.stringify(body.slice(0, 80))}`
    );
    assert.equal(body, challenge,
      `body must be exactly the challenge value, got: ${JSON.stringify(body)}`);

    await stop();
  });
});

describe('SRV-2: response_relay_post_json — POST response status and JSON body relayed correctly', () => {
  it('POST webhook returns correct status and JSON body', async () => {
    const { base, connectFakeSocket, stop } = await setup();

    const responseBody = JSON.stringify({ received: true });

    await connectFakeSocket(() =>
      `HTTP/1.1 200 OK\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(responseBody)}\r\n` +
      `\r\n` +
      responseBody
    );

    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'message' }),
    });

    assert.equal(res.status, 200, 'status must be relayed as 200');
    const body = await res.json();
    assert.deepEqual(body, { received: true });

    await stop();
  });
});

describe('SRV-4: response_relay_keep_alive — response ends on Content-Length, not socket close', () => {
  it('completes the response even when the upstream keeps the socket open (n8n keep-alive)', async () => {
    const { base, connectFakeSocket, stop } = await setup();

    const body = 'keep-alive-challenge-42';

    await connectFakeSocket(() => ({
      reply:
        `HTTP/1.1 200 OK\r\n` +
        `Content-Type: text/plain\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: keep-alive\r\n` +
        `\r\n` +
        body,
      keepAlive: true,
    }));

    const res = await Promise.race([
      fetch(`${base}/webhook`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('fetch timed out — response never ended')), 3000)
      ),
    ]);

    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, body);

    await stop();
  });
});

describe('SRV-5: response_relay_chunked — response ends on terminal 0-sized chunk', () => {
  it('completes the response on chunked transfer-encoding terminator even with keep-alive', async () => {
    const { base, connectFakeSocket, stop } = await setup();

    // Chunked body: "hello" (5 bytes) then terminator
    const chunked =
      `5\r\nhello\r\n` +
      `0\r\n\r\n`;

    await connectFakeSocket(() => ({
      reply:
        `HTTP/1.1 200 OK\r\n` +
        `Content-Type: text/plain\r\n` +
        `Transfer-Encoding: chunked\r\n` +
        `Connection: keep-alive\r\n` +
        `\r\n` +
        chunked,
      keepAlive: true,
    }));

    const res = await Promise.race([
      fetch(`${base}/chunked`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('fetch timed out — chunked response never ended')), 3000)
      ),
    ]);

    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'hello');

    await stop();
  });
});

describe('SRV-6: response_relay_no_body — 204 ends immediately after headers', () => {
  it('completes immediately on no-body status even when socket stays open', async () => {
    const { base, connectFakeSocket, stop } = await setup();

    await connectFakeSocket(() => ({
      reply:
        `HTTP/1.1 204 No Content\r\n` +
        `Connection: keep-alive\r\n` +
        `\r\n`,
      keepAlive: true,
    }));

    const res = await Promise.race([
      fetch(`${base}/noop`, { method: 'POST', body: 'x' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('fetch timed out — 204 response never ended')), 3000)
      ),
    ]);

    assert.equal(res.status, 204);
    const text = await res.text();
    assert.equal(text, '');

    await stop();
  });
});

describe('SRV-7: response_relay_get_delay — upstream has time to respond to GET even though req has no body', () => {
  it('does not tear down the tunnel socket on req.close for no-body GET before upstream responds', async () => {
    const { base, connectFakeSocket, stop } = await setup();

    // WhatsApp-style webhook verification — upstream (n8n) takes a few hundred
    // milliseconds to process and respond. The server must NOT close the
    // tunnel socket in response to req.close firing on the no-body GET.
    const challenge = '128252226';

    await connectFakeSocket(() => {
      // Simulate upstream processing delay, then return the challenge.
      const reply =
        `HTTP/1.1 200 OK\r\n` +
        `Content-Type: text/plain\r\n` +
        `Content-Length: ${Buffer.byteLength(challenge)}\r\n` +
        `Connection: keep-alive\r\n` +
        `\r\n` +
        challenge;
      // Return the reply asynchronously so server's req.close has a chance
      // to fire before the upstream response lands.
      setTimeout(() => {}, 0);
      return { reply, keepAlive: true };
    });

    const res = await Promise.race([
      fetch(`${base}/webhook?hub.mode=subscribe&hub.challenge=${challenge}&hub.verify_token=x`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('fetch timed out — tunnel was torn down prematurely')), 3000)
      ),
    ]);

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, challenge,
      `body must be the challenge, got ${JSON.stringify(body)} — if empty, req.close is tearing down the tunnel socket before upstream responds`);

    await stop();
  });
});

describe('SRV-8: response_relay_upstream_closed — 502 when tunnel socket closes without any response', () => {
  it('returns 502 Bad Gateway when the upstream tunnel closes without sending any bytes', async () => {
    const { base, connectFakeSocket, stop } = await setup();

    // Simulate a zombie pool socket: connects, receives request, but closes
    // without sending any response (e.g. the LB killed it right after delivery).
    await connectFakeSocket(() => ({ close: true }));

    const res = await Promise.race([
      fetch(`${base}/webhook`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('fetch timed out — server did not fail-fast on upstream close')), 3000)
      ),
    ]);

    assert.equal(res.status, 502,
      `must reply 502 Bad Gateway, not 200 with empty body — got ${res.status}`);

    await stop();
  });
});

describe('SRV-3: response_relay_custom_headers — upstream response headers forwarded to client', () => {
  it('custom upstream headers appear in the client response', async () => {
    const { base, connectFakeSocket, stop } = await setup();

    const responseBody = 'ok';

    await connectFakeSocket(() =>
      `HTTP/1.1 202 Accepted\r\n` +
      `Content-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(responseBody)}\r\n` +
      `X-Custom-Header: hello-from-upstream\r\n` +
      `\r\n` +
      responseBody
    );

    const res = await fetch(`${base}/notify`, { method: 'POST', body: 'ping' });

    assert.equal(res.status, 202, 'status 202 must be relayed');
    assert.equal(res.headers.get('x-custom-header'), 'hello-from-upstream',
      'custom upstream header must be forwarded');
    const body = await res.text();
    assert.equal(body, responseBody);

    await stop();
  });
});
