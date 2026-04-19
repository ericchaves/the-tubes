import { EventEmitter } from 'node:events';
import { sign } from '../common/hmac.js';
import { createDebug } from '../debug.js';
import { TunnelCluster } from './tunnel-cluster.js';
import { FailureTracker } from './failure-tracker.js';
import { ReconnectPolicy } from './reconnect-policy.js';
import { ControlChannel } from './control-channel.js';

const debug = createDebug('client:tunnel');

const MAX_FETCH_RETRIES = 3;

/**
 * Client-side tunnel controller.
 *
 * Owns:
 *   - A ControlChannel (persistent WebSocket to the server) that drives the
 *     lifecycle of on-demand pairs.
 *   - A TunnelCluster that creates/destroys pairs in response to control
 *     messages.
 *
 * Events:
 *   'url'                — { publicUrl }
 *   'request'            — { method, path, status }
 *   'capture'            — { captureId, file, method, path }
 *   'pair.open'          — { pairId, requestId }
 *   'pair.dead'          — { pairId, reason, kind, retriable }
 *   'control.connected'    — { controlId }
 *   'control.resumed'      — { controlId, previousControlId, keep, drop }
 *   'control.disconnected' — { reason }
 *   'failure.recorded'   — { kind, totalFailures, recentFailures }
 *   'error'              — non-fatal ('LOCAL_DOWN'|'LOCAL_UP'|'CONTROL_DOWN')
 *   'close'              — tunnel closed gracefully
 *   'exit'               — { code, reason }
 */
export class ClientTunnel extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.closed = false;
    this.info = null;
    this._cluster = null;
    this._control = null;

    this._failureTracker = new FailureTracker({
      windowS: config.reconnectLoopWindowS,
      maxInWindow: config.reconnectLoopMax,
      maxTotal: config.reconnectLoopMax * 5,
    });
    this._policy = new ReconnectPolicy();
  }

  async open(sessionToken) {
    this.info = await this._fetchTunnelInfo(sessionToken);
    this.emit('url', { publicUrl: this.info.publicUrl });

    this._control = new ControlChannel({
      serverUrl: this.config.serverUrl,
      tunnelId: this.info.tunnelId,
      sessionToken,
      hmacSecret: this.config.hmacSecret,
      getInflightPairs: () => this._cluster ? this._cluster.getInflightPairIds() : [],
    });

    this._cluster = new TunnelCluster(this.info, this.config, this._failureTracker, this._policy, this._control);

    this._cluster.on('open', pair => {
      this.emit('pair.open', pair);
      if (this._localDownWarned) {
        this._localDownWarned = false;
        this.emit('error', Object.assign(
          new Error(`Local service back online on ${this.config.localAddress}:${this.config.localPort}`),
          { code: 'LOCAL_UP' }
        ));
      }
    });

    this._cluster.on('tunnel:dead', ({ pairId, reason, kind, retriable }) => {
      if (this.closed) return;
      this.emit('pair.dead', { pairId, reason, kind, retriable });

      if (kind === 'localConnect' && reason === 'ECONNREFUSED') {
        if (!this._localDownWarned) {
          this._localDownWarned = true;
          this.emit('error', Object.assign(
            new Error(`Local service unreachable on ${this.config.localAddress}:${this.config.localPort} — waiting for it to come back up`),
            { code: 'LOCAL_DOWN' }
          ));
        }
        return;
      }

      if (kind !== 'localConnect' && kind !== 'serverClose') {
        this.emit('failure.recorded', {
          kind,
          totalFailures: this._failureTracker.totalFailures,
          recentFailures: this._failureTracker.recentFailures,
        });
      }

      if (retriable && this._failureTracker.shouldGiveUp()) {
        this.close();
        this.emit('exit', { code: 1, reason: 'reconnect_loop_detected' });
      }
    });

    this._cluster.on('request', req => this.emit('request', req));
    this._cluster.on('capture', cap => this.emit('capture', cap));

    this._control.on('connected', info => this.emit('control.connected', info));
    this._control.on('resumed', info => this.emit('control.resumed', info));
    this._control.on('disconnected', info => {
      this.emit('control.disconnected', info);
      this.emit('error', Object.assign(
        new Error('Control channel disconnected — reconnecting'),
        { code: 'CONTROL_DOWN' }
      ));
    });
    this._control.on('heartbeat_timeout', () => {
      debug('control heartbeat timeout');
    });

    try {
      await this._control.connect();
    } catch (err) {
      debug('initial control connect failed: %s', err.message);
      // ControlChannel's reconnect loop will keep trying unless we close().
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._control) this._control.close();
    if (this._cluster) this._cluster.close();
    this.emit('close');
  }

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

    if (config.hmacSecret) {
      const serverUrl = new URL(url);
      const requestPath = serverUrl.pathname + serverUrl.search;
      const { header } = sign({ method: 'POST', path: requestPath, secret: config.hmacSecret });
      headers['X-TT-Auth'] = header;
    }

    let lastError;
    for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
      if (attempt > 0) await _sleep(1000);
      try {
        const res = await fetch(url, { method: 'POST', headers });
        const body = await res.json().catch(() => ({}));

        if (res.ok) {
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

        if (res.status >= 500) {
          lastError = new Error(`Server error ${res.status}: ${body.error || res.statusText}`);
          continue;
        }

        throw new Error(`Unexpected status ${res.status}: ${body.error || res.statusText}`);
      } catch (err) {
        if (err.fatal) throw err;
        lastError = err;
      }
    }

    throw lastError ?? new Error('Failed to connect to tunnel server');
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
