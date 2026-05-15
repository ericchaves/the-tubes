import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readBody } from '../../src/server/router.js';

function makeReq(chunks = []) {
  const em = new EventEmitter();
  em.destroyed = false;
  em.destroy = () => { em.destroyed = true; };
  // emit chunks and end asynchronously
  em._send = () => {
    setImmediate(() => {
      for (const chunk of chunks) em.emit('data', Buffer.from(chunk));
      if (!em.destroyed) em.emit('end');
    });
  };
  return em;
}

describe('readBody', () => {
  it('resolves with full body when within limit', async () => {
    const req = makeReq(['hello', ' world']);
    req._send();
    const body = await readBody(req);
    assert.equal(body, 'hello world');
  });

  it('rejects when body exceeds maxBytes', async () => {
    const req = makeReq(['12345678']);
    req._send();
    await assert.rejects(() => readBody(req, 5), /Body too large/);
  });

  it('does not push chunks after destroy (no double reject)', async () => {
    let rejectCount = 0;
    const req = new EventEmitter();
    req.destroy = () => {};

    const promise = readBody(req, 3);
    promise.catch(() => rejectCount++);

    // Emit two oversized chunks synchronously
    req.emit('data', Buffer.from('12345'));
    req.emit('data', Buffer.from('67890'));

    await assert.rejects(() => promise, /Body too large/);
    // Give microtasks a chance to fire a second reject (there should not be one)
    await new Promise(r => setImmediate(r));
    assert.equal(rejectCount, 1);
  });
});
