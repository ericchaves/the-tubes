/**
 * Integration tests for the tubes server.
 * Spins up a TunnelManager + HTTP admin API server in-process.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { TunnelManager } from '../../src/server/tunnel-manager.js';
import { handleAdminRequest } from '../../src/server/router.js';
import { createHmacMiddleware } from '../../src/server/hmac-middleware.js';
import { sign } from '../../src/common/hmac.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    publicPort: 0,
    publicAddress: '127.0.0.1',
    publicDomain: 'tt.localhost',
    publicHttps: false,
    externalHttpPort: 80,
    externalHttpsPort: 443,
    apiPort: null,
    apiAddress: '127.0.0.1',
    maxConnectionsPerTunnel: 3,
    reconnectWindowMs: 100,
    reconnectWindowMaxMs: 300000,
    retryAfterSeconds: 5,
    hmacSecret: null,
    hmacClockSkewToleranceS: 60,
    hmacNonceCacheTtlS: 240,
    hmacNonceMaxAgeS: 120,
    tunnelPortStart: null,
    tunnelPortEnd: null,
    httpWaitTimeoutMs: 5000,
    websocketWaitTimeoutMs: 10000,
    trustForwardHeaders: false,
    landingUrl: null,
    ...overrides,
  };
}

async function startAdminServer(config, hmacSecret = null) {
  const manager = new TunnelManager(config);
  const startedAt = Date.now();

  let hmacVerify = null;
  if (hmacSecret) {
    hmacVerify = createHmacMiddleware({
      secret: hmacSecret,
      clockSkewS: config.hmacClockSkewToleranceS,
      nonceCacheTtlS: config.hmacNonceCacheTtlS,
    });
  }

  const server = createServer((req, res) => {
    handleAdminRequest(req, res, { manager, hmacVerify, startedAt, serverConfig: config });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function request(method, path, headers = {}, body = null) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ?? undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, headers: res.headers, body: json };
  }

  async function stop() {
    manager.destroyAll();
    if (hmacVerify?.destroy) hmacVerify.destroy();
    await new Promise(r => server.close(r));
  }

  return { manager, server, base, request, stop, port };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /healthz', () => {
  let ctx;
  before(async () => { ctx = await startAdminServer(makeConfig()); });
  after(async () => ctx.stop());

  it('returns 200 with status ok', async () => {
    const { status, body } = await ctx.request('GET', '/healthz');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.uptime === 'number');
    assert.ok(typeof body.tunnels === 'number');
  });
});

describe('GET /api/status', () => {
  let ctx;
  before(async () => { ctx = await startAdminServer(makeConfig()); });
  after(async () => ctx.stop());

  it('returns 200 with protocol and tunnels array', async () => {
    const { status, body } = await ctx.request('GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(body.protocol, 'the-tubes/1.0');
    assert.ok(Array.isArray(body.tunnels));
  });
});

describe('POST /api/tunnels — tunnel creation', () => {
  let ctx;
  before(async () => { ctx = await startAdminServer(makeConfig()); });
  after(async () => ctx.stop());

  it('rejects request without X-TT-Session-Token (400)', async () => {
    const { status, body } = await ctx.request('POST', '/api/tunnels');
    assert.equal(status, 400);
    assert.ok(body.error.includes('Session-Token'));
  });

  it('creates a tunnel and returns the-tubes/1.0 response', async () => {
    const { status, body } = await ctx.request('POST', '/api/tunnels', {
      'X-TT-Session-Token': 'abc123',
    });
    assert.equal(status, 200);
    assert.equal(body.protocol, 'the-tubes/1.0');
    assert.ok(body.tunnelId);
    assert.ok(body.publicUrl.includes(body.tunnelId));
    assert.ok(body.tunnelPort > 0);
    assert.ok(body.maxConnections > 0);
    assert.ok(body.reconnectWindowMs > 0);
  });

  it('creates a tunnel with specific subdomain', async () => {
    const { status, body } = await ctx.request('POST', '/api/tunnels/my-webhook', {
      'X-TT-Session-Token': 'token-sub-1',
    });
    assert.equal(status, 200);
    assert.equal(body.tunnelId, 'my-webhook');
  });

  it('rejects invalid subdomain format (400)', async () => {
    const { status, body } = await ctx.request('POST', '/api/tunnels/UPPERCASE-INVALID', {
      'X-TT-Session-Token': 'token-invalid-sub',
    });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it('returns 409 conflict when another session holds same subdomain', async () => {
    await ctx.request('POST', '/api/tunnels/shared-sub', {
      'X-TT-Session-Token': 'first-session',
    });

    const { status, body } = await ctx.request('POST', '/api/tunnels/shared-sub', {
      'X-TT-Session-Token': 'different-session',
    });
    assert.equal(status, 409);
    assert.ok(body.error, 'should have error message');
  });

  it('X-TT-Proto header present on all responses', async () => {
    const { headers } = await ctx.request('POST', '/api/tunnels', {
      'X-TT-Session-Token': 'proto-test',
    });
    assert.equal(headers.get('x-tt-proto'), 'the-tubes/1.0');
  });
});

describe('GET /api/tunnels/:id', () => {
  let ctx;
  before(async () => { ctx = await startAdminServer(makeConfig()); });
  after(async () => ctx.stop());

  it('returns tunnel info for existing tunnel', async () => {
    const create = await ctx.request('POST', '/api/tunnels/info-tunnel', {
      'X-TT-Session-Token': 'info-token',
    });
    assert.equal(create.status, 200);

    const { status, body } = await ctx.request('GET', '/api/tunnels/info-tunnel');
    assert.equal(status, 200);
    assert.equal(body.tunnelId, 'info-tunnel');
    assert.ok(body.publicUrl);
  });

  it('returns 404 for non-existent tunnel', async () => {
    const { status } = await ctx.request('GET', '/api/tunnels/does-not-exist');
    assert.equal(status, 404);
  });
});

describe('404 for unknown routes', () => {
  let ctx;
  before(async () => { ctx = await startAdminServer(makeConfig()); });
  after(async () => ctx.stop());

  it('returns 404 for GET /unknown', async () => {
    const { status } = await ctx.request('GET', '/unknown');
    assert.equal(status, 404);
  });

  it('returns 404 for DELETE /api/tunnels', async () => {
    const { status } = await ctx.request('DELETE', '/api/tunnels');
    assert.equal(status, 404);
  });
});

describe('HMAC authentication', () => {
  const secret = 'super-secret-hmac-key-for-testing-minimum-32-chars';
  let ctx;
  before(async () => { ctx = await startAdminServer(makeConfig({ hmacSecret: secret }), secret); });
  after(async () => ctx.stop());

  it('rejects tunnel creation without X-TT-Auth (401)', async () => {
    const { status, body } = await ctx.request('POST', '/api/tunnels', {
      'X-TT-Session-Token': 'hmac-test-1',
    });
    assert.equal(status, 401);
    assert.ok(body.error.includes('Authentication'));
  });

  it('accepts tunnel creation with valid HMAC', async () => {
    const { header } = sign({ method: 'POST', path: '/api/tunnels', secret });
    const { status, body } = await ctx.request('POST', '/api/tunnels', {
      'X-TT-Session-Token': 'hmac-test-2',
      'X-TT-Auth': header,
    });
    assert.equal(status, 200);
    assert.equal(body.protocol, 'the-tubes/1.0');
  });

  it('rejects tampered HMAC (401)', async () => {
    const { header } = sign({ method: 'POST', path: '/api/tunnels', secret });
    // Tamper: change last char
    const tampered = header.slice(0, -3) + 'xxx';
    const { status } = await ctx.request('POST', '/api/tunnels', {
      'X-TT-Session-Token': 'hmac-test-3',
      'X-TT-Auth': tampered,
    });
    assert.equal(status, 401);
  });

  it('GET /healthz does not require HMAC', async () => {
    const { status } = await ctx.request('GET', '/healthz');
    assert.equal(status, 200);
  });

  it('GET /api/status does not require HMAC', async () => {
    const { status } = await ctx.request('GET', '/api/status');
    assert.equal(status, 200);
  });
});

describe('Reconnect window', () => {
  let ctx;
  before(async () => { ctx = await startAdminServer(makeConfig({ reconnectWindowMs: 200 })); });
  after(async () => ctx.stop());

  it('same session reclaims tunnel within window', async () => {
    const token = 'reconnect-token';

    const r1 = await ctx.request('POST', '/api/tunnels', {
      'X-TT-Session-Token': token,
    });
    assert.equal(r1.status, 200);
    const tunnelId = r1.body.tunnelId;

    // Simulate disconnect
    ctx.manager.getTunnel(tunnelId).startReconnectWindow();

    // Reconnect within window — same token → same tunnel
    const r2 = await ctx.request('POST', '/api/tunnels', {
      'X-TT-Session-Token': token,
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.tunnelId, tunnelId);
  });

  it('different session gets 409 conflict during window', async () => {
    const r1 = await ctx.request('POST', '/api/tunnels/rc-window-sub', {
      'X-TT-Session-Token': 'rc-session-1',
    });
    assert.equal(r1.status, 200);

    ctx.manager.getTunnel('rc-window-sub').startReconnectWindow();

    const r2 = await ctx.request('POST', '/api/tunnels/rc-window-sub', {
      'X-TT-Session-Token': 'rc-session-2',
    });
    assert.equal(r2.status, 409);
  });
});

describe('Port range exhaustion', () => {
  it('returns 503 when port range is exhausted', async () => {
    const ctx = await startAdminServer(makeConfig({
      tunnelPortStart: 19901,
      tunnelPortEnd: 19902, // only 2 ports
    }));

    try {
      await ctx.request('POST', '/api/tunnels', { 'X-TT-Session-Token': 'port-1' });
      await ctx.request('POST', '/api/tunnels', { 'X-TT-Session-Token': 'port-2' });
      const { status } = await ctx.request('POST', '/api/tunnels', { 'X-TT-Session-Token': 'port-3' });
      assert.equal(status, 503);
    } finally {
      await ctx.stop();
    }
  });
});
