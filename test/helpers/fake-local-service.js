import { createServer } from 'node:http';

/**
 * A simple local HTTP server for testing.
 * Can simulate various response behaviors and connection failures.
 */
export class FakeLocalService {
  constructor() {
    this._server = null;
    this.port = null;
    this.requests = [];
    this._handler = null;
  }

  /**
   * Start the fake service on a random port.
   * @param {function} [handler] - Optional request handler (req, res)
   * @returns {Promise<number>} the port
   */
  start(handler) {
    return new Promise((resolve, reject) => {
      this._handler = handler ?? defaultHandler;
      this._server = createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          this.requests.push({
            method: req.method,
            path: req.url,
            headers: req.headers,
            body,
          });
          this._handler(req, res, body);
        });
      });

      this._server.listen(0, '127.0.0.1', () => {
        this.port = this._server.address().port;
        resolve(this.port);
      });
      this._server.on('error', reject);
    });
  }

  /**
   * Stop the service.
   */
  stop() {
    return new Promise((resolve) => {
      if (!this._server) return resolve();
      this._server.close(() => resolve());
    });
  }

  /**
   * Crash the server (simulate hard kill).
   */
  crash() {
    if (this._server) {
      this._server.closeAllConnections?.();
      this._server.close();
      this._server = null;
      this.port = null;
    }
  }
}

function defaultHandler(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
