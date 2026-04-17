import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../../src/server/rate-limiter.js';

describe('RateLimiter', () => {
  test('allows hits below threshold', () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxHits: 5, blockDurationMs: 1_000 });
    for (let i = 0; i < 5; i++) assert.equal(rl.hit('1.2.3.4'), false);
    rl.destroy();
  });

  test('blocks IP after exceeding maxHits', () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxHits: 3, blockDurationMs: 60_000 });
    for (let i = 0; i < 3; i++) rl.hit('1.2.3.4');
    assert.equal(rl.hit('1.2.3.4'), true);
    rl.destroy();
  });

  test('does not affect other IPs', () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxHits: 1, blockDurationMs: 60_000 });
    rl.hit('1.2.3.4');
    rl.hit('1.2.3.4'); // block 1.2.3.4
    assert.equal(rl.hit('5.6.7.8'), false);
    rl.destroy();
  });

  test('unblock() removes a blocked IP', () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxHits: 1, blockDurationMs: 60_000 });
    rl.hit('1.2.3.4');
    rl.hit('1.2.3.4'); // block
    assert.equal(rl.hit('1.2.3.4'), true);
    assert.equal(rl.unblock('1.2.3.4'), true);
    assert.equal(rl.hit('1.2.3.4'), false);
    rl.destroy();
  });

  test('unblock() returns false for non-blocked IP', () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxHits: 5, blockDurationMs: 60_000 });
    assert.equal(rl.unblock('9.9.9.9'), false);
    rl.destroy();
  });

  test('listBlocked() returns currently blocked IPs', () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxHits: 1, blockDurationMs: 60_000 });
    rl.hit('1.1.1.1'); rl.hit('1.1.1.1');
    rl.hit('2.2.2.2'); rl.hit('2.2.2.2');
    const list = rl.listBlocked();
    const ips = list.map(e => e.ip).sort();
    assert.deepEqual(ips, ['1.1.1.1', '2.2.2.2']);
    rl.destroy();
  });

  test('expired block is cleaned up on next hit', async () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxHits: 1, blockDurationMs: 50 });
    rl.hit('1.2.3.4'); rl.hit('1.2.3.4'); // block
    assert.equal(rl.hit('1.2.3.4'), true);
    await new Promise(r => setTimeout(r, 60));
    // Block expired — should be allowed again
    assert.equal(rl.hit('1.2.3.4'), false);
    rl.destroy();
  });

  test('emits ip.blocked event to globalLog', () => {
    const events = [];
    const globalLog = { push: (type, data) => events.push({ type, ...data }) };
    const rl = new RateLimiter({ windowMs: 60_000, maxHits: 1, blockDurationMs: 60_000, globalLog });
    rl.hit('3.3.3.3'); rl.hit('3.3.3.3');
    const blocked = events.find(e => e.type === 'ip.blocked');
    assert.ok(blocked, 'ip.blocked event emitted');
    assert.equal(blocked.ip, '3.3.3.3');
    assert.equal(blocked.reason, 'auto');
    rl.destroy();
  });

  test('emits ip.unblocked event when manually unblocked', () => {
    const events = [];
    const globalLog = { push: (type, data) => events.push({ type, ...data }) };
    const rl = new RateLimiter({ windowMs: 60_000, maxHits: 1, blockDurationMs: 60_000, globalLog });
    rl.hit('4.4.4.4'); rl.hit('4.4.4.4');
    rl.unblock('4.4.4.4');
    const unblocked = events.find(e => e.type === 'ip.unblocked');
    assert.ok(unblocked, 'ip.unblocked event emitted');
    assert.equal(unblocked.ip, '4.4.4.4');
    assert.equal(unblocked.reason, 'manual');
    rl.destroy();
  });
});
