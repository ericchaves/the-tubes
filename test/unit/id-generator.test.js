import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTunnelId, generateCaptureId } from '../../src/common/id-generator.js';

test('generateTunnelId returns adj-noun-hex format', () => {
  const id = generateTunnelId();
  assert.match(id, /^[a-z]+-[a-z]+-[0-9a-f]{6}$/);
});

test('generateTunnelId hex suffix is 6 characters', () => {
  const id = generateTunnelId();
  const parts = id.split('-');
  assert.equal(parts.length, 3);
  assert.equal(parts[2].length, 6);
});

test('generateTunnelId produces different values', () => {
  const ids = new Set(Array.from({ length: 20 }, generateTunnelId));
  assert.ok(ids.size > 1);
});

test('generateCaptureId returns numeric string', () => {
  const id = generateCaptureId();
  assert.match(id, /^\d+$/);
});

test('generateCaptureId is monotonically increasing', () => {
  const a = BigInt(generateCaptureId());
  const b = BigInt(generateCaptureId());
  assert.ok(b >= a);
});
