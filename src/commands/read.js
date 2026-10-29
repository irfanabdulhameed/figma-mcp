// Command: read — read files you can only view (no edit access needed).
//
// `read pull` downloads a file's layers over a read-only connection opened
// from an open Figma tab and saves a snapshot; `read pages|tree|find|node|
// texts|vars` answer from that snapshot, instance contents included.
// Read-only by design: nothing here can change a file. See docs/READ.md.
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync } from 'fs';
import { program } from '../lib/cli-core.js';
import { parseFileKey } from '../lib/view-protocol.js';
import { pullFile, matchPages } from '../lib/view-session.js';
import {
  buildSnapshot, mergeSnapshots, resolveReadDir, saveSnapshot, findSnapshot, loadSnapshotFile,
  createView, publicNode,
} from '../lib/view-snapshot.js';

const fail = (msg, hint) => {
  console.error(chalk.red(`✗ ${msg}`), hint || '');
  process.exit(1);
};

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

function openSnapshot(options) {
  const dir = resolveReadDir(options.dir);
  const path = findSnapshot(dir, options.from);
  if (!path) fail(options.from ? `No snapshot matches "${options.from}" in ${dir}.` : `No snapshot in ${dir}.`, 'Run `figma-cli read pull <file url>` first.');
  const snap = loadSnapshotFile(path);
  return { snap, path, view: createView(snap) };
}

/** Roots to work on: an id, --page (name or id), or everything that was read. */
function roots(view, snap, nodeId, pageSel) {
  if (nodeId) {
    const n = view.get(String(nodeId).replace(/^(\d+)-(\d+)$/, '$1:$2'));
    if (!n) fail(`No node ${nodeId} in this snapshot.`, 'Read it with `figma-cli read pull --node <id>` or check `read tree`.');
    return [n];
  }
  if (pageSel) {
    // Only pages that were read can be the target, so a name part is
    // matched among those first.
    const readPages = view.pages().filter((p) => snap.read.some((r) => r.id === p.id));
    try {
      return matchPages(readPages, pageSel);
    } catch (e) {
      try {
        const [p] = matchPages(view.pages(), pageSel);
        fail(`Page "${p.name}" was not read yet.`, `Run \`figma-cli read pull --page "${p.id}"\`.`);
      } catch { /* not a page of this file either */ }
      fail(e.message);
    }
  }
  return view.readRoots();
}

const dims = (n) => (n.width != null ? `${n.width}×${n.height}` : '');

function describe(n) {
  const parts = [chalk.cyan(n.type), n.name ? chalk.white(n.name) : chalk.gray('(unnamed)'), chalk.gray(n.id)];
  if (n.instance) parts.push(chalk.magenta(`→ ${n.instance.componentName || n.instance.component}`));
  if (n.text) parts.push(chalk.yellow(JSON.stringify(n.text.characters.length > 60 ? `${n.text.characters.slice(0, 57)}…` : n.text.characters)));
  const d = dims(n);
  if (d && n.type !== 'TEXT') parts.push(chalk.gray(d));
  return parts.join('  ');
}

const read = program
  .command('read')
  .description('Read files you can only view: pull a snapshot, then query it (see docs/READ.md)');

read
  .command('pull [file]')
  .description('Download a file\'s layers (read-only) and save a snapshot. [file] = Figma URL or key; default: the open file')
  .option('--page <names>', 'Only these pages (names or ids, comma-separated)')
  .option('--node <id>', 'Only this node and everything under it')
  .option('--internal', 'Include Figma\'s internal-only page')
  .option('--tab <title>', 'Figma tab that hosts the connection (default: $FIGMA_CLI_TARGET or the first open file)')
  .option('--dir <path>', 'Snapshot folder (default: $FIGMA_CLI_READ_DIR or ./figma-read)')
  .option('--timeout <seconds>', 'Give up when Figma is silent this long', '180')
  .option('--no-merge', 'Replace an earlier snapshot of this file instead of adding to it')
  .option('--raw <path>', 'Also save every decoded field to this JSON file (large)')
  .action(async (file, options) => {
    let fileKey = null;
    try { fileKey = parseFileKey(file); } catch (e) { fail(e.message); }
    const spinner = ora('Connecting read-only…').start();
    let result;
    try {
      result = await pullFile({
        fileKey,
        tab: options.tab,
        pages: options.page,
        node: options.node,
        includeInternal: !!options.internal,
        timeoutMs: Math.max(5, Number(options.timeout) || 180) * 1000,
        onStep: ({ index, total, name, id }) => { spinner.text = `Reading ${name ? `page "${name}"` : `node ${id}`} (${index + 1}/${total})…`; },
        onProgress: ({ bytes }) => { if (bytes > 2e6) spinner.suffixText = chalk.gray(mb(bytes)); },
      });
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
    if (options.raw) {
      writeFileSync(options.raw, JSON.stringify(result.nodeChanges, (k, v) => (
        v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? String(v) : v)));
    }
    let snap = buildSnapshot(result);
    const dir = resolveReadDir(options.dir);
    let merged = false;
    if (options.merge !== false && (options.page || options.node)) {
      const earlier = findSnapshot(dir, snap.fileKey);
      if (earlier) {
        const older = loadSnapshotFile(earlier);
        if (older.fileKey === snap.fileKey) { snap = mergeSnapshots(older, snap); merged = true; }
      }
    }
    const path = saveSnapshot(dir, snap);
    let layers = 0;
    const view = createView(snap);
    for (const r of result.read) view.walk(r.id, () => { layers++; return true; });
    spinner.succeed(`Read "${snap.fileName || snap.fileKey}"${result.info.canEdit === false ? ' (view only)' : ''}: ${result.read.length} ${options.node ? 'node' : result.read.length === 1 ? 'page' : 'pages'}, ${layers} layers, ${mb(result.info.bytes)} received`);
    console.log(chalk.gray(`  ${merged ? 'Added to' : 'Saved'} ${path}`));
    console.log(chalk.gray(`  ${snap.variables.length} variables, ${snap.styles.length} styles. Next: figma-cli read tree | find <name> | texts`));
  });

read
  .command('pages')
  .description('List the pages in the snapshot and which were read')
  .option('--from <snapshot>', 'Snapshot path, file key or name (default: newest)')
  .option('--dir <path>', 'Snapshot folder')
  .option('--json', 'JSON output')
  .action((options) => {
    const { snap, view } = openSnapshot(options);
    const counts = {};
    for (const n of Object.values(snap.nodes)) if (n.page) counts[n.page] = (counts[n.page] || 0) + 1;
    const rows = view.pages().map((p) => ({ id: p.id, name: p.name, read: snap.read.some((r) => r.id === p.id), layers: counts[p.id] || 0 }));
    if (options.json) return console.log(JSON.stringify({ file: snap.fileName, fileKey: snap.fileKey, capturedAt: snap.capturedAt, pages: rows }, null, 2));
    console.log(chalk.bold(`${snap.fileName || snap.fileKey}`), chalk.gray(`(read ${snap.capturedAt.slice(0, 16).replace('T', ' ')})`));
    for (const r of rows) console.log(`  ${r.read ? chalk.green('●') : chalk.gray('○')} ${r.name}  ${chalk.gray(r.id)}${r.read ? chalk.gray(`  ${r.layers} layers`) : ''}`);
  });

read
  .command('tree [id]')
  .description('Outline of a node, page, or everything read')
  .option('--page <names>', 'Pages (names or ids, comma-separated)')
  .option('-d, --depth <n>', 'Levels to show', '3')
  .option('--expand', 'Show what is inside instances')
  .option('--hidden', 'Include hidden layers')
  .option('--from <snapshot>', 'Snapshot path, file key or name (default: newest)')
  .option('--dir <path>', 'Snapshot folder')
  .option('--json', 'JSON output (nested)')
  .action((id, options) => {
    const { snap, view } = openSnapshot(options);
    const maxDepth = Math.max(0, Number(options.depth) || 3);
    const expand = !!options.expand;
    for (const root of roots(view, snap, id, options.page)) {
      if (options.json) {
        const build = (n, d) => {
          const out = publicNode(n);
          delete out.children;
          if (d < maxDepth) {
            const kids = view.children(n.id, { expand }).filter((c) => options.hidden || c.visible !== false);
            if (kids.length) out.children = kids.map((c) => build(c, d + 1));
          }
          return out;
        };
        console.log(JSON.stringify(build(root, 0), null, 2));
        continue;
      }
      view.walk(root.id, (n, depth, hidden) => {
        if (hidden && !options.hidden) return false;
        const line = '  '.repeat(depth) + describe(n);
        console.log(n.visible === false ? chalk.dim(`${line}  (hidden)`) : line);
        return true;
      }, { expand, maxDepth });
    }
  });

read
  .command('find <query>')
  .description('Find layers by name (case-insensitive substring)')
  .option('--type <types>', 'Only these types, e.g. TEXT,INSTANCE,COMPONENT')
  .option('--page <names>', 'Pages (names or ids, comma-separated)')
  .option('--expand', 'Also search inside instances')
  .option('--limit <n>', 'Most results to show', '50')
  .option('--from <snapshot>', 'Snapshot path, file key or name (default: newest)')
  .option('--dir <path>', 'Snapshot folder')
  .option('--json', 'JSON output')
  .action((query, options) => {
    const { snap, view } = openSnapshot(options);
    const q = query.toLowerCase();
    const types = options.type ? new Set(options.type.toUpperCase().split(',').map((t) => t.trim())) : null;
    const limit = Number(options.limit) || 50;
    const hits = [];
    for (const root of roots(view, snap, null, options.page)) {
      view.walk(root.id, (n) => {
        if (hits.length >= limit) return false;
        if ((n.name || '').toLowerCase().includes(q) && (!types || types.has(n.type))) hits.push(n);
        return true;
      }, { expand: !!options.expand });
    }
    if (options.json) return console.log(JSON.stringify(hits.map(publicNode), null, 2));
    if (!hits.length) return console.log(chalk.yellow(`Nothing named like "${query}".`) + (options.expand ? '' : chalk.gray(' Try --expand to search inside instances.')));
    for (const n of hits) console.log(describe(n));
    if (hits.length >= limit) console.log(chalk.gray(`… first ${limit}; use --limit to see more.`));
  });

read
  .command('node <id>')
  .description('Everything known about one layer (ids like 12:34 or I12:34;56:78)')
  .option('--from <snapshot>', 'Snapshot path, file key or name (default: newest)')
  .option('--dir <path>', 'Snapshot folder')
  .action((id, options) => {
    const { view } = openSnapshot(options);
    const n = view.get(String(id).replace(/^(\d+)-(\d+)$/, '$1:$2'));
    if (!n) fail(`No node ${id} in this snapshot.`);
    const out = publicNode(n);
    const kids = view.children(n.id, { expand: true });
    if (kids.length) out.children = kids.map((c) => ({ id: c.id, type: c.type, name: c.name }));
    console.log(JSON.stringify(out, null, 2));
  });

read
  .command('texts [id]')
  .description('Every text in a node, page, or everything read, instances included')
  .option('--page <names>', 'Pages (names or ids, comma-separated)')
  .option('--hidden', 'Include hidden text')
  .option('--from <snapshot>', 'Snapshot path, file key or name (default: newest)')
  .option('--dir <path>', 'Snapshot folder')
  .option('--json', 'JSON output')
  .action((id, options) => {
    const { snap, view } = openSnapshot(options);
    const out = [];
    for (const root of roots(view, snap, id, options.page)) {
      view.walk(root.id, (n, depth, hidden) => {
        if (hidden && !options.hidden) return false;
        if (n.text && n.text.characters.trim()) out.push({ id: n.id, name: n.name, text: n.text.characters, font: n.text.font, size: n.text.size });
        return true;
      }, { expand: true });
    }
    if (options.json) return console.log(JSON.stringify(out, null, 2));
    for (const t of out) console.log(`${chalk.gray(t.id)}  ${chalk.cyan(t.name)}: ${t.text.replace(/\n/g, '⏎ ')}`);
    console.log(chalk.gray(`${out.length} texts`));
  });

read
  .command('vars')
  .description('Variables the snapshot saw (local ones and library ones in use)')
  .option('--from <snapshot>', 'Snapshot path, file key or name (default: newest)')
  .option('--dir <path>', 'Snapshot folder')
  .option('--json', 'JSON output')
  .action((options) => {
    const { snap } = openSnapshot(options);
    if (options.json) return console.log(JSON.stringify(snap.variables, null, 2));
    const fmt = (v) => (v && typeof v === 'object' ? `→ ${v.alias}` : String(v));
    const sorted = [...snap.variables].sort((a, b) => `${a.collection}/${a.name}`.localeCompare(`${b.collection}/${b.name}`));
    for (const v of sorted) {
      const values = Object.entries(v.values).map(([m, x]) => `${chalk.gray(m)} ${fmt(x)}`).join('  ');
      console.log(`${chalk.cyan(v.collection || '?')} / ${v.name}  ${chalk.gray(v.type)}  ${values}`);
    }
    console.log(chalk.gray(`${snap.variables.length} variables`));
  });
