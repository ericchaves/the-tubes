import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { sign, verify } from '../../src/common/hmac.js';

const SECRET = 'a-secret-that-is-at-least-32-chars-long!!';

test('sign produces valid base64 header', () => {
  const { header } = sign({ method: 'POST', path: '/api/tunnels', secret: SECRET });
  assert.ok(typeof header === 'string');
  const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.ok(parsed.ts);
  assert.ok(parsed.nonce);
  assert.ok(parsed.sig);
});

test('verify accepts a freshly signed request', () => {
  const { header } = sign({ method: 'POST', path: '/api/tunnels', secret: SECRET });
  const result = verify({ method: 'POST', path: '/api/tunnels', secret: SECRET, authHeader: header });
  assert.equal(result.valid, true);
});

test('verify rejects wrong method', () => {
  const { header } = sign({ method: 'POST', path: '/api/tunnels', secret: SECRET });
  const result = verify({ method: 'GET', path: '/api/tunnels', secret: SECRET, authHeader: header });
  assert.equal(result.valid, false);
});

test('verify rejects wrong path', () => {
  const { header } = sign({ method: 'POST', path: '/api/tunnels', secret: SECRET });
  const result = verify({ method: 'POST', path: '/api/tunnels/other', secret: SECRET, authHeader: header });
  assert.equal(result.valid, false);
});

test('verify rejects wrong secret', () => {
  const { header } = sign({ method: 'POST', path: '/api/tunnels', secret: SECRET });
  const result = verify({ method: 'POST', path: '/api/tunnels', secret: 'wrong-secret-that-is-at-least-32-chars', authHeader: header });
  assert.equal(result.valid, false);
});

test('verify rejects missing header', () => {
  const result = verify({ method: 'POST', path: '/api/tunnels', secret: SECRET, authHeader: null });
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('missing'));
});

test('verify rejects malformed header', () => {
  const result = verify({ method: 'POST', path: '/api/tunnels', secret: SECRET, authHeader: 'notbase64!!!' });
  assert.equal(result.valid, false);
});

test('verify rejects stale timestamp', () => {
  const ts = (Math.floor(Date.now() / 1000) - 120).toString();
  const nonce = Date.now().toString();
  const bodyHash = createHash('sha256').update('').digest('hex');
  const message = `POST\n/api/tunnels\n${ts}\n${nonce}\n${bodyHash}`;
  const sig = createHmac('sha256', SECRET).update(message).digest('hex');
  const header = Buffer.from(JSON.stringify({ ts, nonce, sig })).toString('base64');
  const result = verify({ method: 'POST', path: '/api/tunnels', secret: SECRET, authHeader: header, clockSkewS: 60 });
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('timestamp'));
});
