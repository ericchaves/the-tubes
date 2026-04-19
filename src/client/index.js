import { styleText } from 'node:util';
import { ClientTunnel } from './tunnel.js';
import { resolveSessionToken } from '../common/session-file.js';
import { openBrowser } from './open-browser.js';
import { ConfigError } from '../common/errors.js';
import { createDebug, debugManager } from '../debug.js';

const debug = createDebug('client');

/**
 * Run the expose client.
 * @param {object} config - from buildExposeConfig()
 */
export async function runExpose(config) {
  // Validate required fields
  if (!config.localPort) {
    throw new ConfigError('--local-port is required');
  }
  if (!config.serverUrl) {
    throw new ConfigError('--server-url is required');
  }

  // Resolve session token
  let sessionToken = config.sessionToken;
  if (config.ephemeral) {
    const { randomBytes } = await import('node:crypto');
    sessionToken = randomBytes(16).toString('hex');
    debug('ephemeral session token generated');
  } else if (!sessionToken) {
    const { token, persisted } = resolveSessionToken(config.sessionTokenFile);
    sessionToken = token;
    if (!persisted) {
      console.log(styleText('dim',
        `Session token generated and saved to ${config.sessionTokenFile ?? '~/.tt/session'}`
      ));
    }
  }

  debug('session token: %s...', sessionToken.slice(0, 8));

  // ── Admin server setup ─────────────────────────────────────────────────────
  let adminLog = null;
  let adminServer = null;
  let tunnelState = {
    status: 'closed',
    publicUrl: null,
    localAddress: config.localAddress,
    localPort: config.localPort,
    localTls: config.localTls ?? false,
    tunnelId: null,
    maxConnections: 0,
    totalFailures: 0,
    recentFailures: 0,
    lastReason: null,
    startedAt: null,
  };

  if (config.adminPort) {
    const { ClientEventLog } = await import('./admin/event-log.js');
    const { createAdminServer } = await import('./admin/server.js');
    const { runReplaySession } = await import('../replay/runner.js');

    adminLog = new ClientEventLog();

    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([k]) => !['sessionToken', 'hmacSecret'].includes(k))
    );

    adminServer = createAdminServer({
      log: adminLog,
      getState: () => ({ ...tunnelState }),
      filteredConfig,
      flowsDir: config.flowsDir,
      getTunnel: () => tunnel,
      debugManager,
      onReplay: async (manifest, manifestDir, name) => {
        // Derive an internal target URL so the replay can reach the tunnel server
        // from inside a container. The manifest target (e.g. http://demo.tt.localhost:8080)
        // may not be DNS-resolvable inside Docker, but tunnelHost (e.g. tt-server) always is.
        // Replacing the hostname routes requests through the server, which the tunnel
        // cluster forwards to the local service — triggering captures exactly like
        // `task replay -- --target-url http://tt-server:8080 --send-host-header`.
        let targetUrl;
        let sendHostHeader = false;
        const info = tunnel.info;
        if (info?.publicUrl && info?.tunnelHost) {
          try {
            const u = new URL(info.publicUrl);
            u.hostname = info.tunnelHost;
            targetUrl = u.origin; // scheme://tunnelHost:port
            sendHostHeader = true;
          } catch { /* leave targetUrl undefined → fall back to manifest.target */ }
        }

        const total = manifest.steps.length;
        const effectiveTarget = targetUrl ?? manifest.target;
        adminLog.push('replay.started', { manifest: name, steps: total, target: effectiveTarget });
        const t0 = Date.now();
        try {
          await runReplaySession(manifest, manifestDir, {
            targetUrl,
            sendHostHeader,
            onStep({ stepIdx, total: tot, method, url, status, durationMs, error }) {
              if (error) {
                adminLog.push('replay.step.error', { manifest: name, stepIndex: stepIdx, total: tot, method, url, error });
              } else {
                adminLog.push('replay.step', { manifest: name, stepIndex: stepIdx, total: tot, method, url, status, durationMs });
              }
            },
          });
          adminLog.push('replay.completed', { manifest: name, durationMs: Date.now() - t0 });
        } catch (err) {
          adminLog.push('replay.error', { manifest: name, error: err.message });
        }
      },
    });

    const boundPort = await adminServer.listen(config.adminPort, config.adminAddress);
    debug('admin server listening on port %d', boundPort);
  }

  // ── Tunnel ─────────────────────────────────────────────────────────────────
  const tunnel = new ClientTunnel(config);

  tunnel.on('url', ({ publicUrl }) => {
    const info = tunnel.info ?? {};
    tunnelState.status = 'open';
    tunnelState.publicUrl = publicUrl;
    tunnelState.tunnelId = info.tunnelId ?? null;
    tunnelState.maxConnections = info.maxConnections ?? 0;
    tunnelState.startedAt = new Date().toISOString();

    console.log(styleText('green', `\nTunnel open:`));
    console.log(`  public:  ${styleText('cyan', publicUrl)}`);
    console.log(`  local:   ${config.localTls ? 'https' : 'http'}://${config.localAddress}:${config.localPort}`);
    if (config.captureDir) console.log(`  capture: ${config.captureDir} (${config.captureEnabled ? 'enabled' : 'disabled'})`);
    if (config.hmacSecret) console.log(styleText('yellow', '  hmac:    enabled'));
    if (adminServer) console.log(`  admin:   ${styleText('cyan', `http://localhost:${config.adminPort}`)}`);

    adminLog?.push('expose.started', {
      serverUrl: config.serverUrl,
      localAddress: config.localAddress,
      localPort: config.localPort,
      publicUrl,
    });
    adminLog?.push('tunnel.open', {
      tunnelId: info.tunnelId,
      publicUrl,
      maxConnections: info.maxConnections,
    });

    if (config.openBrowser) {
      openBrowser(publicUrl);
    }
  });

  tunnel.on('pair.open', ({ pairId }) => {
    adminLog?.push('pair.open', { pairId });
  });

  tunnel.on('control.connected', ({ controlId }) => {
    tunnelState.controlConnected = true;
    tunnelState.controlId = controlId;
    adminLog?.push('control.connected', { controlId });
  });

  tunnel.on('control.resumed', ({ controlId, previousControlId, keep, drop }) => {
    tunnelState.controlConnected = true;
    tunnelState.controlId = controlId;
    adminLog?.push('control.resumed', {
      controlId, previousControlId,
      keptPairs: (keep ?? []).length,
      droppedPairs: (drop ?? []).length,
    });
  });

  tunnel.on('control.disconnected', ({ reason }) => {
    tunnelState.controlConnected = false;
    adminLog?.push('control.disconnected', { reason });
  });

  tunnel.on('pair.dead', ({ pairId, reason, kind, retriable }) => {
    adminLog?.push('pair.dead', { pairId, reason, kind, retriable });
  });

  tunnel.on('failure.recorded', ({ kind, totalFailures, recentFailures }) => {
    tunnelState.totalFailures = totalFailures;
    tunnelState.recentFailures = recentFailures;
    tunnelState.lastReason = kind;
    adminLog?.push('failure.recorded', { kind, totalFailures, recentFailures });
  });

  tunnel.on('reconnect.scheduled', ({ delayMs }) => {
    adminLog?.push('reconnect.scheduled', { delayMs });
  });

  tunnel.on('request', ({ method, path, status }) => {
    if (config.logRequests) {
      console.log(`${new Date().toISOString()} ${method} ${path}`);
    }
    adminLog?.push('request', { method, path, status });
  });

  tunnel.on('capture', ({ captureId, file, method, path }) => {
    adminLog?.push('capture.saved', { captureId, file, method, path });
  });

  tunnel.on('error', (err) => {
    debug('tunnel error: %s', err.message);
    if (err.code === 'LOCAL_DOWN') {
      console.warn(styleText('yellow', `\n  warning: ${err.message}`));
      adminLog?.push('local.down', { address: config.localAddress, port: config.localPort });
    } else if (err.code === 'LOCAL_UP') {
      console.log(styleText('green', `\n  local service reconnected`));
      adminLog?.push('local.up', { address: config.localAddress, port: config.localPort });
    }
  });

  tunnel.on('tunnel.token_missing', ({ code, reason }) => {
    adminLog?.push('tunnel.token_missing', { code, reason });
  });

  tunnel.on('auth.rejected', ({ code, reason }) => {
    adminLog?.push('auth.rejected', { code, reason });
  });

  tunnel.on('exit', ({ code, reason }) => {
    tunnelState.status = 'closed';
    console.log(styleText(code === 0 ? 'dim' : 'red',
      `\nTunnel closed: ${reason}`
    ));
    adminLog?.push('expose.exit', { code, reason });
    if (adminServer) adminServer.close();
    process.exit(code);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nClosing tunnel...');
    tunnel.close();
    if (adminServer) adminServer.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await tunnel.open(sessionToken);
    debug('initial connections established');
  } catch (err) {
    console.error(styleText('red', `\nFailed to open tunnel: ${err.message}`));
    if (adminServer) adminServer.close();
    process.exit(1);
  }
}
