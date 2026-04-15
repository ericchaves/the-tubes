import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FailureTracker } from '../../src/client/failure-tracker.js';

describe('FailureTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new FailureTracker({ windowS: 1, maxInWindow: 3, maxTotal: 10 });
  });

  it('should not give up initially', () => {
    assert.equal(tracker.shouldGiveUp(), false);
  });

  it('should give up when maxInWindow exceeded within window', async () => {
    tracker.record('localConnect');
    tracker.record('localConnect');
    tracker.record('localConnect');
    // 3 failures in window of 1s, maxInWindow=3 → should give up
    assert.equal(tracker.shouldGiveUp(), true);
  });

  it('should give up when maxTotal exceeded', () => {
    // maxTotal=10, maxInWindow=3 — spread across time to avoid window limit
    const t = new FailureTracker({ windowS: 0, maxInWindow: 100, maxTotal: 5 });
    for (let i = 0; i < 5; i++) t.record('remoteDrop');
    assert.equal(t.shouldGiveUp(), true);
  });

  it('should reset counters on successful traffic', () => {
    tracker.record('localConnect');
    tracker.record('localConnect');
    tracker.record('localConnect');
    assert.equal(tracker.shouldGiveUp(), true);

    tracker.onSuccessfulTraffic();
    assert.equal(tracker.shouldGiveUp(), false);
  });

  it('should slide the window — old failures should not count', async () => {
    // Add failures then wait for window to slide
    const shortTracker = new FailureTracker({ windowS: 0.05, maxInWindow: 2, maxTotal: 100 });
    shortTracker.record('localConnect');
    shortTracker.record('localConnect');
    assert.equal(shortTracker.shouldGiveUp(), true);

    // Wait for window to slide
    await new Promise(r => setTimeout(r, 60));
    shortTracker.record('localConnect'); // fresh window
    assert.equal(shortTracker.shouldGiveUp(), false);
  });

  it('should track different failure kinds separately', () => {
    tracker.record('localConnect');
    tracker.record('remoteConnect');
    tracker.record('localDrop');
    assert.equal(tracker.shouldGiveUp(), true);
  });
});
