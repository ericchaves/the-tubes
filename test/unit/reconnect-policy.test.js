import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectPolicy } from '../../src/client/reconnect-policy.js';

describe('ReconnectPolicy', () => {
  let policy;

  beforeEach(() => {
    policy = new ReconnectPolicy({ initialDelayMs: 100, maxDelayMs: 1000, multiplier: 2 });
  });

  it('should return initial delay on first call', () => {
    assert.equal(policy.nextDelay(), 100);
  });

  it('should double delay on each call', () => {
    assert.equal(policy.nextDelay(), 100);
    assert.equal(policy.nextDelay(), 200);
    assert.equal(policy.nextDelay(), 400);
    assert.equal(policy.nextDelay(), 800);
  });

  it('should cap at maxDelayMs', () => {
    policy.nextDelay(); // 100
    policy.nextDelay(); // 200
    policy.nextDelay(); // 400
    policy.nextDelay(); // 800
    assert.equal(policy.nextDelay(), 1000); // would be 1600, capped at 1000
    assert.equal(policy.nextDelay(), 1000); // stays at cap
  });

  it('should reset to initial delay after reset()', () => {
    policy.nextDelay(); // 100
    policy.nextDelay(); // 200
    policy.nextDelay(); // 400
    policy.reset();
    assert.equal(policy.nextDelay(), 100);
  });

  it('should use default params when none provided', () => {
    const p = new ReconnectPolicy();
    const d1 = p.nextDelay();
    const d2 = p.nextDelay();
    assert.ok(d1 > 0);
    assert.ok(d2 > d1);
  });
});
