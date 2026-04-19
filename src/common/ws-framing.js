/**
 * Minimal RFC 6455 WebSocket framing for the control channel.
 *
 * Scope (only what the control protocol needs):
 *   - Text (0x1) and Binary (0x2) data frames, unfragmented
 *   - Ping (0x9), Pong (0xA), Close (0x8) control frames
 *   - Server→client: unmasked; client→server: masked (RFC 6455 §5.3)
 *   - Payload size up to 2^32-1 (64-bit encoding accepted on parse; 32-bit cap on send)
 *
 * Not supported: fragmentation (FIN=0), extensions, per-message compression.
 * The control channel only sends small JSON objects, so this is sufficient.
 */
import { randomBytes, createHash } from 'node:crypto';

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xA;

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Compute the Sec-WebSocket-Accept value for a given Sec-WebSocket-Key.
 */
export function computeAcceptKey(key) {
  return createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

/**
 * Encode one frame. `mask` is true for client→server frames.
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @param {boolean} mask
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload, mask) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length;

  let header;
  let maskOffset;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
    maskOffset = 2;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    maskOffset = 4;
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
    maskOffset = 10;
  }
  header[0] = 0x80 | (opcode & 0x0F); // FIN=1

  if (!mask) return Buffer.concat([header, data]);

  header[1] |= 0x80;
  const maskKey = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}

/**
 * Incremental frame parser. Feed bytes via push(buf); receive full frames via
 * the onFrame callback. Frames with FIN=0 or continuation opcode are rejected
 * (we do not support fragmentation on the control channel).
 *
 * @param {{ onFrame: (opcode: number, payload: Buffer) => void, onError?: (msg: string) => void }} handlers
 */
export function createFrameParser({ onFrame, onError }) {
  let buf = Buffer.alloc(0);

  return {
    push(chunk) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (true) {
        if (buf.length < 2) return;
        const byte0 = buf[0];
        const byte1 = buf[1];
        const fin = (byte0 & 0x80) !== 0;
        const opcode = byte0 & 0x0F;
        const masked = (byte1 & 0x80) !== 0;
        let payloadLen = byte1 & 0x7F;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) return;
          const high = buf.readUInt32BE(2);
          const low = buf.readUInt32BE(6);
          if (high !== 0) { onError?.('frame too large'); return; }
          payloadLen = low;
          offset = 10;
        }
        let maskKey = null;
        if (masked) {
          if (buf.length < offset + 4) return;
          maskKey = buf.slice(offset, offset + 4);
          offset += 4;
        }
        if (buf.length < offset + payloadLen) return;

        let payload = buf.slice(offset, offset + payloadLen);
        if (masked) {
          const unmasked = Buffer.allocUnsafe(payloadLen);
          for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
          payload = unmasked;
        }
        buf = buf.slice(offset + payloadLen);

        if (!fin || opcode === OP_CONT) {
          onError?.('fragmented frames not supported');
          return;
        }
        onFrame(opcode, payload);
      }
    },
  };
}
