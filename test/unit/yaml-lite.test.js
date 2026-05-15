import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify, parse } from '../../src/common/yaml-lite.js';

function roundtrip(obj) {
  const yaml = stringify(obj);
  return { yaml, parsed: parse(yaml) };
}

test('round-trip: flat object with string values', () => {
  const obj = { method: 'POST', path: '/webhook', tunnelId: 'bold-raven' };
  const { parsed } = roundtrip(obj);
  assert.deepEqual(parsed, obj);
});

test('round-trip: numbers and booleans', () => {
  const obj = { port: 3000, enabled: true, secure: false, count: 0 };
  const { parsed } = roundtrip(obj);
  assert.deepEqual(parsed, obj);
});

test('round-trip: null value', () => {
  const obj = { key: null };
  const { parsed } = roundtrip(obj);
  assert.equal(parsed.key, null);
});

test('round-trip: nested object', () => {
  const obj = { request: { method: 'POST', path: '/api' } };
  const { parsed } = roundtrip(obj);
  assert.deepEqual(parsed, obj);
});

test('round-trip: multi-line body using block literal', () => {
  const obj = {
    request: {
      body: '{"hello": "world",\n"foo": "bar"}',
    },
  };
  const { yaml, parsed } = roundtrip(obj);
  assert.ok(yaml.includes('|'), 'should use block literal');
  assert.equal(parsed.request.body, obj.request.body);
});

test('stringify produces valid YAML for capture shape', () => {
  const obj = {
    captureId: '7391948021430226944',
    tunnelId: 'wa-blutech',
    timestamp: '2026-04-15T14:22:03.412Z',
    request: {
      method: 'POST',
      path: '/webhook?token=abc',
      headers: {
        host: 'wa-blutech.tunnel.example.com',
        'content-type': 'application/json',
      },
      bodyEncoding: 'utf8',
      body: '{"object":"whatsapp_business_account"}',
    },
  };
  const yaml = stringify(obj);
  assert.ok(yaml.includes('captureId:'));
  assert.ok(yaml.includes('request:'));
  assert.ok(yaml.includes('headers:'));
  const parsed = parse(yaml);
  assert.equal(parsed.captureId, obj.captureId);
  assert.equal(parsed.request.method, 'POST');
  assert.equal(parsed.request.headers['content-type'], 'application/json');
});

test('idempotent: stringify(parse(stringify(obj))) === stringify(obj)', () => {
  const obj = { a: 'hello', b: 42, c: { d: 'world\nline2' } };
  const y1 = stringify(obj);
  const y2 = stringify(parse(y1));
  assert.equal(y1, y2);
});

test('parse: flow sequence inline value', () => {
  const yaml = 'dotenv: [ .env.wa-blutech ]\n';
  assert.deepEqual(parse(yaml), { dotenv: ['.env.wa-blutech'] });
});

test('parse: flow sequence with multiple items', () => {
  const yaml = 'files: [ a.env, b.env, c.env ]\n';
  assert.deepEqual(parse(yaml), { files: ['a.env', 'b.env', 'c.env'] });
});

test('parse: empty flow sequence', () => {
  assert.deepEqual(parse('items: []\n'), { items: [] });
});

test('parse: block sequence', () => {
  const yaml = 'items:\n  - foo\n  - bar\n';
  assert.deepEqual(parse(yaml), { items: ['foo', 'bar'] });
});
