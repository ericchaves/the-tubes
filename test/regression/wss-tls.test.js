/**
 * Regression: wsSend must use TLS when connecting to wss:// URLs.
 *
 * Fix: runner.js now uses tls.connect instead of net.connect for wss://.
 *
 * Strategy: start a plain TCP probe server and inspect the raw bytes that
 * wsSend sends to it. We start wsSend in background and wait for the first
 * bytes via a Promise (avoids the race condition where assert.rejects()
 * resolves before the server's 'data' event fires).
 *
 * - wss:// → TLS ClientHello, first byte is 0x16 (TLS handshake record)
 * - ws://  → HTTP upgrade request, first bytes are "GET"
 *
 * probe.stop() destroys all active sockets, causing wsSend to get ECONNRESET
 * and finish quickly (no 10-second socket-timeout wait).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { wsSend } from '../../src/replay/runner.js';

function startProbe() {
  let receivedData = Buffer.alloc(0);
  let firstDataResolve = null;
  let firstDataReject = null;

  const firstData = new Promise((resolve, reject) => {
    firstDataResolve = resolve;
    firstDataReject = reject;
  });

  const sockets = new Set();
  const server = createServer(sock => {
    sockets.add(sock);
    sock.on('data', chunk => {
      receivedData = Buffer.concat([receivedData, chunk]);
      firstDataResolve?.();
      firstDataResolve = null;
    });
    sock.on('error', () => {});
    sock.once('close', () => sockets.delete(sock));
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();

      // Attach a timeout so firstData rejects if no bytes arrive in 2s
      const timer = setTimeout(() => {
        firstDataReject?.(new Error('probe timeout: no bytes received in 2000ms'));
        firstDataReject = null;
      }, 2000);
      firstData.then(() => clearTimeout(timer), () => clearTimeout(timer));

      const stop = () => {
        for (const s of sockets) s.destroy();
        return new Promise(r => server.close(r));
      };

      resolve({ port, stop, getData: () => receivedData, firstData });
    });
  });
}

describe('wsSend — TLS selection', () => {
  it('sends TLS ClientHello for wss://', async () => {
    const probe = await startProbe();
    try {
      // Start wsSend in background — it will fail (no TLS server), but we only
      // care about what bytes it sends before failing.
      wsSend(`wss://127.0.0.1:${probe.port}/`, [], {}).catch(() => {});
      // Wait for the probe server to receive bytes
      await probe.firstData;
      // TLS ClientHello starts with 0x16 (handshake record type)
      const data = probe.getData();
      assert.equal(data[0], 0x16, `expected TLS record (0x16) but got 0x${data[0].toString(16)}`);
    } finally {
      // Destroys all sockets → wsSend gets ECONNRESET → finishes without waiting for timeout
      await probe.stop();
    }
  });

  it('sends HTTP GET upgrade for ws://', async () => {
    const probe = await startProbe();
    try {
      wsSend(`ws://127.0.0.1:${probe.port}/test`, [], {}).catch(() => {});
      await probe.firstData;
      const data = probe.getData();
      assert.equal(data.slice(0, 3).toString('ascii'), 'GET', 'expected HTTP GET upgrade request');
    } finally {
      await probe.stop();
    }
  });
});
