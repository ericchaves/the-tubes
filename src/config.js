import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { ConfigError } from './common/errors.js';
import { loadSecret } from './common/secret-loader.js';

/**
 * Load environment variables from a .env file (key=value format).
 * Only loads if file exists; does NOT override existing env vars.
 * @param {string} envFile
 */
export function loadEnvFile(envFile) {
  const path = resolve(envFile);
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

function _bool(val, def) {
  if (val === undefined || val === '') return def;
  return val === 'true' || val === '1';
}

function _int(val, def) {
  if (val === undefined || val === '') return def;
  const n = parseInt(val, 10);
  if (isNaN(n)) return def;
  return n;
}

function _str(val, def) {
  if (val === undefined || val === '') return def;
  return val;
}

/**
 * Build serve-mode configuration from env.
 * @param {Record<string,string>} env
 * @returns {object}
 */
export function buildServeConfig(env = process.env) {
  const hmacSecret = loadSecret('HMAC', env);
  const clockSkewS = _int(env.TT_HMAC_CLOCK_SKEW_TOLERANCE_S, 60);

  const cfg = {
    publicPort: _int(env.TT_PUBLIC_PORT, 80),
    publicAddress: _str(env.TT_PUBLIC_ADDRESS, '0.0.0.0'),
    publicDomain: _str(env.TT_PUBLIC_DOMAIN, null),
    publicHttps: _bool(env.TT_PUBLIC_HTTPS, false),
    externalHttpPort: _int(env.TT_EXTERNAL_HTTP_PORT, null),
    externalHttpsPort: _int(env.TT_EXTERNAL_HTTPS_PORT, null),
    landingUrl: _str(env.TT_LANDING_URL, null),
    apiPort: _int(env.TT_API_PORT, null),
    apiAddress: _str(env.TT_API_ADDRESS, '0.0.0.0'),
    tunnelPortStart: _int(env.TT_TUNNEL_PORT_START, null),
    tunnelPortEnd: _int(env.TT_TUNNEL_PORT_END, null),
    maxConnectionsPerTunnel: _int(env.TT_MAX_CONNECTIONS_PER_TUNNEL, 10),
    reconnectWindowMs: _int(env.TT_RECONNECT_WINDOW_MS, 30_000),
    reconnectWindowMaxMs: 300_000,
    trustForwardHeaders: _bool(env.TT_TRUST_FORWARD_HEADERS, false),
    httpWaitTimeoutMs: _int(env.TT_HTTP_WAIT_TIMEOUT_MS, 5_000),
    websocketWaitTimeoutMs: _int(env.TT_WEBSOCKET_WAIT_TIMEOUT_MS, 10_000),
    retryAfterSeconds: _int(env.TT_RETRY_AFTER_SECONDS, 5),
    tunnelPollIntervalMs: 100,
    hmacSecret,
    hmacClockSkewToleranceS: clockSkewS,
    hmacNonceMaxAgeS: clockSkewS * 2,
    hmacNonceCacheTtlS: clockSkewS * 4,
    // ── Security & persistence ─────────────────────────────────────────────
    // adminToken: resolved at startup in runServe() (auto-generated if null)
    adminToken: _str(env.TT_ADMIN_TOKEN, null),
    dataDir: _str(env.TT_DATA_DIR, resolve(homedir(), '.tt')),
    // ── Rate limiting ──────────────────────────────────────────────────────
    rateLimitWindowMs: _int(env.TT_RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMaxHits: _int(env.TT_RATE_LIMIT_MAX_HITS, 30),
    rateLimitBlockDurationMs: _int(env.TT_RATE_LIMIT_BLOCK_DURATION_MS, 300_000),
  };

  // Derived defaults for external ports
  if (cfg.externalHttpPort === null) cfg.externalHttpPort = cfg.publicPort;
  if (cfg.externalHttpsPort === null) cfg.externalHttpsPort = cfg.publicPort;

  validateServeConfig(cfg);
  return cfg;
}

function validateServeConfig(cfg) {
  if (cfg.reconnectWindowMs > cfg.reconnectWindowMaxMs) {
    throw new ConfigError(
      `TT_RECONNECT_WINDOW_MS (${cfg.reconnectWindowMs}) exceeds maximum (${cfg.reconnectWindowMaxMs})`
    );
  }
  if (cfg.tunnelPortStart !== null && cfg.tunnelPortEnd !== null) {
    if (cfg.tunnelPortStart >= cfg.tunnelPortEnd) {
      throw new ConfigError('TT_TUNNEL_PORT_START must be less than TT_TUNNEL_PORT_END');
    }
  }
  if (cfg.hmacSecret && cfg.hmacSecret.length < 32) {
    throw new ConfigError('TT_HMAC_SECRET must be at least 32 characters long');
  }
}

/**
 * Build expose-mode configuration from env.
 * @param {Record<string,string>} env
 * @returns {object}
 */
export function buildExposeConfig(env = process.env) {
  const hmacSecret = loadSecret('HMAC', env);

  return {
    localPort: _int(env.TT_LOCAL_PORT, null),
    localAddress: _str(env.TT_LOCAL_ADDRESS, 'localhost'),
    localTls: _bool(env.TT_LOCAL_TLS, false),
    localTlsCert: _str(env.TT_LOCAL_TLS_CERT, null),
    localTlsKey: _str(env.TT_LOCAL_TLS_KEY, null),
    localTlsCa: _str(env.TT_LOCAL_TLS_CA, null),
    allowInsecureLocalTls: _bool(env.TT_ALLOW_INSECURE_LOCAL_TLS, false),
    rewriteHostHeader: _bool(env.TT_REWRITE_HOST_HEADER, true),
    serverUrl: _str(env.TT_SERVER_URL, null),
    tunnelSubdomain: _str(env.TT_TUNNEL_SUBDOMAIN, null),
    sessionToken: _str(env.TT_SESSION_TOKEN, null),
    ephemeral: _bool(env.TT_EPHEMERAL, false),
    sessionTokenFile: _str(env.TT_SESSION_TOKEN_FILE, null),
    hmacSecret,
    openBrowser: _bool(env.TT_OPEN_BROWSER, false),
    logRequests: _bool(env.TT_LOG_REQUESTS, false),
    captureDir: _str(env.TT_CAPTURE_DIR, null),
    captureMaxBodyKb: _int(env.TT_CAPTURE_MAX_BODY_KB, 1024),
    reconnectLocal: _bool(env.TT_RECONNECT_LOCAL, true),
    reconnectLoopWindowS: _int(env.TT_RECONNECT_LOOP_WINDOW_S, 60),
    reconnectLoopMax: _int(env.TT_RECONNECT_LOOP_MAX, 10),
    adminPort: _int(env.TT_ADMIN_PORT, null),
    adminAddress: _str(env.TT_ADMIN_ADDRESS, '127.0.0.1'),
    flowsDir: _str(env.TT_FLOWS_DIR, null),
  };
}

/**
 * Build replay-mode configuration from env.
 * @param {Record<string,string>} env
 * @returns {object}
 */
export function buildReplayConfig(env = process.env) {
  return {
    manifest: _str(env.TT_REPLAY_MANIFEST, null),
    targetUrl: _str(env.TT_REPLAY_TARGET_URL, null),
    loop: _int(env.TT_REPLAY_LOOP, null),
    loopPauseMs: _int(env.TT_REPLAY_LOOP_PAUSE_MS, null),
    warmupMs: _int(env.TT_REPLAY_WARMUP_MS, null),
    sendHostHeader: _bool(env.TT_REPLAY_SEND_HOST_HEADER, false),
    dryRun: _bool(env.TT_REPLAY_DRY_RUN, false),
  };
}
