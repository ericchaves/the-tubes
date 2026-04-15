import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HeaderHostTransformer } from '../../src/client/header-host-transformer.js';

function transform(input, host) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const t = new HeaderHostTransformer(host);
    t.on('data', chunk => chunks.push(chunk));
    t.on('end', () => resolve(Buffer.concat(chunks).toString()));
    t.on('error', reject);
    t.end(Buffer.from(input));
  });
}

describe('HeaderHostTransformer', () => {
  it('should rewrite Host header', async () => {
    const input = 'POST /webhook HTTP/1.1\r\nHost: tunnel.example.com\r\nContent-Type: application/json\r\n\r\n{"a":1}';
    const out = await transform(input, 'localhost:3000');
    assert.ok(out.includes('Host: localhost:3000\r\n'));
    assert.ok(!out.includes('Host: tunnel.example.com'));
  });

  it('should preserve other headers unchanged', async () => {
    const input = 'POST /x HTTP/1.1\r\nHost: remote.host\r\nX-Custom: value\r\n\r\n';
    const out = await transform(input, 'localhost');
    assert.ok(out.includes('X-Custom: value'));
  });

  it('should only rewrite the first Host header', async () => {
    const input = 'GET / HTTP/1.1\r\nHost: a.example.com\r\nHost: b.example.com\r\n\r\n';
    const out = await transform(input, 'localhost');
    assert.ok(out.includes('Host: localhost\r\n'));
    assert.ok(out.includes('Host: b.example.com'));
  });

  it('should handle case-insensitive Host header', async () => {
    const input = 'GET / HTTP/1.1\r\nhost: remote.host\r\n\r\n';
    const out = await transform(input, 'localhost');
    assert.ok(out.includes('Host: localhost\r\n') || out.includes('host: localhost\r\n'));
    assert.ok(!out.includes('remote.host'));
  });

  it('should pass through body unchanged', async () => {
    const body = '{"message":"hello world"}';
    const input = `POST / HTTP/1.1\r\nHost: a.b\r\n\r\n${body}`;
    const out = await transform(input, 'x');
    assert.ok(out.endsWith(body));
  });
});
