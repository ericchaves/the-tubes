import { Transform } from 'node:stream';

/**
 * Stream Transform that rewrites the first `Host:` header in an HTTP request
 * to the configured local host, so virtual hosts work correctly.
 */
export class HeaderHostTransformer extends Transform {
  /**
   * @param {string} localHost - The host to write into the Host header
   */
  constructor(localHost) {
    super();
    this._localHost = localHost;
    this._replaced = false;
  }

  _transform(chunk, _encoding, callback) {
    if (this._replaced) {
      this.push(chunk);
      return callback();
    }

    let str = chunk.toString('binary');
    str = str.replace(/^(host:\s*)([^\r\n]+)/im, (_, prefix) => `${prefix}${this._localHost}`);
    this._replaced = true;
    this.push(Buffer.from(str, 'binary'));
    callback();
  }
}
