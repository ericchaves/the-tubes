import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAdminAuthorized } from '../../src/server/admin/auth.js';

function makeReq(headers = {}) {
  return { headers, socket: { remoteAddress: '127.0.0.1' } };
}

function makeConfig(token) {
  return { adminToken: token, trustForwardHeaders: false };
}

describe('isAdminAuthorized — X-TT-Admin-Token', () => {
  it('accepts correct token', () => {
    const req = makeReq({ 'x-tt-admin-token': 'secret123' });
    assert.ok(isAdminAuthorized(req, makeConfig('secret123')));
  });

  it('rejects wrong token', () => {
    const req = makeReq({ 'x-tt-admin-token': 'wrong' });
    assert.ok(!isAdminAuthorized(req, makeConfig('secret123')));
  });

  it('rejects token with different length', () => {
    const req = makeReq({ 'x-tt-admin-token': 'secret123extra' });
    assert.ok(!isAdminAuthorized(req, makeConfig('secret123')));
  });

  it('rejects empty token string', () => {
    const req = makeReq({ 'x-tt-admin-token': '' });
    // empty string is falsy so falls through to auth header check, returns false
    assert.ok(!isAdminAuthorized(req, makeConfig('secret123')));
  });
});

describe('isAdminAuthorized — Authorization: Bearer', () => {
  it('accepts correct Bearer token', () => {
    const req = makeReq({ authorization: 'Bearer mytoken' });
    assert.ok(isAdminAuthorized(req, makeConfig('mytoken')));
  });

  it('rejects wrong Bearer token', () => {
    const req = makeReq({ authorization: 'Bearer badtoken' });
    assert.ok(!isAdminAuthorized(req, makeConfig('mytoken')));
  });
});

describe('isAdminAuthorized — Authorization: Basic', () => {
  it('accepts correct Basic token (password field)', () => {
    const encoded = Buffer.from('user:mytoken').toString('base64');
    const req = makeReq({ authorization: `Basic ${encoded}` });
    assert.ok(isAdminAuthorized(req, makeConfig('mytoken')));
  });

  it('rejects wrong Basic token', () => {
    const encoded = Buffer.from('user:wrongtoken').toString('base64');
    const req = makeReq({ authorization: `Basic ${encoded}` });
    assert.ok(!isAdminAuthorized(req, makeConfig('mytoken')));
  });
});

describe('isAdminAuthorized — no token configured', () => {
  it('allows loopback address when no token set', () => {
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    assert.ok(isAdminAuthorized(req, { adminToken: null, trustForwardHeaders: false }));
  });

  it('denies non-loopback address when no token set', () => {
    const req = { headers: {}, socket: { remoteAddress: '1.2.3.4' } };
    assert.ok(!isAdminAuthorized(req, { adminToken: null, trustForwardHeaders: false }));
  });
});
