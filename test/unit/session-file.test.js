import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSessionToken,
  generateAndSaveSessionToken,
  resolveSessionToken,
  resetSessionFile,
} from '../../src/common/session-file.js';

function tmpFile() {
  const dir = join(tmpdir(), `tt-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'session');
}

test('loadSessionToken returns null if file does not exist', () => {
  assert.equal(loadSessionToken('/nonexistent/path/session'), null);
});

test('generateAndSaveSessionToken creates file and returns hex token', () => {
  const p = tmpFile();
  const token = generateAndSaveSessionToken(p);
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal(loadSessionToken(p), token);
  rmSync(p);
});

test('resolveSessionToken returns existing token on second call', () => {
  const p = tmpFile();
  const first = resolveSessionToken(p);
  assert.equal(first.persisted, false);
  const second = resolveSessionToken(p);
  assert.equal(second.persisted, true);
  assert.equal(first.token, second.token);
  rmSync(p);
});

test('resetSessionFile removes the file', () => {
  const p = tmpFile();
  generateAndSaveSessionToken(p);
  assert.ok(loadSessionToken(p) !== null);
  resetSessionFile(p);
  assert.equal(loadSessionToken(p), null);
});
