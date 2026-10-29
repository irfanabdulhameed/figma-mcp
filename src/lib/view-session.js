// Read-only file access for view-only files: the live session.
//
// The Plugin API (`figma`) is not exposed in files you can only view, so the
// usual eval path can't read them. Figma Desktop still downloads every file
// it shows, over its multiplayer WebSocket. This module opens a second,
// viewer-role socket from inside an open Figma tab (so it is signed in as the
// person at the keyboard, and no cookie or token ever leaves Figma), asks the
// server for pages with read-only scene-graph queries, and hands the decoded
// node changes to view-snapshot.js.
//
// It never reloads Figma, never touches the tab's own connection, and sends
// nothing but queries. The server enforces the person's access: a file they
// can't open can't be read.
import WebSocket from 'ws';
import { getCdpPort } from '../figma-patch.js';
import {
  isWireSchemaFrame, readWireSchema, decodeFrame, encodeSceneQuery, parseFileKey, guidToId,
} from './view-protocol.js';

const HOST_TAB_RE = /figma\.com\/(design|file|slides)\//;
const CHUNK_BYTES = 8 * 1024 * 1024; // per CDP round trip
const PAGE_STATE = '__figmaCliRead';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP connection to one tab. */
class TabConnection {
  constructor(ws) {
    this.ws = ws;
    this.msgId = 0;
    this.callbacks = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && this.callbacks.has(msg.id)) {
        this.callbacks.get(msg.id)(msg);
        this.callbacks.delete(msg.id);
      }
    });
  }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return new TabConnection(ws);
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      this.callbacks.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.error) throw new Error(res.error.message);
    if (res.result?.exceptionDetails) {
      const d = res.result.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'evaluate failed');
    }
    return res.result?.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/**
 * Pick the Figma tab that hosts the socket and the file to read.
 * - fileKey given: prefer that file's own tab, else the --tab / FIGMA_CLI_TARGET
 *   tab, else the first open file (any open file can host a read of another).
 * - no fileKey: the --tab / FIGMA_CLI_TARGET tab (else the first open file),
 *   and read that tab's own file.
 */
export async function pickHostTab({ fileKey = null, tab = null } = {}) {
  const port = getCdpPort();
  let targets;
  try {
    targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
  } catch {
    throw new Error(`Figma Desktop is not reachable on debug port ${port}. Run \`figma-cli connect\` once so Figma starts with it.`);
  }
  const tabs = targets.filter((t) => t.type === 'page' && HOST_TAB_RE.test(t.url || ''));
  if (!tabs.length) throw new Error('No Figma file is open. Open any file in Figma Desktop; it only hosts the connection.');
  const title = tab || process.env.FIGMA_CLI_TARGET || null;
  const byKey = fileKey && tabs.find((t) => t.url.includes(`/${fileKey}/`) || t.url.endsWith(`/${fileKey}`));
  const byTitle = title && tabs.find((t) => t.title.includes(title));
  if (title && !byTitle && !byKey && !fileKey) throw new Error(`No open Figma file matches "${title}".`);
  const host = byKey || byTitle || tabs[0];
  return { host, fileKey: fileKey || parseFileKey(host.url) };
}

// Runs inside the Figma tab. Opens the viewer socket and keeps its frames in a
// queue that take() drains in base64 chunks; send() posts a query.
const bootstrapScript = (fileKey) => `(async () => {
  const mp = window.mpGlobal;
  if (!mp || typeof mp.url !== 'function') return { error: 'This Figma tab has no multiplayer client (open a design file, not the file browser).' };
  const prev = window.${PAGE_STATE};
  if (prev && prev.ws) { try { prev.ws.close(); } catch (e) {} }
  const s = { frames: [], off: 0, closed: null, ws: null };
  window.${PAGE_STATE} = s;
  const toB64 = (b) => { let t = ''; for (let j = 0; j < b.length; j += 0x8000) t += String.fromCharCode.apply(null, b.subarray(j, j + 0x8000)); return btoa(t); };
  s.take = (max) => {
    if (!s.frames.length) return { b64: null, closed: s.closed };
    const f = s.frames[0];
    const end = Math.min(f.length, s.off + max);
    const part = f.subarray(s.off, end);
    let done = false;
    if (end >= f.length) { s.frames.shift(); s.off = 0; done = true; } else { s.off = end; }
    return { b64: toB64(part), done, closed: s.closed };
  };
  s.send = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); s.ws.send(u); return true; };
  const ws = new WebSocket(mp.url({ fileKey: ${JSON.stringify(fileKey)}, role: 'viewer' }));
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) s.frames.push(new Uint8Array(e.data)); };
  ws.onclose = (e) => { s.closed = { code: e.code, reason: e.reason || '' }; };
  await new Promise((res) => { ws.addEventListener('open', res); ws.addEventListener('close', res); setTimeout(res, 15000); });
  let meta = null;
  try {
    const r = await fetch('/api/file_metadata/' + ${JSON.stringify(fileKey)}, { credentials: 'include' });
    const j = await r.json();
    if (j && j.meta) meta = { name: j.meta.name, canEdit: !!j.meta.can_edit };
  } catch (e) {}
  return { open: ws.readyState === 1, closed: s.closed, meta };
})()`;

const cleanupScript = `(() => { const s = window.${PAGE_STATE}; if (s && s.ws) { try { s.ws.close(); } catch (e) {} } delete window.${PAGE_STATE}; return true; })()`;

/**
 * Open a read-only session on a file. Returns { info, query(id, depth), close() }.
 * onProgress({ bytes }) is called as frames arrive.
 */
export async function openViewSession({ fileKey = null, tab = null, timeoutMs = 180000, onProgress = null } = {}) {
  const picked = await pickHostTab({ fileKey, tab });
  const conn = await TabConnection.open(picked.host.webSocketDebuggerUrl);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await conn.evaluate(cleanupScript); } catch { /* tab gone */ }
    conn.close();
  };

  try {
    const boot = await conn.evaluate(bootstrapScript(picked.fileKey));
    if (boot?.error) throw new Error(boot.error);
    if (!boot?.open) {
      throw new Error(`Figma refused the connection${boot?.closed ? ` (code ${boot.closed.code})` : ''}. Check that this account can open the file.`);
    }

    let bytes = 0;
    let codec = null;
    let wireVersion = null;

    const readFrame = async (deadline) => {
      const parts = [];
      for (;;) {
        const r = await conn.evaluate(`window.${PAGE_STATE}.take(${CHUNK_BYTES})`);
        if (r?.b64) {
          const buf = Buffer.from(r.b64, 'base64');
          parts.push(buf);
          bytes += buf.length;
          if (onProgress) onProgress({ bytes });
          if (r.done) return Buffer.concat(parts);
          continue;
        }
        if (r?.closed) throw new Error(`Figma closed the connection (code ${r.closed.code}${r.closed.reason ? `: ${r.closed.reason}` : ''}).`);
        if (Date.now() > deadline) throw new Error('Timed out waiting for Figma. Try a single page with --page, or raise --timeout.');
        await sleep(100);
      }
    };

    const nextMessage = async (deadline) => {
      for (;;) {
        const frame = await readFrame(deadline);
        if (isWireSchemaFrame(frame)) {
          ({ codec, version: wireVersion } = readWireSchema(frame));
          continue;
        }
        if (!codec) throw new Error('Figma sent data before its schema (unexpected protocol change).');
        return decodeFrame(codec, frame);
      }
    };

    // Handshake: schema, JOIN_START (carries the access level), …, JOIN_END.
    let access = null;
    const joinDeadline = Date.now() + Math.min(timeoutMs, 30000);
    for (;;) {
      const m = await nextMessage(joinDeadline);
      if (m.type === 'JOIN_START') access = m.access || null;
      if (m.type === 'JOIN_END') break;
    }

    const query = async (nodeId, depth = 100000) => {
      await conn.evaluate(`window.${PAGE_STATE}.send(${JSON.stringify(encodeSceneQuery(codec, nodeId, depth).toString('base64'))})`);
      const deadline = Date.now() + timeoutMs;
      const changes = [];
      for (;;) {
        const m = await nextMessage(deadline);
        // The server keeps one query's nodes "loaded" at a time: a new query
        // unloads the previous one's with phase REMOVED. Those are unloads,
        // not deletions, so they are skipped.
        if (m.nodeChanges) for (const n of m.nodeChanges) if (n.phase !== 'REMOVED') changes.push(n);
        if (m.type === 'SCENE_GRAPH_REPLY') return changes;
      }
    };

    const info = {
      fileKey: picked.fileKey,
      fileName: boot.meta?.name || null,
      canEdit: boot.meta?.canEdit ?? null,
      access,
      wireVersion,
      hostTab: picked.host.title,
      get bytes() { return bytes; },
    };
    return { info, query, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/**
 * Pick pages by selector ("Home", "12:3", "Home,Settings"): an id, an exact
 * name, or a name part that only one page has. getId/getName adapt it to raw
 * CANVAS nodes or snapshot pages.
 */
export function matchPages(pages, selector, { getId = (p) => p.id, getName = (p) => p.name } = {}) {
  const wanted = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const w of wanted) {
    const lower = w.toLowerCase();
    const name = (p) => (getName(p) || '').trim().toLowerCase();
    let hit = pages.find((p) => getId(p) === w.replace(/^(\d+)-(\d+)$/, '$1:$2'))
      || pages.find((p) => name(p) === lower);
    if (!hit) {
      const partial = pages.filter((p) => name(p).includes(lower));
      if (partial.length > 1) {
        throw new Error(`"${w}" matches ${partial.length} pages: ${partial.map((p) => `"${getName(p).trim()}"`).join(', ')}. Use more of the name or the page id.`);
      }
      [hit] = partial;
    }
    if (!hit) throw new Error(`No page matches "${w}". Pages: ${pages.map((p) => getName(p)).join(', ')}`);
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

const selectPages = (pageNodes, selector) =>
  matchPages(pageNodes, selector, { getId: (p) => guidToId(p.guid), getName: (p) => p.name });

/**
 * Read a file (all pages, chosen pages, or one node) over a read-only session.
 * Returns { info, nodeChanges, pages, read } where read lists what was queried.
 */
export async function pullFile({
  fileKey = null, tab = null, pages = null, node = null, includeInternal = false,
  depth = 100000, timeoutMs = 180000, onProgress = null, onStep = null,
} = {}) {
  const session = await openViewSession({ fileKey, tab, timeoutMs, onProgress });
  try {
    const top = await session.query('0:0', 1);
    const pageNodes = top.filter((n) => n.type === 'CANVAS' && n.phase !== 'REMOVED');
    let targets;
    if (node) {
      targets = [{ id: String(node).replace('-', ':'), name: null }];
    } else {
      const chosen = pages
        ? selectPages(pageNodes, pages)
        : pageNodes.filter((p) => includeInternal || !p.internalOnly && p.name !== 'Internal Only Canvas');
      targets = chosen.map((p) => ({ id: guidToId(p.guid), name: p.name }));
    }
    const nodeChanges = [...top];
    for (let i = 0; i < targets.length; i++) {
      if (onStep) onStep({ index: i, total: targets.length, ...targets[i] });
      const got = await session.query(targets[i].id, depth);
      for (const n of got) nodeChanges.push(n);
    }
    return { info: session.info, nodeChanges, read: targets };
  } finally {
    await session.close();
  }
}
