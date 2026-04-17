import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIp, getClientIp } from '../../src/common/http-utils.js';

describe('normalizeIp', () => {
  test('returns plain IPv4 unchanged', () => {
    assert.equal(normalizeIp('1.2.3.4'), '1.2.3.4');
  });

  test('returns plain IPv6 unchanged', () => {
    assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
  });

  test('strips IPv6 zone ID', () => {
    assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  });

  test('strips IPv6 bracket notation', () => {
    assert.equal(normalizeIp('[::1]'), '::1');
  });

  test('strips bracket + port', () => {
    // Not a typical input, but defensive
    assert.equal(normalizeIp('[::1]'), '::1');
  });

  test('normalizes IPv4-mapped IPv6 (lowercase)', () => {
    assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  });

  test('normalizes IPv4-mapped IPv6 (uppercase)', () => {
    assert.equal(normalizeIp('::FFFF:192.168.1.1'), '192.168.1.1');
  });

  test('returns "unknown" for null/undefined', () => {
    assert.equal(normalizeIp(null), 'unknown');
    assert.equal(normalizeIp(undefined), 'unknown');
  });

  test('returns "unknown" for empty string', () => {
    assert.equal(normalizeIp(''), 'unknown');
  });
});

describe('getClientIp', () => {
  function makeReq(remoteAddress, headers = {}, trustForwardHeaders = false) {
    return {
      socket: { remoteAddress },
      headers,
      trustForwardHeaders,
    };
  }

  test('returns socket address when trustForwardHeaders is false', () => {
    const req = makeReq('1.2.3.4', { 'x-forwarded-for': '9.9.9.9' });
    assert.equal(getClientIp(req, false), '1.2.3.4');
  });

  test('uses X-Forwarded-For when trustForwardHeaders is true', () => {
    const req = makeReq('1.2.3.4', { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' });
    assert.equal(getClientIp(req, true), '9.9.9.9');
  });

  test('uses X-Real-IP when X-Forwarded-For is absent', () => {
    const req = makeReq('1.2.3.4', { 'x-real-ip': '5.5.5.5' });
    assert.equal(getClientIp(req, true), '5.5.5.5');
  });

  test('normalizes IPv4-mapped IPv6 from socket', () => {
    const req = makeReq('::ffff:127.0.0.1');
    assert.equal(getClientIp(req, false), '127.0.0.1');
  });

  test('normalizes IPv6 from X-Forwarded-For', () => {
    const req = makeReq('1.2.3.4', { 'x-forwarded-for': '::ffff:10.0.0.1' });
    assert.equal(getClientIp(req, true), '10.0.0.1');
  });

  test('returns "unknown" when socket has no address', () => {
    const req = { socket: {}, headers: {} };
    assert.equal(getClientIp(req, false), 'unknown');
  });
});
