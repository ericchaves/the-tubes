import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Open a URL in the system's default browser.
 * @param {string} url
 */
export function openBrowser(url) {
  const commands = {
    darwin: 'open',
    win32: 'start',
    linux: 'xdg-open',
  };
  const cmd = commands[platform()] ?? 'xdg-open';
  const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}
