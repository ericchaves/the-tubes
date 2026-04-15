import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NonceCache } from '../../src/common/nonce-cache.js';

test('fresh nonce is not seen', () => {
  const cache = new NonceCache({ ttlS: 10 });
  assert.equal(cache.isSeen('abc123'), false);
  cache.destroy();
});

test('same nonce twice is replay', () => {
  const cache = new NonceCache({ ttlS: 10 });
  cache.isSeen('abc123');
  assert.equal(cache.isSeen('abc123'), true);
  cache.destroy();
});

test('different nonces are independent', () => {
  const cache = new NonceCache({ ttlS: 10 });
  cache.isSeen('aaa');
  assert.equal(cache.isSeen('bbb'), false);
  cache.destroy();
});

test('expired nonce is not seen after TTL', async () => {
  const cache = new NonceCache({ ttlS: 0.05, cleanupIntervalMs: 10 });
  cache.isSeen('expiring');
  await new Promise(r => setTimeout(r, 200));
  cache._cleanup(); // force cleanup
  assert.equal(cache.isSeen('expiring'), false);
  cache.destroy();
});
