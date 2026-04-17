import { EventEmitter } from 'node:events';
import { sign } from '../common/hmac.js';
import { createDebug } from '../debug.js';
import { TunnelCluster } from './tunnel-cluster.js';
import { FailureTracker } from './failure-tracker.js';
import { ReconnectPolicy } from './reconnect-policy.js';

const debug = createDebug('client:tunnel');

const MAX_FETCH_RETRIES = 3;

/**
 * Client-side tunnel controller.
 *
 * Design rules implemented (§3.4):
 * R1: FailureTracker and ReconnectPolicy are singletons, passed to TunnelCluster.
 * R2: trackers never reset except by onSuccessfulTraffic().
 * R3: backoff reset only by successful traffic.
 * R4: single reconnect loop — only this class calls openOne().
 * R5: openOne() opens exactly one pair; pairs tracked in Set.
 * R6: no recursive retry in connLocal.
 * R7: tracker reset by traffic bytes > 0.
 * R8: shouldGiveUp() → emit('exit', ...).
 * R9: pairs.size === 0 after shouldGiveUp → hard exit.
 * R10: all dead events have {reason, kind, retriable} payload.
 *
 * Events:
 *   'url'                — { publicUrl }
 *   'request'            — { method, path, status } — proxied request info
 *   'pair.open'          — { pairId }
 *   'pair.dead'          — { pairId, reason, kind, retriable }
 *   'failure.recorded'   — { kind, totalFailures, recentFailures }
 *   'reconnect.scheduled'— { delayMs }
 *   'capture'            — { captureId, file, method, path }
 *   'error'              — non-fatal error (code: 'LOCAL_DOWN' | 'LOCAL_UP')
 *   'close'              — tunnel closed gracefully
 *   'exit'               — { code, reason } — the CLI should process.exit()
 */
export class ClientTunnel extends EventEmitter {
  /**
   * @param {object} config - from buildExposeConfig()
   */
  constructor(config) {
    super();
    this.config = config;
    this.closed = false;
    this.info = null;
    this._cluster = null;

    // Singletons — never recreated per connection attempt
    this._failureTracker = new FailureTracker({
      windowS: config.reconnectLoopWindowS,
      maxInWindow: config.reconnectLoopMax,
      maxTotal: config.reconnectLoopMax * 5,
    });
    this._policy = new ReconnectPolicy();
  }

  /**
   * Initialize: fetch tunnel info from server, then open connections.
   * @param {string} sessionToken
   * @returns {Promise<void>}
   */
  async open(sessionToken) {
    this.info = await this._fetchTunnelInfo(sessionToken);
    this.emit('url', { publicUrl: this.info.publicUrl });
    this._cluster = new TunnelCluster(this.info, this.config, this._failureTracker, this._policy);

    this._cluster.on('tunnel:dead', ({ reason, kind, retriable, pairId }) => {
      debug('[%s] pair dead (reason=%s, retriable=%s, pairs=%d)',
        pairId, reason, retriable, this._cluster.pairs.size);

      if (this.closed) return;

      this.emit('pair.dead', { pairId, reason, kind, retriable });

      // Warn once (not on every retry) when the local app becomes unreachable.
      if (kind === 'localConnect' && reason === 'ECONNREFUSED') {
        if (!this._localDownWarned) {
          this._localDownWarned = true;
          this.emit('error', Object.assign(
            new Error(`Local service unreachable on ${this.config.localAddress}:${this.config.localPort} — waiting for it to come back up`),
            { code: 'LOCAL_DOWN' }
          ));
        }
      } else if (kind !== 'localConnect') {
        // Reset the warning flag when a non-local-down event occurs (e.g. remote drop)
        // so the next ECONNREFUSED streak shows the warning again.
        this._localDownWarned = false;
      }

      // Emit failure if tracker was charged (ECONNREFUSED is excluded from tracking)
      if (!(kind === 'localConnect' && reason === 'ECONNREFUSED')) {
        this.emit('failure.recorded', {
          kind,
          totalFailures: this._failureTracker.totalFailures,
          recentFailures: this._failureTracker.recentFailures,
        });
      }

      if (!retriable || this.config.reconnectLocal === false) {
        // Hard exit path for non-retriable failures
        if (this._cluster.pairs.size === 0) {
          this.close();
          this.emit('exit', { code: 0, reason });
        }
        return;
      }

      // Check failure tracker — are we thrashing?
      if (this._failureTracker.shouldGiveUp()) {
        debug('failure tracker triggered, giving up (reason=%s)', reason);
        this.close();
        this.emit('exit', { code: 1, reason: 'reconnect_loop_detected' });
        return;
      }

      // Only open a new connection if below the max
      if (this._cluster.pairs.size < this.info.maxConnections) {
        const delay = this._policy.nextDelay();
        debug('scheduling reconnect in %dms', delay);
        this.emit('reconnect.scheduled', { delayMs: delay });
        setTimeout(() => {
          if (!this.closed && this._cluster.pairs.size < this.info.maxConnections) {
            this._cluster.openOne().catch(err => {
              debug('openOne failed: %s', err.message);
            });
          }
        }, delay);
      }
    });

    this._cluster.on('open', pair => {
      debug('pair opened, total pairs: %d', this._cluster.pairs.size);
      this.emit('pair.open', { pairId: pair.id });
      if (this._localDownWarned) {
        this._localDownWarned = false;
        this.emit('error', Object.assign(
          new Error(`Local service back online on ${this.config.localAddress}:${this.config.localPort}`),
          { code: 'LOCAL_UP' }
        ));
      }
    });

    this._cluster.on('request', req => this.emit('request', req));
    this._cluster.on('capture', cap => this.emit('capture', cap));

    // Open initial connections (up to maxConnections)
    const opens = [];
    for (let i = 0; i < this.info.maxConnections; i++) {
      opens.push(this._cluster.openOne().catch(err => {
        debug('initial openOne[%d] failed: %s', i, err.message);
      }));
    }
    await Promise.allSettled(opens);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._cluster) this._cluster.close();
    this.emit('close');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Fetch tunnel info from server
  // ──────────────────────────────────────────────────────────────────────────

  async _fetchTunnelInfo(sessionToken) {
    const { config } = this;
    const base = config.serverUrl.replace(/\/$/, '');
    const path = config.tunnelSubdomain
      ? `/api/tunnels/${config.tunnelSubdomain}`
      : '/api/tunnels';

    const url = `${base}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-TT-Session-Token': sessionToken,
    };

    // HMAC authentication
    if (config.hmacSecret) {
      const serverUrl = new URL(url);
      const requestPath = serverUrl.pathname + serverUrl.search;
      const { header } = sign({ method: 'POST', path: requestPath, secret: config.hmacSecret });
      headers['X-TT-Auth'] = header;
      debug('HMAC auth header added for POST %s', requestPath);
    }

    let lastError;
    for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
      if (attempt > 0) await _sleep(1000);
      try {
        const res = await fetch(url, { method: 'POST', headers });
        const body = await res.json().catch(() => ({}));

        if (res.ok) {
          debug('tunnel created: id=%s port=%d', body.tunnelId, body.tunnelPort);
          // Override tunnelHost with the server URL's hostname. The server returns
          // its public domain (e.g. tt.example.com), but in Docker or private
          // networks the client may only be able to reach the server via the
          // host it already used for the API call.
          const serverHostname = new URL(config.serverUrl).hostname;
          return { ...body, tunnelHost: serverHostname };
        }

        if (res.status === 401) {
          this.emit('tunnel.token_missing', { code: 401, reason: body.error || res.statusText });
          this.emit('auth.rejected', { code: 401, reason: body.error || res.statusText });
          throw Object.assign(new Error(`Authentication failed: ${body.error || res.statusText}`), { fatal: true });
        }
        if (res.status === 400) {
          throw Object.assign(new Error(`Bad request: ${body.error || res.statusText}`), { fatal: true });
        }
        if (res.status === 403) {
          this.emit('auth.rejected', { code: 403, reason: body.error || res.statusText });
          throw Object.assign(new Error(`Forbidden: ${body.error || res.statusText}`), { fatal: true });
        }
        if (res.status === 409) {
          throw Object.assign(new Error(
            `Tunnel subdomain conflict: ${body.error}\nTip: use --ephemeral or change --tunnel-subdomain`
          ), { fatal: true });
        }
        if (res.status === 429) {
          const info = [
            body.error,
            res.headers.get('x-tt-max-connections') && `max: ${res.headers.get('x-tt-max-connections')}`,
            res.headers.get('x-tt-current-connections') && `current: ${res.headers.get('x-tt-current-connections')}`,
          ].filter(Boolean).join(', ');
          throw Object.assign(new Error(`Too many connections: ${info}`), { fatal: true });
        }

        // 5xx — retry
        if (res.status >= 500) {
          lastError = new Error(`Server error ${res.status}: ${body.error || res.statusText}`);
          debug('server error %d (attempt %d/%d)', res.status, attempt + 1, MAX_FETCH_RETRIES);
          continue;
        }

        throw new Error(`Unexpected status ${res.status}: ${body.error || res.statusText}`);
      } catch (err) {
        if (err.fatal) throw err;
        lastError = err;
        debug('fetch error (attempt %d/%d): %s', attempt + 1, MAX_FETCH_RETRIES, err.message);
      }
    }

    throw lastError ?? new Error('Failed to connect to tunnel server');
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
