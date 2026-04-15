#!/usr/bin/env node

import { parseCli } from '../src/cli.js';

const { subcommand, config } = parseCli();

if (subcommand === 'serve') {
  const { runServe } = await import('../src/server/index.js');
  await runServe(config);
} else if (subcommand === 'expose') {
  const { runExpose } = await import('../src/client/index.js');
  await runExpose(config);
} else if (subcommand === 'replay') {
  const { runReplay } = await import('../src/replay/index.js');
  await runReplay(config);
}
