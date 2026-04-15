/**
 * Wait until a condition function returns truthy, polling at intervalMs.
 * Rejects if timeoutMs is exceeded.
 *
 * @param {function(): boolean|Promise<boolean>} condition
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.intervalMs=50]
 * @param {string} [opts.message]
 * @returns {Promise<void>}
 */
export async function waitFor(condition, { timeoutMs = 5000, intervalMs = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

/**
 * Wait for a URL to return a successful response.
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
export async function waitForUrl(url, opts = {}) {
  await waitFor(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }, { message: `URL ${url}`, ...opts });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
