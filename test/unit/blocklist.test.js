import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BlocklistManager } from '../../src/server/blocklist.js';

describe('BlocklistManager', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = join(tmpdir(), 'tt-blocklist-test-' + Date.now());
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('starts empty with no file', () => {
    const bl = new BlocklistManager({ dataDir });
    assert.equal(bl.listPermanent().length, 0);
  });

  test('addPermanent / isPermanentlyBlocked', () => {
    const bl = new BlocklistManager({ dataDir });
    assert.equal(bl.isPermanentlyBlocked('1.2.3.4'), false);
    assert.equal(bl.addPermanent('1.2.3.4'), true);
    assert.equal(bl.isPermanentlyBlocked('1.2.3.4'), true);
  });

  test('addPermanent returns false for duplicate', () => {
    const bl = new BlocklistManager({ dataDir });
    bl.addPermanent('1.2.3.4');
    assert.equal(bl.addPermanent('1.2.3.4'), false);
  });

  test('removePermanent removes an IP', () => {
    const bl = new BlocklistManager({ dataDir });
    bl.addPermanent('1.2.3.4');
    assert.equal(bl.removePermanent('1.2.3.4'), true);
    assert.equal(bl.isPermanentlyBlocked('1.2.3.4'), false);
  });

  test('removePermanent returns false for unknown IP', () => {
    const bl = new BlocklistManager({ dataDir });
    assert.equal(bl.removePermanent('9.9.9.9'), false);
  });

  test('persists to file and reloads', () => {
    const bl = new BlocklistManager({ dataDir });
    bl.addPermanent('1.2.3.4');
    bl.addPermanent('5.6.7.8');

    // New instance reads the same file
    const bl2 = new BlocklistManager({ dataDir });
    assert.equal(bl2.isPermanentlyBlocked('1.2.3.4'), true);
    assert.equal(bl2.isPermanentlyBlocked('5.6.7.8'), true);
    assert.equal(bl2.listPermanent().length, 2);
  });

  test('normalizes IPv4-mapped IPv6 addresses', () => {
    const bl = new BlocklistManager({ dataDir });
    bl.addPermanent('::ffff:1.2.3.4');
    // Both forms should match after normalization
    assert.equal(bl.isPermanentlyBlocked('1.2.3.4'), true);
  });

  test('normalizes IPv6 loopback', () => {
    const bl = new BlocklistManager({ dataDir });
    bl.addPermanent('::1');
    assert.equal(bl.isPermanentlyBlocked('::1'), true);
  });

  test('emits ip.added_permanent and ip.removed_permanent events', () => {
    const events = [];
    const globalLog = { push: (type, data) => events.push({ type, ...data }) };
    const bl = new BlocklistManager({ dataDir, globalLog });

    bl.addPermanent('1.2.3.4');
    const added = events.find(e => e.type === 'ip.added_permanent');
    assert.ok(added, 'ip.added_permanent emitted');
    assert.equal(added.ip, '1.2.3.4');

    bl.removePermanent('1.2.3.4');
    const removed = events.find(e => e.type === 'ip.removed_permanent');
    assert.ok(removed, 'ip.removed_permanent emitted');
    assert.equal(removed.ip, '1.2.3.4');
  });

  test('file is created in dataDir on first write', () => {
    const bl = new BlocklistManager({ dataDir });
    const filePath = join(dataDir, 'blocklist.json');
    assert.equal(existsSync(filePath), false);
    bl.addPermanent('1.2.3.4');
    assert.equal(existsSync(filePath), true);
  });
});
