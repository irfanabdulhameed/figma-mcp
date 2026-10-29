// Read-only file access for view-only files: the wire format.
//
// Figma's file server speaks Kiwi (Evan Wallace's schema-based binary format)
// over its multiplayer WebSocket. The first frame of every connection is
// "fig-wire" + uint32 version + the zstd-compressed binary schema, so the
// decoder is built from what the server sends, not from a schema we ship.
// Every later frame is one zstd-compressed Kiwi `Message`.
//
// Pure functions only (no CDP, no Figma); view-session.js drives the socket.
import zlib from 'zlib';
import { decompress as fzstdDecompress } from 'fzstd';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';

const WIRE_MAGIC = 'fig-wire';
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const ZSTD_MAX_RAW_BLOCK = 128 * 1024;

const isZstd = (b) => b.length >= 4 && ZSTD_MAGIC.every((v, i) => b[i] === v);

/** zstd → bytes. Node 22.15+/23.8+ has it built in; older Node uses fzstd. */
export function zstdDecompress(buf) {
  if (typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf);
  return Buffer.from(fzstdDecompress(buf));
}

/**
 * bytes → zstd frame. Built-in when Node has it; otherwise a valid frame of
 * stored (raw) blocks, which every zstd decoder accepts. Our outgoing messages
 * are tiny queries, so skipping real compression costs nothing.
 */
export function zstdCompress(buf, { forceRaw = false } = {}) {
  if (!forceRaw && typeof zlib.zstdCompressSync === 'function') return zlib.zstdCompressSync(buf);
  const parts = [];
  // Frame header: magic, descriptor (single segment, 4-byte content size), content size.
  const head = Buffer.alloc(9);
  Buffer.from(ZSTD_MAGIC).copy(head, 0);
  head[4] = 0xa0;
  head.writeUInt32LE(buf.length, 5);
  parts.push(head);
  let off = 0;
  do {
    const size = Math.min(ZSTD_MAX_RAW_BLOCK, buf.length - off);
    const last = off + size >= buf.length ? 1 : 0;
    const bh = last | (0 << 1) | (size << 3); // block type 0 = raw
    parts.push(Buffer.from([bh & 0xff, (bh >> 8) & 0xff, (bh >> 16) & 0xff]));
    parts.push(buf.subarray(off, off + size));
    off += size;
  } while (off < buf.length);
  return Buffer.concat(parts);
}

/** True when a frame is the schema frame that opens every connection. */
export const isWireSchemaFrame = (b) =>
  b.length > 12 && Buffer.from(b.subarray(0, 8)).toString('latin1') === WIRE_MAGIC;

/** Schema frame → { version, schema, codec } where codec has encode/decodeMessage. */
export function readWireSchema(frame) {
  if (!isWireSchemaFrame(frame)) throw new Error('Not a fig-wire schema frame');
  const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const version = buf.readUInt32LE(8);
  const schema = decodeBinarySchema(new Uint8Array(zstdDecompress(buf.subarray(12))));
  if (!schema.definitions.some((d) => d.name === 'Message')) {
    throw new Error('fig-wire schema has no Message type (Figma changed its protocol)');
  }
  return { version, schema, codec: compileSchema(schema) };
}

/** One message frame → decoded Message object. */
export function decodeFrame(codec, frame) {
  return codec.decodeMessage(isZstd(frame) ? zstdDecompress(frame) : frame);
}

/** "12:34" → { sessionID: 12, localID: 34 }. */
export function parseGuid(id) {
  const m = String(id).match(/^(\d+)[:-](\d+)$/);
  if (!m) throw new Error(`Not a node id: ${id} (expected like 12:34)`);
  return { sessionID: Number(m[1]), localID: Number(m[2]) };
}

export const guidToId = (g) => `${g.sessionID}:${g.localID}`;

/**
 * A read request for one node and everything under it, compressed and ready
 * to send. This is a query only: the server answers it on read-only
 * connections, and no message we send can change the file.
 */
export function encodeSceneQuery(codec, startingNodeId, depth = 100000, opts = {}) {
  const bytes = codec.encodeMessage({
    type: 'SCENE_GRAPH_QUERY',
    sceneGraphQueries: [{ startingNode: parseGuid(startingNodeId), depth }],
  });
  return zstdCompress(Buffer.from(bytes), opts);
}

/**
 * File key from a Figma URL or a bare key.
 * figma.com/design/<key>/…, /file/<key>/…, /proto/<key>/…, /slides/<key>/…
 */
export function parseFileKey(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/figma\.com\/(?:design|file|proto|slides|board)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{10,64}$/.test(s)) return s;
  throw new Error(`Not a Figma file URL or key: ${s}`);
}
