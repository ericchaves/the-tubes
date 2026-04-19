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
   * When the server forwards an HTTP request to it, call `onRequest(rawBytes)`
   * and write back whatever that function returns.
   */
  async function connectFakeSocket(onRequest) {
    const sock = netConnect({ host: '127.0.0.1', port: agentPort });
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    let buf = Buffer.alloc(0);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      // Wait until we have the full HTTP request header section
      if (buf.indexOf('\r\n\r\n') === -1) return;
      const reply = onRequest(buf);
      if (reply) {
        sock.write(reply);
        sock.end();
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
