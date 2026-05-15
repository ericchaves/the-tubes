import { parseArgs } from 'node:util';
import { loadEnvFile, buildServeConfig, buildExposeConfig, buildReplayConfig } from './config.js';
import { resetSessionFile } from './common/session-file.js';

const VERSION = '1.0.0';

const HELP = `
tt — expose local services to the world

Usage:
  tt serve   [options]   Run a tunnel server
  tt expose  [options]   Expose a local port via a tunnel server
  tt replay  [options]   Replay captured HTTP requests against a webhook
  tt session reset       Remove persisted session token
  tt --version
  tt --help

Options (shared):
  --env-file <path>    Load environment variables from file (default: .env if present)
  --debug <namespace>  Enable debug output (sets NODE_DEBUG=tt:<namespace>)
  --help               Show this help
  --version            Show version

Run "tt <command> --help" for command-specific options.
`.trim();

const SERVE_HELP = `
tt serve — run a tunnel server

  --public-port <n>              Port for tunnel traffic (default: 80)
  --public-address <addr>        Bind address (default: 0.0.0.0)
  --public-domain <domain>       Base domain (tunnels become <id>.<domain>)
  --public-https                 Generate https:// publicUrls (behind TLS proxy)
  --external-http-port <n>       Public HTTP port announced in URLs (default: --public-port)
  --external-https-port <n>      Public HTTPS port announced in URLs
  --landing-url <url>            Redirect GET / to this URL
  --api-port <n>                 Separate port for /api/* (tunnel creation)
  --api-address <addr>           Bind address for API server
  --tunnel-port-start <n>        Start of TCP port range for tunnel connections
  --tunnel-port-end <n>          End of TCP port range
  --max-connections-per-tunnel <n>  Max concurrent TCP connections per expose (default: 10)
  --reconnect-window-ms <n>      How long tunnelId is reserved after disconnect (default: 30000)
  --trust-forward-headers        Use X-Forwarded-For for client IP in logs
  --http-wait-timeout-ms <n>     Wait for tunnel connection to serve HTTP (default: 5000)
  --websocket-wait-timeout-ms <n> Wait for tunnel connection for WebSocket upgrade (default: 10000)
  --retry-after-seconds <n>      Retry-After header value in 503 responses (default: 5)
  --hmac-secret <secret>         Shared HMAC secret (>=32 chars). Requires auth on tunnel creation.
  --hmac-secret-file <path>      Read HMAC secret from file (Docker/K8s secrets)
  --hmac-clock-skew-tolerance-s <n>  Timestamp tolerance in seconds (default: 60)

Environment variables: TT_PUBLIC_PORT, TT_PUBLIC_DOMAIN, TT_HMAC_SECRET, etc.
See .env.example for full list.
`.trim();

const EXPOSE_HELP = `
tt expose — expose a local port via a tunnel server

  --local-port <n>               Local port to expose (required)
  --local-address <addr>         Local host/IP to forward traffic to (default: localhost)
  --local-tls                    Local service speaks TLS (HTTPS)
  --local-tls-cert <path>        PEM certificate for local TLS
  --local-tls-key <path>         PEM key for local TLS
  --local-tls-ca <path>          PEM CA for local TLS (self-signed)
  --allow-insecure-local-tls     Skip TLS verification for local service
  --no-rewrite-host-header       Keep original Host header (default: rewrite to local address)
  --server-url <url>             URL of tt serve (required)
  --tunnel-subdomain <name>      Request a specific subdomain
  --session-token <token>        Session identity token (auto-generated if absent)
  --ephemeral                    Use a random token per run, no persistence
  --session-token-file <path>    Path to persist session token (default: ~/.tt/session)
  --hmac-secret <secret>         HMAC secret matching the server (>=32 chars)
  --open-browser                 Open publicUrl in default browser
  --log-requests                 Print one line per proxied request
  --capture-dir <path>           Save request/response YAML captures to this directory
  --capture-max-body-kb <n>      Truncate captured bodies above this size (default: 1024)
  --no-reconnect-local           Exit when local service closes instead of retrying
  --reconnect-loop-window-s <n>  Sliding window for loop detection (default: 60)
  --reconnect-loop-max <n>       Max failures in window before hard exit (default: 10)
  --admin-port <n>               Start HTTP admin UI on this port (localhost only)
  --admin-address <addr>         Bind address for admin UI (default: 127.0.0.1; use 0.0.0.0 in Docker)
  --flows-dir <path>             Directory with replay manifest YAML files

Environment variables: TT_LOCAL_PORT, TT_SERVER_URL, TT_SESSION_TOKEN, etc.
`.trim();

const REPLAY_HELP = `
tt replay — replay captured HTTP requests against a webhook

  --manifest <path>              Replay manifest YAML file (required)
  --target-url <url>             Override the target URL from manifest
  --loop <n>                     Number of times to repeat the sequence
  --loop-pause-ms <n>            Pause between loops in milliseconds
  --warmup-ms <n>                Delay before starting
  --send-host-header             Include original Host header from capture
  --dry-run                      Print what would be sent without sending
  -v                             Print response status and body
  -vv                            Print full HTTP response (headers + body)
  -vvv                           Print full HTTP request and response

Manifest format: see docs/REPLAY.md
`.trim();

/**
 * Parse command line arguments and return { subcommand, config, rawArgs }.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ subcommand: string, config: object, rawArgs: string[] }}
 */
export function parseCli(argv = process.argv.slice(2)) {
  // Extract --env-file and --debug before subcommand dispatch
  let envFile = existsIfPresent(argv, '--env-file') ?? '.env';
  loadEnvFile(envFile);

  const debugNs = extractStringFlag(argv, '--debug');
  if (debugNs) {
    process.env.NODE_DEBUG = [process.env.NODE_DEBUG, `tt:${debugNs}`].filter(Boolean).join(',');
  }

  const first = argv[0];

  if (!first || first === '--help' || first === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    process.exit(0);
  }

  if (first === 'session') {
    const second = argv[1];
    if (second === 'reset') {
      const sessionFile = extractStringFlag(argv.slice(2), '--session-token-file');
      resetSessionFile(sessionFile);
      console.log('Session token removed.');
      process.exit(0);
    }
    console.error(`Unknown session subcommand: ${second}`);
    process.exit(1);
  }

  const subcommand = first;
  const rest = argv.slice(1);

  if (subcommand === 'serve') {
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(SERVE_HELP);
      process.exit(0);
    }
    return { subcommand, config: buildServeConfig(argsToEnv(rest, 'serve')), rawArgs: rest };
  }

  if (subcommand === 'expose') {
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(EXPOSE_HELP);
      process.exit(0);
    }
    return { subcommand, config: buildExposeConfig(argsToEnv(rest, 'expose')), rawArgs: rest };
  }

  if (subcommand === 'replay') {
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(REPLAY_HELP);
      process.exit(0);
    }
    return { subcommand, config: buildReplayConfig(argsToEnv(rest, 'replay')), rawArgs: rest };
  }

  console.error(`Unknown command: ${subcommand}\n`);
  console.log(HELP);
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// Flag-to-env mapping
// ──────────────────────────────────────────────────────────────────────────────

const SERVE_FLAGS = {
  '--public-port': 'TT_PUBLIC_PORT',
  '--public-address': 'TT_PUBLIC_ADDRESS',
  '--public-domain': 'TT_PUBLIC_DOMAIN',
  '--public-https': 'TT_PUBLIC_HTTPS',
  '--external-http-port': 'TT_EXTERNAL_HTTP_PORT',
  '--external-https-port': 'TT_EXTERNAL_HTTPS_PORT',
  '--landing-url': 'TT_LANDING_URL',
  '--api-port': 'TT_API_PORT',
  '--api-address': 'TT_API_ADDRESS',
  '--tunnel-port-start': 'TT_TUNNEL_PORT_START',
  '--tunnel-port-end': 'TT_TUNNEL_PORT_END',
  '--max-connections-per-tunnel': 'TT_MAX_CONNECTIONS_PER_TUNNEL',
  '--reconnect-window-ms': 'TT_RECONNECT_WINDOW_MS',
  '--trust-forward-headers': 'TT_TRUST_FORWARD_HEADERS',
  '--http-wait-timeout-ms': 'TT_HTTP_WAIT_TIMEOUT_MS',
  '--websocket-wait-timeout-ms': 'TT_WEBSOCKET_WAIT_TIMEOUT_MS',
  '--retry-after-seconds': 'TT_RETRY_AFTER_SECONDS',
  '--hmac-secret': 'TT_HMAC_SECRET',
  '--hmac-secret-file': 'TT_HMAC_SECRET_FILE',
  '--hmac-clock-skew-tolerance-s': 'TT_HMAC_CLOCK_SKEW_TOLERANCE_S',
};

const EXPOSE_FLAGS = {
  '--local-port': 'TT_LOCAL_PORT',
  '--local-address': 'TT_LOCAL_ADDRESS',
  '--local-tls': 'TT_LOCAL_TLS',
  '--local-tls-cert': 'TT_LOCAL_TLS_CERT',
  '--local-tls-key': 'TT_LOCAL_TLS_KEY',
  '--local-tls-ca': 'TT_LOCAL_TLS_CA',
  '--allow-insecure-local-tls': 'TT_ALLOW_INSECURE_LOCAL_TLS',
  '--rewrite-host-header': 'TT_REWRITE_HOST_HEADER',
  '--no-rewrite-host-header': ['TT_REWRITE_HOST_HEADER', 'false'],
  '--server-url': 'TT_SERVER_URL',
  '--tunnel-subdomain': 'TT_TUNNEL_SUBDOMAIN',
  '--session-token': 'TT_SESSION_TOKEN',
  '--ephemeral': 'TT_EPHEMERAL',
  '--session-token-file': 'TT_SESSION_TOKEN_FILE',
  '--hmac-secret': 'TT_HMAC_SECRET',
  '--open-browser': 'TT_OPEN_BROWSER',
  '--log-requests': 'TT_LOG_REQUESTS',
  '--capture-dir': 'TT_CAPTURE_DIR',
  '--capture': 'TT_CAPTURE_ENABLED',
  '--capture-max-body-kb': 'TT_CAPTURE_MAX_BODY_KB',
  '--reconnect-local': 'TT_RECONNECT_LOCAL',
  '--no-reconnect-local': ['TT_RECONNECT_LOCAL', 'false'],
  '--reconnect-loop-window-s': 'TT_RECONNECT_LOOP_WINDOW_S',
  '--reconnect-loop-max': 'TT_RECONNECT_LOOP_MAX',
  '--admin-port': 'TT_ADMIN_PORT',
  '--admin-address': 'TT_ADMIN_ADDRESS',
  '--flows-dir': 'TT_FLOWS_DIR',
};

const REPLAY_FLAGS = {
  '--manifest': 'TT_REPLAY_MANIFEST',
  '--target-url': 'TT_REPLAY_TARGET_URL',
  '--loop': 'TT_REPLAY_LOOP',
  '--loop-pause-ms': 'TT_REPLAY_LOOP_PAUSE_MS',
  '--warmup-ms': 'TT_REPLAY_WARMUP_MS',
  '--send-host-header': 'TT_REPLAY_SEND_HOST_HEADER',
  '--dry-run': 'TT_REPLAY_DRY_RUN',
  '-v':   ['TT_REPLAY_VERBOSE', '1'],
  '-vv':  ['TT_REPLAY_VERBOSE', '2'],
  '-vvv': ['TT_REPLAY_VERBOSE', '3'],
};

const FLAG_MAPS = { serve: SERVE_FLAGS, expose: EXPOSE_FLAGS, replay: REPLAY_FLAGS };

// Boolean flags (no value argument)
const BOOL_FLAGS = new Set([
  '--public-https', '--trust-forward-headers', '--allow-insecure-local-tls',
  '--rewrite-host-header', '--no-rewrite-host-header',
  '--local-tls', '--ephemeral', '--open-browser', '--log-requests',
  '--reconnect-local', '--no-reconnect-local',
  '--capture',
  '--send-host-header', '--dry-run',
]);

/**
 * Convert CLI args to env-var overrides (CLI flags win over env).
 */
function argsToEnv(args, mode) {
  const map = FLAG_MAPS[mode] ?? {};
  const env = { ...process.env };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--env-file' || arg === '--debug') { i += 2; continue; }
    const mapping = map[arg];
    if (mapping) {
      if (Array.isArray(mapping)) {
        // --no-foo style with hardcoded value
        env[mapping[0]] = mapping[1];
        i++;
      } else if (BOOL_FLAGS.has(arg)) {
        env[mapping] = 'true';
        i++;
      } else {
        env[mapping] = args[i + 1] ?? '';
        i += 2;
      }
    } else {
      i++;
    }
  }
  return env;
}

function extractStringFlag(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

function existsIfPresent(argv, flag) {
  return extractStringFlag(argv, flag);
}
