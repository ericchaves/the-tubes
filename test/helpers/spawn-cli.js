import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';

const CLI_PATH = resolve(import.meta.dirname, '../../bin/tt.js');

/**
 * Spawn a tt CLI process and capture output.
 * Emits 'line' for each stdout/stderr line.
 *
 * @param {string[]} args - CLI args
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.env] - extra env vars (merged with process.env)
 * @returns {{ proc: ChildProcess, lines: string[], emitter: EventEmitter, stop: function, waitForLine: function }}
 */
export function spawnCli(args, { env = {} } = {}) {
  const lines = [];
  const emitter = new EventEmitter();

  const proc = spawn('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  function onLine(line) {
    lines.push(line);
    emitter.emit('line', line);
  }

  let stdoutBuf = '';
  proc.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString();
    const parts = stdoutBuf.split('\n');
    stdoutBuf = parts.pop();
    for (const l of parts) onLine(l);
  });

  let stderrBuf = '';
  proc.stderr.on('data', chunk => {
    stderrBuf += chunk.toString();
    const parts = stderrBuf.split('\n');
    stderrBuf = parts.pop();
    for (const l of parts) onLine(l);
  });

  proc.on('close', () => {
    if (stdoutBuf) onLine(stdoutBuf);
    if (stderrBuf) onLine(stderrBuf);
    emitter.emit('close');
  });

  function stop() {
    proc.kill('SIGTERM');
    return new Promise(r => proc.on('close', r));
  }

  /**
   * Wait until a line matching the pattern appears.
   * @param {string|RegExp} pattern
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<string>}
   */
  function waitForLine(pattern, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const test = typeof pattern === 'string'
        ? l => l.includes(pattern)
        : l => pattern.test(l);

      // Check already-collected lines
      const existing = lines.find(test);
      if (existing) return resolve(existing);

      const timer = setTimeout(() => {
        emitter.off('line', handler);
        reject(new Error(`Timed out waiting for line matching: ${pattern}`));
      }, timeoutMs);

      function handler(line) {
        if (test(line)) {
          clearTimeout(timer);
          emitter.off('line', handler);
          resolve(line);
        }
      }

      emitter.on('line', handler);
    });
  }

  return { proc, lines, emitter, stop, waitForLine };
}
