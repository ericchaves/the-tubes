import { loadManifest } from './manifest.js';
import { runReplaySession } from './runner.js';
import { ConfigError } from '../common/errors.js';

/**
 * Entry point for `tt replay`.
 * @param {object} config - from buildReplayConfig()
 */
export async function runReplay(config) {
  if (!config.manifest) {
    throw new ConfigError('--manifest is required');
  }

  const { manifest, manifestDir } = loadManifest(config.manifest);

  await runReplaySession(manifest, manifestDir, {
    targetUrl: config.targetUrl,
    dryRun: config.dryRun,
    sendHostHeader: config.sendHostHeader,
    loop: config.loop,
    loopPauseMs: config.loopPauseMs,
    warmupMs: config.warmupMs,
    verbose: config.verbose,
  });
}
