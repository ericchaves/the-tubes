import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TunnelManager } from '../../src/server/tunnel-manager.js';

function makeManager() {
  return new TunnelManager({
    tunnelPortStart: null,
    tunnelPortEnd: null,
    maxConnectionsPerTunnel: 10,
    reconnectWindowMs: 5000,
    reconnectWindowMaxMs: 30000,
  });
}

describe('TunnelManager — invalid subdomain validation', () => {
  it('throws with status 400 for subdomain starting with dash', async () => {
    const manager = makeManager();
    await assert.rejects(
      () => manager.createTunnel({ sessionToken: 'tok1', requestedSubdomain: '-invalid' }),
      err => {
        assert.equal(err.status, 400);
        assert.match(err.message, /subdomain/i);
        return true;
      }
    );
  });

  it('throws with status 400 for subdomain with special chars', async () => {
    const manager = makeManager();
    await assert.rejects(
      () => manager.createTunnel({ sessionToken: 'tok2', requestedSubdomain: 'bad!!name' }),
      err => {
        assert.equal(err.status, 400);
        return true;
      }
    );
  });
});
