import { createDebug } from '../debug.js';
import { ServerTunnel } from './tunnel.js';
import { generateTunnelId } from '../common/id-generator.js';
import { EventLog } from './admin/event-log.js';
import {
  NoPortsAvailableError,
  TunnelConflictError,
  TunnelNotFoundError,
} from '../common/errors.js';

const debug = createDebug('server:manager');

/**
 * Manages all active server-side tunnels.
 * Identity is exclusively by sessionToken — never by IP.
 */
export class TunnelManager {
  /**
   * @param {object} config - server config
   * @param {import('./admin/event-log.js').GlobalEventLog} [globalLog]
   */
  constructor(config, globalLog = null) {
    this._cfg = config;
    this._globalLog = globalLog;
    /** @type {Map<string, ServerTunnel>} tunnelId → ServerTunnel */
    this._tunnels = new Map();
    /** @type {Map<string, string>} sessionToken → tunnelId (for reconnect reservation) */
    this._reservations = new Map();
    /** @type {Set<number>} currently assigned ports */
    this._usedPorts = new Set();
    /** @type {Map<string, EventLog>} tunnelId → EventLog */
    this._eventLogs = new Map();
  }

  /**
   * Create or reclaim a tunnel for the given session.
   *
   * @param {object} params
   * @param {string} params.sessionToken
   * @param {string} [params.requestedSubdomain]
   * @returns {Promise<ServerTunnel>}
   */
  async createTunnel({ sessionToken, requestedSubdomain }) {
    const tokenPrefix = sessionToken.slice(0, 8);

    // Check if this session already has a reserved tunnel (reconnect window)
    const existingId = this._reservations.get(sessionToken);
    if (existingId) {
      const existing = this._tunnels.get(existingId);
      if (existing) {
        existing.onReconnect();
        debug('[token=%s] reconnected to existing tunnel (id=%s)', tokenPrefix, existingId);
        return existing;
      }
    }

    // Determine tunnel ID
    let tunnelId;
    if (requestedSubdomain) {
      // Validate subdomain format
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(requestedSubdomain)) {
        throw Object.assign(new Error('Invalid subdomain format'), { status: 403 });
      }
      // Check if someone else holds this subdomain
      if (this._tunnels.has(requestedSubdomain)) {
        const existing = this._tunnels.get(requestedSubdomain);
        if (existing.sessionToken !== sessionToken) {
          throw new TunnelConflictError(requestedSubdomain, this._cfg.retryAfterSeconds);
        }
        // Same session reclaiming — shouldn't normally happen but treat as reconnect
        existing.onReconnect();
        return existing;
      }
      tunnelId = requestedSubdomain;
    } else {
      tunnelId = this._generateUniqueTunnelId();
    }

    // Allocate a port
    const port = this._allocatePort();
    debug('[token=%s] creating tunnel (id=%s, port=%d)', tokenPrefix, tunnelId, port);

    // Create per-tunnel event log and wire it to the global log
    const eventLog = new EventLog(tunnelId);
    this._eventLogs.set(tunnelId, eventLog);
    if (this._globalLog) {
      eventLog.addForwarder(e => this._globalLog.forward(e));
    }

    const tunnel = new ServerTunnel({
      tunnelId,
      sessionToken,
      maxConnections: this._cfg.maxConnectionsPerTunnel,
      reconnectWindowMs: Math.min(this._cfg.reconnectWindowMs, this._cfg.reconnectWindowMaxMs),
      assignedPort: port,
      serverConfig: this._cfg,
      eventLog,
    });

    this._tunnels.set(tunnelId, tunnel);
    this._reservations.set(sessionToken, tunnelId);

    tunnel.once('close', () => {
      this._tunnels.delete(tunnelId);
      this._reservations.delete(sessionToken);
      this._releasePort(port);
      // Keep the event log briefly so SSE clients can see the final events, then clean up
      setTimeout(() => {
        const log = this._eventLogs.get(tunnelId);
        if (log) {
          log.destroy();
          this._eventLogs.delete(tunnelId);
        }
      }, 5000);
      debug('[token=%s] tunnel removed (id=%s)', tokenPrefix, tunnelId);
    });

    await tunnel.startListening();
    return tunnel;
  }

  /**
   * Get an existing tunnel by ID.
   * @param {string} tunnelId
   * @returns {ServerTunnel}
   */
  getTunnel(tunnelId) {
    const tunnel = this._tunnels.get(tunnelId);
    if (!tunnel) throw new TunnelNotFoundError(tunnelId);
    return tunnel;
  }

  /**
   * Get a tunnel by ID without throwing (returns null if not found).
   * @param {string} tunnelId
   * @returns {ServerTunnel|null}
   */
  getTunnelSafe(tunnelId) {
    return this._tunnels.get(tunnelId) ?? null;
  }

  /**
   * Get the EventLog for a tunnel (returns null if tunnel not found).
   * @param {string} tunnelId
   * @returns {EventLog|null}
   */
  getEventLog(tunnelId) {
    return this._eventLogs.get(tunnelId) ?? null;
  }

  /**
   * Build the public URL for a tunnel.
   */
  buildPublicUrl(tunnelId) {
    const cfg = this._cfg;
    const scheme = cfg.publicHttps ? 'https' : 'http';
    const domain = cfg.publicDomain ? `${tunnelId}.${cfg.publicDomain}` : 'localhost';
    const port = cfg.publicHttps
      ? (cfg.externalHttpsPort !== 443 ? `:${cfg.externalHttpsPort}` : '')
      : (cfg.externalHttpPort !== 80 ? `:${cfg.externalHttpPort}` : '');
    return `${scheme}://${domain}${port}`;
  }

  get tunnelCount() { return this._tunnels.size; }

  /**
   * Returns a summary of all tunnels for /api/status and admin dashboard.
   */
  getStatus() {
    const tunnels = [];
    for (const [id, t] of this._tunnels) {
      tunnels.push({
        tunnelId: id,
        connected: t.connected,
        port: t.port,
        maxConnections: t.maxConnections,
        createdAt: t.createdAt,
        activeConnections: t.agent.activeCount,
        controlConnected: t.connected,
      });
    }
    return tunnels;
  }

  destroyAll() {
    for (const tunnel of this._tunnels.values()) tunnel.destroy();
    this._tunnels.clear();
    this._reservations.clear();
    this._usedPorts.clear();
    for (const log of this._eventLogs.values()) log.destroy();
    this._eventLogs.clear();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Port allocation
  // ────────────────────────────────────────────────────────────────────────────

  _allocatePort() {
    const cfg = this._cfg;
    if (cfg.tunnelPortStart !== null && cfg.tunnelPortEnd !== null) {
      for (let p = cfg.tunnelPortStart; p <= cfg.tunnelPortEnd; p++) {
        if (!this._usedPorts.has(p)) {
          this._usedPorts.add(p);
          return p;
        }
      }
      throw new NoPortsAvailableError();
    }
    return 0; // OS assigns
  }

  _releasePort(port) {
    this._usedPorts.delete(port);
  }

  _generateUniqueTunnelId() {
    for (let attempts = 0; attempts < 20; attempts++) {
      const id = generateTunnelId();
      if (!this._tunnels.has(id)) return id;
    }
    // Fallback with random suffix
    return `${generateTunnelId()}-${Math.random().toString(36).slice(2, 6)}`;
  }
}
