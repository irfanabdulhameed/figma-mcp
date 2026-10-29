import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decompress } from 'fzstd';
import { parseSchema, encodeBinarySchema } from 'kiwi-schema';
import {
  zstdCompress, zstdDecompress, isWireSchemaFrame, readWireSchema, decodeFrame,
  encodeSceneQuery, parseFileKey, parseGuid,
} from '../src/lib/view-protocol.js';
import { matchPages } from '../src/lib/view-session.js';
import {
  buildSnapshot, mergeSnapshots, createView, saveSnapshot, findSnapshot, loadSnapshotFile, toHex,
} from '../src/lib/view-snapshot.js';

// --- wire format --------------------------------------------------------------

const SCHEMA = `
enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; SCENE_GRAPH_QUERY = 11; SCENE_GRAPH_REPLY = 12; }
struct GUID { uint sessionID; uint localID; }
message SceneGraphQuery { GUID startingNode = 1; uint depth = 2; }
message NodeChange { GUID guid = 1; string name = 2; }
message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; SceneGraphQuery[] sceneGraphQueries = 3; }
`;

const wireFrame = () => {
  const head = Buffer.alloc(12);
  head.write('fig-wire', 0, 'latin1');
  head.writeUInt32LE(1, 8);
  return Buffer.concat([head, zstdCompress(Buffer.from(encodeBinarySchema(parseSchema(SCHEMA))))]);
};

test('parseFileKey reads URLs and bare keys', () => {
  assert.equal(parseFileKey('https://www.figma.com/design/AbCdEf1234567890/Name?node-id=1-2'), 'AbCdEf1234567890');
  assert.equal(parseFileKey('figma.com/file/XyZ0123456789/x'), 'XyZ0123456789');
  assert.equal(parseFileKey('AbCdEf1234567890'), 'AbCdEf1234567890');
  assert.equal(parseFileKey(''), null);
  assert.throws(() => parseFileKey('not a key!'));
  assert.deepEqual(parseGuid('12-34'), { sessionID: 12, localID: 34 });
});

test('raw-block zstd frames decode with fzstd and Node', () => {
  const data = Buffer.alloc(300000, 7); // spans several 128 KB raw blocks
  const frame = zstdCompress(data, { forceRaw: true });
  assert.deepEqual(Buffer.from(decompress(frame)), data);
  if (typeof zlib.zstdDecompressSync === 'function') assert.deepEqual(zlib.zstdDecompressSync(frame), data);
  assert.deepEqual(zstdDecompress(frame), data);
});

test('schema frame → codec; queries encode, replies decode', () => {
  const frame = wireFrame();
  assert.equal(isWireSchemaFrame(frame), true);
  const { version, codec } = readWireSchema(frame);
  assert.equal(version, 1);
  const q = codec.decodeMessage(zstdDecompress(encodeSceneQuery(codec, '0:0', 1)));
  assert.equal(q.type, 'SCENE_GRAPH_QUERY');
  assert.deepEqual(q.sceneGraphQueries[0], { startingNode: { sessionID: 0, localID: 0 }, depth: 1 });
  const reply = zstdCompress(Buffer.from(codec.encodeMessage({ type: 'NODE_CHANGES', nodeChanges: [{ guid: { sessionID: 1, localID: 2 }, name: 'Card' }] })));
  assert.equal(decodeFrame(codec, reply).nodeChanges[0].name, 'Card');
  assert.throws(() => readWireSchema(Buffer.from('not-wire-at-all')));
});

// --- snapshot -------------------------------------------------------------------

const g = (s, l) => ({ sessionID: s, localID: l });
const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const kid = (parent, pos) => ({ parentIndex: { guid: parent, position: pos } });
const solid = (r, gg, b, extra = {}) => ({ type: 'SOLID', color: { r, g: gg, b, a: 1 }, opacity: 1, visible: true, ...extra });
const text = (chars) => ({ textData: { characters: chars } });

// A small file: a page with a frame, a group, a component set (two variants,
// a text property, an icon swap property, a slot), an icon component, a
// colour variable, a text style, and instances that override them.
function fixture() {
  const N = [];
  const add = (n) => { N.push({ phase: 'CREATED', visible: true, opacity: 1, ...n }); };
  add({ guid: g(0, 0), type: 'DOCUMENT', name: 'Document' });
  add({ guid: g(0, 1), type: 'CANVAS', name: 'Screens', ...kid(g(0, 0), '!') });
  add({ guid: g(0, 2), type: 'CANVAS', name: 'Components', ...kid(g(0, 0), '"') });
  add({ guid: g(0, 3), type: 'CANVAS', name: 'Screens archive', ...kid(g(0, 0), '#') });
  add({ guid: g(0, 9), type: 'CANVAS', name: 'Internal Only Canvas', internalOnly: true, ...kid(g(0, 0), '$') });
  // Variable "Brand/Primary" = #3358F2 (default mode), an alias to it, and a text style.
  add({ guid: g(5, 1), type: 'VARIABLE_SET', name: 'Colour', variableSetModes: [{ id: g(5, 9), name: 'Light' }], ...kid(g(0, 9), '!') });
  add({ guid: g(5, 2), type: 'VARIABLE', name: 'Brand/Primary', variableSetID: { guid: g(5, 1) }, variableResolvedType: 'COLOR',
    variableDataValues: { entries: [{ modeID: g(5, 9), variableData: { value: { colorValue: { r: 0.2, g: 0.345, b: 0.949, a: 1 } } } }] }, ...kid(g(0, 9), '"') });
  add({ guid: g(5, 3), type: 'VARIABLE', name: 'Text/Link', variableSetID: { guid: g(5, 1) }, variableResolvedType: 'COLOR',
    variableDataValues: { entries: [{ modeID: g(5, 9), variableData: { value: { alias: { guid: g(5, 2) } } } }] }, ...kid(g(0, 9), '#') });
  add({ guid: g(5, 4), type: 'TEXT', name: 'Label/Large', styleType: 'TEXT', fontName: { family: 'Inter', style: 'Medium' }, fontSize: 18, lineHeight: { value: 24, units: 'PIXELS' }, ...kid(g(0, 9), '$') });

  // Icon components (24×24, vector scales with the instance).
  for (const [l, name, pos] of [[10, 'Icon/star', '!'], [20, 'Icon/heart', '"']]) {
    add({ guid: g(2, l), type: 'SYMBOL', name, size: { x: 24, y: 24 }, transform: at(0, 300 + l), ...kid(g(0, 2), pos) });
    add({ guid: g(2, l + 1), type: 'VECTOR', name: 'Vector', size: { x: 18, y: 18 }, transform: at(3, 3),
      horizontalConstraint: 'SCALE', verticalConstraint: 'SCALE', fillPaints: [solid(0.125, 0.125, 0.125)], ...kid(g(2, l), '!') });
  }

  // Component set "Card" with variants State=Default / State=Active.
  add({ guid: g(3, 1), type: 'FRAME', name: 'Card', isStateGroup: true, size: { x: 600, y: 200 }, transform: at(0, 0),
    componentPropDefs: [
      { id: g(3, 90), name: 'Title', type: 'TEXT', initialValue: { textValue: { characters: 'Title' } } },
      { id: g(3, 91), name: 'Icon', type: 'INSTANCE_SWAP', initialValue: { guidValue: g(2, 10) } },
      { id: g(3, 92), name: 'Body', type: 'SLOT' },
    ], ...kid(g(0, 2), '#') });
  for (const [l, state, fill, pos] of [[10, 'Default', solid(1, 1, 1), '!'], [30, 'Active', solid(0.93, 0.95, 1), '"']]) {
    add({ guid: g(3, l), type: 'SYMBOL', name: `State=${state}`, size: { x: 200, y: 100 }, transform: at(0, 0), fillPaints: [fill],
      componentPropDefs: [{ id: g(3, l + 5), parentPropDefId: g(3, 90) }, { id: g(3, l + 6), parentPropDefId: g(3, 91) }, { id: g(3, l + 7), parentPropDefId: g(3, 92) }],
      ...kid(g(3, 1), pos) });
    add({ guid: g(3, l + 1), type: 'TEXT', name: 'Title', ...text('Title'), fontSize: 12, styleIdForText: { guid: g(5, 4) },
      size: { x: 100, y: 20 }, transform: at(40, 10), fillPaints: [solid(0, 0, 0, { colorVar: { value: { alias: { guid: g(5, 3) } } } })],
      componentPropRefs: [{ defID: g(3, l + 5), componentPropNodeField: 'TEXT_DATA' }], ...kid(g(3, l), '!') });
    // The icon greys its vector where it is placed (an override at its own level).
    add({ guid: g(3, l + 2), type: 'INSTANCE', name: 'Icon/star',
      symbolData: { symbolID: g(2, 10), symbolOverrides: [{ guidPath: { guids: [g(2, 11)] }, fillPaints: [solid(0.5, 0.5, 0.5)] }] },
      size: { x: 16, y: 16 }, transform: at(10, 10), overrideKey: g(9, 1),
      componentPropRefs: [{ defID: g(3, l + 6), componentPropNodeField: 'OVERRIDDEN_SYMBOL_ID' }], ...kid(g(3, l), '"') });
    add({ guid: g(3, l + 3), type: 'FRAME', name: 'Slot', size: { x: 180, y: 40 }, transform: at(10, 50),
      parameterConsumptionMap: { entries: [{ variableData: { value: { propRefValue: { defId: g(3, l + 7) } } }, variableField: 'SLOT_CONTENT_ID' }] },
      ...kid(g(3, l), '#') });
    add({ guid: g(3, l + 4), type: 'ROUNDED_RECTANGLE', name: 'Default body', size: { x: 180, y: 40 }, transform: at(0, 0), ...kid(g(3, l + 3), '!') });
  }

  // Screen: a frame holding a group (children stored relative to it) and three cards.
  add({ guid: g(1, 1), type: 'FRAME', name: 'Home', size: { x: 1440, y: 900 }, transform: at(0, 0), fillPaints: [solid(1, 1, 1)],
    stackMode: 'VERTICAL', stackSpacing: 24, stackHorizontalPadding: 32, stackVerticalPadding: 16, ...kid(g(0, 1), '!') });
  add({ guid: g(1, 2), type: 'FRAME', name: 'Logo group', resizeToFit: true, size: { x: 50, y: 20 }, transform: at(100, 200), ...kid(g(1, 1), '!') });
  add({ guid: g(1, 3), type: 'ELLIPSE', name: 'Dot', size: { x: 10, y: 10 }, transform: at(5, 6), ...kid(g(1, 2), '!') });
  add({ guid: g(1, 9), type: 'FRAME', name: 'Empty group', resizeToFit: true, size: { x: NaN, y: NaN }, transform: at(0, 0), ...kid(g(1, 1), '$') });
  // Card 1: title set by its own property value, icon swapped by property, slot filled.
  add({ guid: g(1, 10), type: 'INSTANCE', name: 'Card', size: { x: 200, y: 100 }, transform: at(0, 300),
    symbolData: { symbolID: g(3, 10), symbolOverrides: [] },
    componentPropAssignments: [
      { defID: g(3, 15), varValue: { value: { textDataValue: { characters: 'Fire safety' } } } },
      { defID: g(3, 16), value: { guidValue: g(2, 20) } },
      { defID: g(3, 17), varValue: { value: { slotContentIdValue: { guid: g(1, 50) } } } },
    ], ...kid(g(1, 1), '"') });
  add({ guid: g(1, 50), type: 'FRAME', name: 'Slot 1', ...kid(g(0, 9), '%') });
  add({ guid: g(1, 51), type: 'TEXT', name: 'Body', ...text('Book a seat'), size: { x: 90, y: 20 }, transform: at(0, 0),
    overrideKey: g(0xffffffff, 0xffffffff), ...kid(g(1, 50), '!') });
  // Card 2: switched to the Active variant by an override, renamed, title overridden directly.
  add({ guid: g(1, 20), type: 'INSTANCE', name: 'Card', size: { x: 200, y: 100 }, transform: at(0, 420),
    symbolData: { symbolID: g(3, 10), symbolOverrides: [
      { guidPath: { guids: [g(3, 11)] }, textData: { characters: 'Overridden' } },
    ] }, ...kid(g(1, 1), '#') });
  // Card 3 lives inside a wrapper component whose override sets the card's icon
  // property (replacing the icon instance, so the icon's own fill override goes).
  add({ guid: g(4, 1), type: 'SYMBOL', name: 'Wrapper', size: { x: 300, y: 120 }, transform: at(0, 600), ...kid(g(0, 2), '$') });
  add({ guid: g(4, 2), type: 'INSTANCE', name: 'Inner card', size: { x: 200, y: 100 }, transform: at(0, 0), visible: false,
    symbolData: { symbolID: g(3, 10), symbolOverrides: [] }, ...kid(g(4, 1), '!') });
  add({ guid: g(1, 30), type: 'INSTANCE', name: 'Wrapper', size: { x: 300, y: 120 }, transform: at(0, 540),
    symbolData: { symbolID: g(4, 1), symbolOverrides: [
      { guidPath: { guids: [g(4, 2)] }, overriddenSymbolID: g(3, 30), name: 'Card (active)',
        componentPropAssignments: [{ defID: g(3, 36), value: { guidValue: g(2, 10) } }] },
    ] }, ...kid(g(1, 1), '%') });
  return N;
}

const snapshot = () => buildSnapshot({
  info: { fileKey: 'KEY123', fileName: 'Test file', access: 'READ_ONLY', canEdit: false },
  nodeChanges: fixture(),
  read: [{ id: '0:1', name: 'Screens' }],
});

test('summaries use plugin-like names, values and coordinates', () => {
  const snap = snapshot();
  const n = snap.nodes;
  assert.equal(n['0:1'].type, 'PAGE');
  assert.equal(n['3:1'].type, 'COMPONENT_SET');
  assert.equal(n['3:10'].type, 'COMPONENT');
  assert.equal(n['1:2'].type, 'GROUP');
  assert.deepEqual([n['1:3'].x, n['1:3'].y], [105, 206], 'group children are frame-relative');
  assert.deepEqual([n['1:9'].width, n['1:9'].height], [0, 0], 'NaN sizes become 0');
  assert.deepEqual(n['1:1'].layout, { mode: 'VERTICAL', gap: 24, padding: [16, 32, 16, 32] });
  assert.deepEqual(n['0:0'].children, ['0:1', '0:2', '0:3', '0:9']);
  assert.equal(n['3:11'].text.size, 18, 'text style wins over the stored copy');
  assert.equal(n['3:11'].text.font, 'Inter Medium');
  assert.equal(n['3:11'].fills[0].color, '#3358F2', 'bound colour resolves through the alias');
  assert.equal(n['3:11'].fills[0].variable, 'Text/Link');
  assert.equal(n['3:13'].type, 'SLOT');
  assert.equal(n['1:51']._key, undefined, 'the "no key" sentinel is ignored');
  assert.deepEqual(snap.variables.map((v) => [v.name, v.values.Light]), [['Brand/Primary', '#3358F2'], ['Text/Link', { alias: 'Brand/Primary' }]]);
  assert.equal(toHex({ r: 1, g: 0, b: 0, a: 0.5 }), '#FF000080');
});

test('instances expand with properties, overrides, swaps and slots', () => {
  const view = createView(snapshot());
  const kids = (id) => view.children(id, { expand: true });

  // Card 1: own property values.
  assert.deepEqual(kids('1:10').map((c) => c.id), ['I1:10;3:11', 'I1:10;9:1', 'I1:10;3:13']);
  assert.equal(view.get('I1:10;3:11').text.characters, 'Fire safety');
  const icon = view.get('I1:10;9:1');
  assert.equal(icon.instance.component, '2:20');
  assert.equal(icon.name, 'Icon/heart', 'a swapped instance takes the new name');
  const vec = kids(icon.id)[0];
  assert.equal(vec.id, 'I1:10;9:1;2:21');
  assert.deepEqual([vec.x, vec.y, vec.width, vec.height], [2, 2, 12, 12], 'SCALE constraints follow the 16 px instance');
  assert.deepEqual(kids('I1:10;3:13').map((c) => [c.id, c.text?.characters]), [['I1:10;3:13;1:51', 'Book a seat']]);

  // Card 2: a direct override; its icon (not swapped) keeps the grey from where it was placed.
  assert.equal(view.get('I1:20;3:11').text.characters, 'Overridden');
  assert.equal(view.get('I1:20;9:1;2:11').fills[0].color, '#808080');

  // Card 3: variant switched and renamed by the outer override, shown although
  // hidden in the wrapper, and its icon replaced (the grey fill override dropped).
  const inner = view.get('I1:30;4:2');
  assert.equal(inner.instance.component, '3:30');
  assert.equal(inner.name, 'Card (active)');
  assert.equal(inner.visible, undefined);
  assert.equal(inner.fills[0].color, '#EDF2FF', 'a variant switch takes the variant\'s fill');
  const innerVec = view.get('I1:30;4:2;9:1;2:11');
  assert.equal(innerVec.fills[0].color, '#202020');

  // Without --expand an instance is a leaf; walk reports hidden subtrees.
  assert.deepEqual(view.children('1:10'), []);
  const seen = [];
  view.walk('1:1', (node, depth) => { seen.push(`${depth}:${node.name}`); }, { expand: false });
  assert.deepEqual(seen, ['0:Home', '1:Logo group', '2:Dot', '1:Card', '1:Card', '1:Empty group', '1:Wrapper'], 'children follow their position keys');
});

test('page selection: ids, exact names, unique name parts', () => {
  const pages = createView(snapshot()).pages();
  assert.deepEqual(matchPages(pages, 'Components').map((p) => p.id), ['0:2']);
  assert.deepEqual(matchPages(pages, '0-1, components').map((p) => p.id), ['0:1', '0:2']);
  assert.deepEqual(matchPages(pages, 'Screens').map((p) => p.id), ['0:1'], 'an exact name wins over a longer one');
  assert.throws(() => matchPages(pages, 'creen'), /matches 2 pages/);
  assert.throws(() => matchPages(pages, 'Nope'), /No page matches/);
});

test('snapshots save, merge and are found by key or name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fread-'));
  const a = snapshot();
  const pathA = saveSnapshot(dir, a);
  assert.match(pathA, /test-file-KEY123\.json$/);
  const b = { ...a, read: [{ id: '0:2', name: 'Components' }], nodes: { extra: { id: 'extra', type: 'FRAME', name: 'x' } } };
  const m = mergeSnapshots(loadSnapshotFile(pathA), b);
  assert.deepEqual(m.read.map((r) => r.id), ['0:1', '0:2']);
  assert.ok(m.nodes['1:1'] && m.nodes.extra);
  assert.equal(mergeSnapshots({ ...a, fileKey: 'OTHER' }, b), b, 'other files are not merged');
  const other = saveSnapshot(dir, { ...a, fileKey: 'ZZZ999', fileName: 'Other' });
  utimesSync(other, new Date(), new Date(Date.now() + 5000));
  assert.equal(findSnapshot(dir), other, 'newest by default');
  assert.equal(findSnapshot(dir, 'KEY123'), pathA);
  assert.equal(findSnapshot(dir, 'Test file'), pathA);
  assert.equal(findSnapshot(dir, 'missing'), null);
});
