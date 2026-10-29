// Read-only file access for view-only files: the snapshot.
//
// Turns the node changes a read session collects into a compact snapshot
// (plugin-API-like names: PAGE, COMPONENT, x/y/width/height, fills as hex,
// auto layout, text), saves it, and answers queries on it. Instance contents
// are not sent by the server (they are derived from the main component), so
// createView() rebuilds them from the main component + the instance's
// overrides and component properties, with plugin-style ids
// ("I<instance>;<layer>").
//
// Pure functions only (no CDP, no Figma); tested in tests/view-read.test.js.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { slugify } from './file-memory.js';

export const SNAPSHOT_FORMAT = 'figma-cli-read/1';

const id = (g) => (g ? `${g.sessionID}:${g.localID}` : null);
const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
const NON_LAYER = new Set(['VARIABLE', 'VARIABLE_SET', 'VARIABLE_OVERRIDE', 'BRUSH', 'MANAGED_STRING', 'ANIMATION_PRESET_INSTANCE']);
const TYPE_NAMES = { DOCUMENT: 'DOCUMENT', CANVAS: 'PAGE', ROUNDED_RECTANGLE: 'RECTANGLE', REGULAR_POLYGON: 'POLYGON', SYMBOL: 'COMPONENT' };

const hexByte = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
export function toHex(c) {
  if (!c) return null;
  const base = `#${hexByte(c.r)}${hexByte(c.g)}${hexByte(c.b)}`.toUpperCase();
  return c.a != null && c.a < 1 ? base + hexByte(c.a).toUpperCase() : base;
}

const bytesHex = (b) => (b ? Buffer.from(b).toString('hex') : null);

/** Merge raw node changes by id (later changes win; REMOVED deletes). */
export function mergeNodeChanges(changes) {
  const map = new Map();
  for (const n of changes) {
    const k = id(n.guid);
    if (!k) continue;
    if (n.phase === 'REMOVED') { map.delete(k); continue; }
    map.set(k, map.has(k) ? Object.assign(map.get(k), n) : { ...n });
  }
  return map;
}

// Variable references are { guid } inside the file or { assetRef: { key } }
// for library variables.
const aliasKey = (a) => (a?.guid ? id(a.guid) : a?.assetRef?.key ? `key:${a.assetRef.key}` : null);

function summarizePaint(p, ctx) {
  const out = { type: p.type };
  const alias = aliasKey(p.colorVar?.value?.alias);
  // A paint bound to a variable stores the colour it had when bound; the
  // variable's current value is what Figma shows.
  const bound = alias ? ctx.resolveVar(alias) : null;
  if (p.type === 'SOLID' && (bound && typeof bound === 'object' ? bound : p.color)) {
    out.color = toHex(bound && typeof bound === 'object' ? bound : p.color);
  }
  if (p.opacity != null && p.opacity !== 1) out.opacity = round(p.opacity);
  if (p.visible === false) out.visible = false;
  if (p.blendMode && p.blendMode !== 'NORMAL') out.blendMode = p.blendMode;
  if (p.stops) out.stops = p.stops.map((s) => ({ color: toHex(s.color), position: round(s.position) }));
  if (p.image?.hash) out.image = bytesHex(p.image.hash);
  if (p.imageScaleMode) out.scaleMode = p.imageScaleMode;
  if (alias) out.variable = ctx.varName(alias) || alias;
  return out;
}

function summarizeEffect(e) {
  const out = { type: e.type };
  if (e.visible === false) out.visible = false;
  if (e.radius != null) out.radius = round(e.radius);
  if (e.color) out.color = toHex(e.color);
  if (e.offset) out.offset = { x: round(e.offset.x), y: round(e.offset.y) };
  if (e.spread) out.spread = round(e.spread);
  return out;
}

function lineHeight(lh) {
  if (!lh) return undefined;
  if (lh.units === 'PIXELS') return `${round(lh.value)}px`;
  if (lh.units === 'PERCENT') return `${round(lh.value)}%`;
  return `x${round(lh.value)}`;
}

/** A component property value; newer files keep it only in varValue. */
function propValue(v, varValue) {
  if (v) {
    if (v.boolValue != null) return v.boolValue;
    if (v.textValue) return v.textValue.characters ?? '';
    if (v.guidValue) return id(v.guidValue);
    if (v.floatValue != null) return v.floatValue;
  }
  const x = varValue?.value;
  if (x) {
    if (x.textDataValue) return x.textDataValue.characters ?? '';
    if (x.symbolIdValue?.guid) return id(x.symbolIdValue.guid);
    if (x.slotContentIdValue?.guid) return id(x.slotContentIdValue.guid);
    if (x.boolValue != null) return x.boolValue;
    if (x.floatValue != null) return x.floatValue;
    if (x.textValue != null) return x.textValue;
  }
  return null;
}

const pathOf = (gp) => (gp?.guids || []).map(id).join('/');

function summarizeOverride(o, ctx) {
  const out = { path: pathOf(o.guidPath) };
  if (o.name != null) out.name = o.name;
  if (o.textData?.characters != null) out.text = o.textData.characters;
  if (o.visible != null) out.visible = o.visible;
  if (o.opacity != null) out.opacity = round(o.opacity);
  if (o.fillPaints) out.fills = o.fillPaints.map((p) => summarizePaint(p, ctx));
  if (o.overriddenSymbolID) out.swap = id(o.overriddenSymbolID);
  if (o.componentPropAssignments) out.props = assignments(o.componentPropAssignments, ctx);
  if (o.size) { out.width = round(o.size.x); out.height = round(o.size.y); }
  return out;
}

// Variants carry their own copy of each property id, linked to the set's
// property by parentPropDefId; keys are normalised to that root so a value
// set on one variant still applies after a variant switch.
const assignments = (list, ctx) =>
  Object.fromEntries(list.filter((a) => a.defID).map((a) => [ctx.def(id(a.defID)), propValue(a.value, a.varValue)]));

const CONSTRAINTS = { MIN: 'MIN', FIXED_MIN: 'MIN', MAX: 'MAX', FIXED_MAX: 'MAX', CENTER: 'CENTER', STRETCH: 'STRETCH', SCALE: 'SCALE' };

/** Variable bindings on a node's typography fields, resolved. */
function boundTypography(n, ctx) {
  const out = {};
  for (const e of n.variableConsumptionMap?.entries || []) {
    const val = e.variableData?.value;
    const a = aliasKey(val?.alias || val?.fontStyleValue?.asString?.value?.alias);
    const r = a ? ctx.resolveVar(a) : null;
    if (r == null) continue;
    if (e.variableField === 'FONT_SIZE' && typeof r === 'number') out.size = r;
    else if (e.variableField === 'FONT_FAMILY' && typeof r === 'string') out.family = r;
    else if (e.variableField === 'FONT_STYLE' && typeof r === 'string') out.style = r;
    else if (e.variableField === 'LINE_HEIGHT' && typeof r === 'number') out.lineHeight = { value: r, units: 'PIXELS' };
    else if (e.variableField === 'LETTER_SPACING' && typeof r === 'number') out.letterSpacing = { value: r, units: 'PIXELS' };
  }
  return out;
}

/** Typography of a text layer or text style (stored values, then its bindings). */
function typography(n, ctx) {
  const t = {};
  if (n.fontName) { t.family = n.fontName.family; t.style = n.fontName.style; }
  if (n.fontSize != null) t.size = n.fontSize;
  if (n.lineHeight) t.lineHeight = n.lineHeight;
  if (n.letterSpacing) t.letterSpacing = n.letterSpacing;
  return { ...t, ...boundTypography(n, ctx) };
}

/** One raw node change → compact summary. */
export function summarizeNode(n, ctx) {
  const type = n.isStateGroup ? 'COMPONENT_SET'
    : n.type === 'FRAME' && n.resizeToFit ? 'GROUP'
      : TYPE_NAMES[n.type] || n.type;
  const s = { id: id(n.guid), type, name: n.name ?? '' };
  if (n.parentIndex) s.parent = id(n.parentIndex.guid);
  if (n.visible === false) s.visible = false;
  if (n.opacity != null && n.opacity !== 1) s.opacity = round(n.opacity);
  if (n.transform && type !== 'PAGE' && type !== 'DOCUMENT') {
    s.x = round(n.transform.m02);
    s.y = round(n.transform.m12);
    const rot = Math.atan2(-n.transform.m10, n.transform.m00) * 180 / Math.PI;
    if (Math.abs(rot) > 0.01) s.rotation = round(rot);
  }
  // Empty groups come with no size (or NaN); Figma reports 0.
  const dim = (v) => (Number.isFinite(v) ? round(v) : 0);
  if (n.size) { s.width = dim(n.size.x); s.height = dim(n.size.y); } else if (type !== 'PAGE' && type !== 'DOCUMENT') { s.width = 0; s.height = 0; }
  if (n.fillPaints?.length) s.fills = n.fillPaints.map((p) => summarizePaint(p, ctx));
  if (n.strokePaints?.length) {
    s.strokes = n.strokePaints.map((p) => summarizePaint(p, ctx));
    if (n.strokeWeight != null) s.strokeWeight = round(n.strokeWeight);
    if (n.strokeAlign) s.strokeAlign = n.strokeAlign;
  }
  if (n.backgroundPaints?.length && type === 'PAGE') s.background = n.backgroundPaints.map((p) => summarizePaint(p, ctx));
  if (n.rectangleCornerRadiiIndependent) {
    s.radii = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius,
      n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius].map((v) => round(v || 0));
  } else if (n.cornerRadius) s.cornerRadius = round(n.cornerRadius);
  if (n.effects?.length) s.effects = n.effects.map(summarizeEffect);
  const style = (ref) => ctx.styleName(id(ref?.guid));
  if (n.styleIdForFill?.guid) {
    s.fillStyle = style(n.styleIdForFill) || id(n.styleIdForFill.guid);
    // A fill style's current paints win over the copy stored on the layer.
    const fs = ctx.styleNode(id(n.styleIdForFill.guid));
    if (fs?.fillPaints?.length) s.fills = fs.fillPaints.map((p) => summarizePaint(p, ctx));
  }
  if (n.styleIdForEffect?.guid) s.effectStyle = style(n.styleIdForEffect) || id(n.styleIdForEffect.guid);

  if (n.stackMode && n.stackMode !== 'NONE') {
    const left = n.stackHorizontalPadding ?? n.stackPadding ?? 0;
    const top = n.stackVerticalPadding ?? n.stackPadding ?? 0;
    s.layout = {
      mode: n.stackMode,
      gap: round(n.stackSpacing || 0),
      padding: [top, n.stackPaddingRight ?? left, n.stackPaddingBottom ?? top, left].map(round),
    };
    if (n.stackWrap === 'WRAP') { s.layout.wrap = true; s.layout.counterGap = round(n.stackCounterSpacing || 0); }
    if (n.stackPrimarySizing) s.layout.primarySizing = n.stackPrimarySizing === 'FIXED' ? 'FIXED' : 'HUG';
    if (n.stackCounterSizing) s.layout.counterSizing = n.stackCounterSizing === 'FIXED' ? 'FIXED' : 'HUG';
    if (n.stackPrimaryAlignItems) s.layout.justify = n.stackPrimaryAlignItems;
    if (n.stackCounterAlignItems) s.layout.align = n.stackCounterAlignItems;
  }
  const h = CONSTRAINTS[n.horizontalConstraint] || 'MIN';
  const v = CONSTRAINTS[n.verticalConstraint] || 'MIN';
  if (h !== 'MIN' || v !== 'MIN') s.constraints = { horizontal: h, vertical: v };
  if (n.stackChildPrimaryGrow) s.grow = n.stackChildPrimaryGrow;
  if (n.stackChildAlignSelf === 'STRETCH') s.stretch = true;
  if (n.stackPositioning === 'ABSOLUTE') s.absolute = true;

  if (n.type === 'TEXT') {
    s.text = { characters: n.textData?.characters ?? '' };
    // Typography comes from the text style when there is one (the layer
    // keeps an older copy), then from variables bound on the layer itself.
    const ts = n.styleIdForText?.guid ? ctx.styleNode(id(n.styleIdForText.guid)) : null;
    const typo = { ...typography(n, ctx), ...(ts ? typography(ts, ctx) : {}) };
    const own = boundTypography(n, ctx);
    Object.assign(typo, own);
    if (typo.family) s.text.font = `${typo.family} ${typo.style || ''}`.trim();
    if (typo.size != null) s.text.size = round(typo.size);
    const lh = lineHeight(typo.lineHeight);
    if (lh) s.text.lineHeight = lh;
    if (typo.letterSpacing?.value) s.text.letterSpacing = `${round(typo.letterSpacing.value)}${typo.letterSpacing.units === 'PERCENT' ? '%' : 'px'}`;
    if (n.textAlignHorizontal && n.textAlignHorizontal !== 'LEFT') s.text.align = n.textAlignHorizontal;
    if (n.styleIdForText?.guid) s.text.style = style(n.styleIdForText) || id(n.styleIdForText.guid);
  }

  if (n.type === 'SYMBOL') {
    s.component = {};
    if (n.componentKey) s.component.key = n.componentKey;
    if (n.symbolDescription || n.description) s.component.description = n.symbolDescription || n.description;
  }
  if (s.component || type === 'COMPONENT_SET') {
    const defs = (n.componentPropDefs || []).filter((d) => !d.isDeleted && d.name && !d.parentPropDefId);
    if (defs.length) {
      s.component = s.component || {};
      s.component.props = defs.map((d) => ({
        id: id(d.id), name: d.name, type: d.type, default: propValue(d.initialValue, d.varValue),
      }));
    }
  }

  if (n.type === 'INSTANCE' && n.symbolData) {
    s.instance = { component: id(n.symbolData.symbolID) };
    if (n.symbolData.symbolOverrides?.length) s._ov = n.symbolData.symbolOverrides.map((o) => summarizeOverride(o, ctx));
    if (n.componentPropAssignments?.length) s._props = assignments(n.componentPropAssignments, ctx);
    if (n.derivedSymbolData?.length) {
      const d = {};
      for (const x of n.derivedSymbolData) {
        const e = {};
        const size = x.size || x.derivedTextData?.layoutSize;
        if (size) { e.width = round(size.x); e.height = round(size.y); }
        if (x.transform) { e.x = round(x.transform.m02); e.y = round(x.transform.m12); }
        if (Object.keys(e).length) d[pathOf(x.guidPath)] = e;
      }
      if (Object.keys(d).length) s._derived = d;
    }
  }
  // Component property bindings: older files use componentPropRefs, newer
  // ones parameterConsumptionMap entries holding a propRefValue.
  const refs = (n.componentPropRefs || []).filter((r) => !r.isDeleted && r.defID)
    .map((r) => ({ def: id(r.defID), field: r.componentPropNodeField }));
  for (const e of n.parameterConsumptionMap?.entries || []) {
    const def = e.variableData?.value?.propRefValue?.defId;
    if (def && e.variableField) refs.push({ def: id(def), field: e.variableField });
  }
  if (refs.length) s._refs = refs.map((r) => ({ ...r, def: ctx.def(r.def) }));
  if (s.type === 'FRAME' && refs.some((r) => r.field === 'SLOT_CONTENT_ID')) s.type = 'SLOT';
  // 0xFFFFFFFF:0xFFFFFFFF marks "no override key".
  if (n.overrideKey && n.overrideKey.sessionID !== 0xffffffff) s._key = id(n.overrideKey);
  return s;
}

function variableValue(data, varName) {
  const v = data?.value;
  if (!v) return null;
  const a = aliasKey(v.alias);
  if (a) return { alias: varName(a) || a };
  if (v.colorValue) return toHex(v.colorValue);
  if (v.floatValue != null) return round(v.floatValue);
  if (v.boolValue != null) return v.boolValue;
  if (v.textValue != null) return v.textValue;
  return null;
}

/**
 * Build a snapshot from a read session's result.
 * { info, nodeChanges, read } → { format, fileKey, fileName, …, nodes, variables, styles }
 */
export function buildSnapshot({ info, nodeChanges, read }) {
  const merged = mergeNodeChanges(nodeChanges);
  const varNodes = [...merged.values()].filter((n) => n.type === 'VARIABLE');
  const setNodes = [...merged.values()].filter((n) => n.type === 'VARIABLE_SET');
  // Variables by id and, for library variables referenced by key, by key.
  const varByRef = new Map();
  for (const v of varNodes) {
    varByRef.set(id(v.guid), v);
    if (v.key) varByRef.set(`key:${v.key}`, v);
  }
  const varNames = new Map([...varByRef].map(([k, v]) => [k, v.name]));
  const setByRef = new Map();
  for (const s of setNodes) {
    setByRef.set(id(s.guid), s);
    if (s.key) setByRef.set(`key:${s.key}`, s);
  }
  const setOfVar = (v) => setByRef.get(aliasKey(v.variableSetID) || '') || setByRef.get(id(v.variableSetID?.guid));
  // Value of a variable in its collection's default (first) mode, aliases
  // followed. Colours come back as {r,g,b,a}, numbers and strings as is.
  const resolveVar = (ref, depth = 0) => {
    const v = varByRef.get(ref);
    if (!v || depth > 20) return null;
    const entries = v.variableDataValues?.entries || [];
    const firstMode = setOfVar(v)?.variableSetModes?.[0]?.id;
    const e = (firstMode && entries.find((x) => id(x.modeID) === id(firstMode))) || entries[0];
    const val = e?.variableData?.value;
    if (!val) return null;
    const a = aliasKey(val.alias);
    if (a) return resolveVar(a, depth + 1);
    if (val.colorValue) return val.colorValue;
    if (val.floatValue != null) return val.floatValue;
    if (val.textValue != null) return val.textValue;
    if (val.boolValue != null) return val.boolValue;
    return null;
  };
  const styleNodes = [...merged.values()].filter((n) => n.styleType && n.styleType !== 'NONE');
  const styleNames = new Map(styleNodes.map((s) => [id(s.guid), s.name]));
  const styleById = new Map(styleNodes.map((s) => [id(s.guid), s]));
  const defParent = new Map();
  for (const n of merged.values()) {
    for (const d of n.componentPropDefs || []) if (d.id && d.parentPropDefId) defParent.set(id(d.id), id(d.parentPropDefId));
  }
  const def = (k) => {
    let cur = k;
    for (let i = 0; i < 20 && defParent.has(cur); i++) cur = defParent.get(cur);
    return cur;
  };
  const ctx = {
    varName: (k) => varNames.get(k), styleName: (k) => styleNames.get(k), styleNode: (k) => styleById.get(k),
    resolveVar, def,
  };

  const nodes = {};
  const kids = new Map();
  for (const n of merged.values()) {
    if (NON_LAYER.has(n.type)) continue;
    const s = summarizeNode(n, ctx);
    nodes[s.id] = s;
    if (n.parentIndex) {
      const p = s.parent;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push([n.parentIndex.position || '', s.id]);
    }
  }
  for (const [p, list] of kids) {
    if (!nodes[p]) continue;
    list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    nodes[p].children = list.map((x) => x[1]);
  }
  // Figma stores a group's children relative to the group; the Plugin API
  // (and everyone reading x/y) uses the nearest frame. Shift them, top-down.
  const GROUPISH = new Set(['GROUP', 'BOOLEAN_OPERATION']);
  const shift = (pid) => {
    const p = nodes[pid];
    for (const cid of p?.children || []) {
      const c = nodes[cid];
      if (!c) continue;
      if (GROUPISH.has(p.type) && c.x != null && p.x != null) { c.x = round(c.x + p.x); c.y = round(c.y + p.y); }
      shift(cid);
    }
  };
  for (const s of Object.values(nodes)) if (!s.parent || !nodes[s.parent]) shift(s.id);

  // Page of every node, so queries can tell read pages from dependencies.
  for (const s of Object.values(nodes)) {
    let p = s;
    let guard = 0;
    while (p && p.type !== 'PAGE' && guard++ < 500) p = nodes[p.parent];
    if (p && p.type === 'PAGE' && s.type !== 'PAGE') s.page = p.id;
  }

  const variables = varNodes.map((v) => {
    const set = setOfVar(v);
    const modes = new Map((set?.variableSetModes || []).map((m) => [id(m.id), m.name]));
    const values = {};
    for (const e of v.variableDataValues?.entries || []) {
      values[modes.get(id(e.modeID)) || id(e.modeID)] = variableValue(e.variableData, ctx.varName);
    }
    const out = { id: id(v.guid), name: v.name, collection: set?.name ?? null, type: v.variableResolvedType, values };
    if (v.sourceLibraryKey) out.library = true;
    return out;
  });
  const styles = styleNodes.map((s) => ({ id: id(s.guid), name: s.name, type: s.styleType }));

  return {
    format: SNAPSHOT_FORMAT,
    fileKey: info.fileKey,
    fileName: info.fileName,
    capturedAt: new Date().toISOString(),
    access: info.access,
    canEdit: info.canEdit,
    read: read.map((r) => ({ id: r.id, name: r.name ?? nodes[r.id]?.name ?? null })),
    nodes,
    variables,
    styles,
  };
}

/** Merge a partial pull (some pages / one node) into an earlier snapshot of the same file. */
export function mergeSnapshots(older, newer) {
  if (!older || older.fileKey !== newer.fileKey) return newer;
  const read = [...older.read.filter((r) => !newer.read.some((n) => n.id === r.id)), ...newer.read];
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  return {
    ...newer,
    read,
    nodes: { ...older.nodes, ...newer.nodes },
    variables: [...byId([...older.variables, ...newer.variables]).values()],
    styles: [...byId([...older.styles, ...newer.styles]).values()],
  };
}

// --- files -----------------------------------------------------------------

/** Snapshot folder: --dir beats FIGMA_CLI_READ_DIR beats ./figma-read. */
export function resolveReadDir(explicit) {
  return resolve(explicit || process.env.FIGMA_CLI_READ_DIR || 'figma-read');
}

export const snapshotFileName = (snap) => `${slugify(snap.fileName || 'file')}-${snap.fileKey}.json`;

export function saveSnapshot(dir, snap) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, snapshotFileName(snap));
  writeFileSync(path, JSON.stringify(snap));
  return path;
}

export function loadSnapshotFile(path) {
  const snap = JSON.parse(readFileSync(path, 'utf8'));
  if (snap.format !== SNAPSHOT_FORMAT) throw new Error(`${path} is not a figma-cli read snapshot`);
  return snap;
}

/**
 * Find a snapshot: a path, or a file key / name matched against the folder;
 * with nothing given, the newest one.
 */
export function findSnapshot(dir, which) {
  if (which && existsSync(which) && statSync(which).isFile()) return resolve(which);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, path: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!which) return files[0]?.path || null;
  const w = String(which).toLowerCase();
  const slug = slugify(which);
  const hit = files.find((x) => x.f.toLowerCase().includes(w)) || files.find((x) => x.f.includes(slug));
  return hit?.path || null;
}

// --- view with instance contents --------------------------------------------

const MAX_INSTANCE_DEPTH = 40;
const SWAP_FIELDS = ['fills', 'strokes', 'strokeWeight', 'strokeAlign', 'cornerRadius', 'radii', 'effects', 'layout', 'opacity', 'fillStyle', 'effectStyle'];

/**
 * A query view over a snapshot. get(id) and children(id) also see the
 * contents of instances, rebuilt from the main component:
 *   - each layer of the main component appears under the instance with id
 *     "I<instance id>;<layer id>" (nested instances add more ";<id>" parts),
 *   - component property values (text, visibility, instance swap) and the
 *     instance's overrides (text, visibility, fills, swap, props) are applied,
 *   - sizes/positions the server derived for the instance are used when sent.
 */
export function createView(snap) {
  const nodes = snap.nodes;
  const virtual = new Map();

  const componentName = (cid) => {
    const c = nodes[cid];
    if (!c) return null;
    const set = nodes[c.parent];
    return set && set.type === 'COMPONENT_SET' ? `${set.name} (${c.name})` : c.name;
  };

  // Build the context an instance hands to the layers of its main component.
  // Values come at two levels: "own" (set where this instance was placed:
  // its overrides and property values) and "outer" (overrides from the
  // instances around it). Outer wins, as in Figma.
  const instanceContext = (inst, parentCtx, key, { replaced = false } = {}) => {
    // One layer can have several override entries (e.g. a swap and a rename).
    const put = (m, p, o) => m.set(p, { ...m.get(p), ...o });
    const ownOv = new Map();
    const outerOv = new Map();
    // A replaced (swapped) instance drops the overrides its old placement had.
    if (!replaced) for (const o of inst._ov || []) put(ownOv, o.path, o);
    const ownProps = new Map(Object.entries(inst._props || {}));
    const outerProps = new Map();
    const pathPrefix = parentCtx ? [...parentCtx.pathPrefix, key] : [];
    if (parentCtx) {
      const pre = `${key}/`;
      for (const [p, o] of parentCtx.ov) if (p.startsWith(pre)) put(outerOv, p.slice(pre.length), o);
      const self = parentCtx.ov.get(key);
      if (self?.props) for (const [k, v] of Object.entries(self.props)) outerProps.set(k, v);
    }
    const ov = new Map(ownOv);
    for (const [p, o] of outerOv) put(ov, p, o);
    const props = new Map([...ownProps, ...outerProps]);
    // Derived sizes are keyed by the full path from the outermost instance;
    // the outer instance's data wins over a nested instance's own.
    const ownDerived = new Map(replaced ? [] : Object.entries(inst._derived || {}));
    const prefixStr = `${pathPrefix.join('/')}/`;
    const derived = (full) => {
      if (!parentCtx) return ownDerived.get(full);
      const outer = parentCtx.derived(full);
      const own = full.startsWith(prefixStr) ? ownDerived.get(full.slice(prefixStr.length)) : undefined;
      return outer && own ? { ...own, ...outer } : outer || own;
    };
    return {
      chain: parentCtx ? [...parentCtx.chain, key] : [inst.id],
      ov, ownOv, outerOv, props, ownProps, outerProps, derived, pathPrefix, depth: parentCtx ? parentCtx.depth + 1 : 0,
    };
  };

  // A resized parent moves and resizes its children by their constraints
  // (auto layout parents excepted: Figma's layout engine decides those).
  const applyConstraints = (v, src, parent, parentSrc) => {
    if (!parent || !parentSrc || parentSrc.layout && !src.absolute) return;
    if (parentSrc.type === 'GROUP' || parentSrc.type === 'BOOLEAN_OPERATION') {
      // Group children follow the group (moved and scaled with it).
      for (const [pos, size] of [['x', 'width'], ['y', 'height']]) {
        if (v[pos] == null || parent[pos] == null || parentSrc[pos] == null) continue;
        const k = parentSrc[size] ? parent[size] / parentSrc[size] : 1;
        v[pos] = round(parent[pos] + (v[pos] - parentSrc[pos]) * k);
        if (v[size] != null) v[size] = round(v[size] * k);
      }
      return;
    }
    const c = src.constraints || { horizontal: 'MIN', vertical: 'MIN' };
    const axis = (mode, pos, size, newP, oldP) => {
      if (v[pos] == null || v[size] == null || !oldP) return;
      const d = newP - oldP;
      if (!d) return;
      if (mode === 'MAX') v[pos] = round(v[pos] + d);
      else if (mode === 'CENTER') v[pos] = round(v[pos] + d / 2);
      else if (mode === 'STRETCH') v[size] = round(v[size] + d);
      else if (mode === 'SCALE') { v[pos] = round(v[pos] * newP / oldP); v[size] = round(v[size] * newP / oldP); }
    };
    axis(c.horizontal, 'x', 'width', parent.width, parentSrc.width);
    axis(c.vertical, 'y', 'height', parent.height, parentSrc.height);
  };

  const makeVirtual = (srcId, ctx, parent, parentSrc) => {
    const src = nodes[srcId];
    if (!src) return null;
    // Figma builds instance-layer ids (and override paths) from a layer's
    // overrideKey when it has one, else from its id.
    const key = src._key || src.id;
    const vid = `I${[...ctx.chain, key].join(';')}`;
    if (virtual.has(vid)) return virtual.get(vid);
    const { children, _ov, _props, _derived, _refs, _key, page, ...base } = src;
    const v = { ...base, id: vid, parent: parent.id, source: src.id, virtual: true };
    if (src.text) v.text = { ...src.text };
    if (src.instance) v.instance = { ...src.instance };
    applyConstraints(v, src, parent, parentSrc);
    let swap = null;
    let swapByProp = false;
    let slotContent = null;
    const applyProps = (props, outer) => {
      for (const r of _refs || []) {
        if (!props.has(r.def)) continue;
        const val = props.get(r.def);
        if (r.field === 'VISIBLE' && typeof val === 'boolean') { if (val) delete v.visible; else v.visible = false; }
        if (r.field === 'TEXT_DATA' && typeof val === 'string' && v.text) v.text.characters = val;
        if (r.field === 'OVERRIDDEN_SYMBOL_ID' && typeof val === 'string') { swap = val; swapByProp = outer; }
        if (r.field === 'SLOT_CONTENT_ID' && typeof val === 'string') slotContent = val;
      }
    };
    const applyOverride = (o) => {
      if (!o) return;
      if (o.name != null) v.name = o.name;
      if (o.text != null && v.text) v.text.characters = o.text;
      if (o.visible === false) v.visible = false;
      if (o.visible === true) delete v.visible;
      if (o.opacity != null) v.opacity = o.opacity;
      if (o.fills) v.fills = o.fills;
      if (o.swap) {
        swap = o.swap;
        swapByProp = false;
        // A layer swapped by an override shows, even when hidden in the
        // component, unless the override hides it again.
        if (o.visible == null) delete v.visible;
      }
      if (o.width != null) { v.width = o.width; v.height = o.height; }
    };
    // Own level first, then the outer level on top.
    applyProps(ctx.ownProps, false);
    applyOverride(ctx.ownOv.get(key));
    applyProps(ctx.outerProps, true);
    applyOverride(ctx.outerOv.get(key));
    const o = ctx.ov.get(key);
    const d = ctx.derived([...ctx.pathPrefix, key].join('/'));
    if (d) {
      const before = { width: v.width, height: v.height };
      Object.assign(v, d);
      // A derived size without a position keeps the layer anchored by its
      // constraint: centred layers stay centred, right/bottom ones stay put.
      if (d.x == null && !(parentSrc?.layout && !src.absolute)) {
        const c = src.constraints || {};
        for (const [pos, size, mode] of [['x', 'width', c.horizontal], ['y', 'height', c.vertical]]) {
          if (v[pos] == null || before[size] == null || d[size] == null) continue;
          if (mode === 'CENTER') v[pos] = round(v[pos] + (before[size] - v[size]) / 2);
          else if (mode === 'MAX') v[pos] = round(v[pos] + before[size] - v[size]);
        }
      }
      // Like stored transforms, derived positions inside a group are relative to it.
      if (d.x != null && (parentSrc?.type === 'GROUP' || parentSrc?.type === 'BOOLEAN_OPERATION') && parent.x != null) {
        v.x = round(d.x + parent.x);
        v.y = round(d.y + parent.y);
      }
    }
    virtual.set(vid, v);

    if (src.type === 'INSTANCE') {
      if (swap && swap !== src.instance.component && o?.name == null) {
        // A swapped instance takes the new component's name (a variant
        // switch inside one set keeps it), unless the layer was renamed.
        const setOf = (cid) => (nodes[nodes[cid]?.parent]?.type === 'COMPONENT_SET' ? nodes[cid].parent : null);
        const newSet = setOf(swap);
        if (nodes[swap] && !(newSet && newSet === setOf(src.instance.component))) v.name = newSet ? nodes[newSet].name : nodes[swap].name;
      }
      if (swap && swap !== src.instance.component && nodes[swap]) {
        // A swapped instance looks like its new component (fills, corners,
        // layout…), except where the instance overrides it.
        const m = nodes[swap];
        for (const f of SWAP_FIELDS) { if (m[f] === undefined) delete v[f]; else v[f] = m[f]; }
        if (o?.fills) v.fills = o.fills;
        if (o?.opacity != null) v.opacity = o.opacity;
      }
      if (swap) v.instance.component = swap;
      v.instance.componentName = componentName(v.instance.component);
      // Figma replaces the instance (dropping the overrides made where it was
      // placed) when an outer override sets its swap property or swaps it to
      // another component; a swap value set where it was placed, or a variant
      // switch inside one set, keeps them.
      const setOf2 = (cid) => (nodes[nodes[cid]?.parent]?.type === 'COMPONENT_SET' ? nodes[cid].parent : cid);
      const replaced = !!swap && (swapByProp || setOf2(swap) !== setOf2(src.instance.component));
      v._ctx = instanceContext({ ...src, source: src.id }, ctx, key, { replaced });
      v._master = v.instance.component;
    } else if (slotContent && nodes[slotContent]) {
      // A slot shows the content the instance put in it: the children of the
      // container its slot property points to, with ids "…;<slot>;<layer>".
      v._ctx = instanceContext({ id: key }, ctx, key);
      v._kids = nodes[slotContent].children || [];
      v._kidsSrc = slotContent;
    } else {
      v._ctx = ctx;
      v._kids = children || [];
    }
    return v;
  };

  const get = (nid) => {
    if (nodes[nid]) {
      const n = nodes[nid];
      if (n.instance && !n.instance.componentName) n.instance.componentName = componentName(n.instance.component);
      return n;
    }
    if (virtual.has(nid)) return virtual.get(nid);
    // Unvisited instance layer: expand its top instance, then look again.
    const m = String(nid).match(/^I([^;]+);/);
    if (m && nodes[m[1]]) {
      const search = (x) => {
        for (const c of children(x, { expand: true })) {
          if (virtual.has(nid)) return;
          // Layers of one instance share its id prefix; nested instances extend it.
          if (nid.startsWith(`${c.id.slice(0, c.id.lastIndexOf(';'))};`)) search(c.id);
        }
      };
      search(m[1]);
      return virtual.get(nid) || null;
    }
    return null;
  };

  /** Children of a node; with expand, instances show their contents. */
  function children(nid, { expand = false } = {}) {
    const n = get(nid);
    if (!n) return [];
    if (n.virtual) {
      if (n.type === 'INSTANCE') {
        if (!expand || n._ctx.depth > MAX_INSTANCE_DEPTH) return [];
        const master = nodes[n._master];
        return (master?.children || []).map((c) => makeVirtual(c, n._ctx, n, master)).filter(Boolean);
      }
      return n._kids.map((c) => makeVirtual(c, n._ctx, n, nodes[n._kidsSrc || n.source])).filter(Boolean);
    }
    if (n.type === 'INSTANCE') {
      if (!expand) return [];
      const master = nodes[n.instance.component];
      if (!master) return [];
      const ctx = instanceContext(n, null, null);
      return (master.children || []).map((c) => makeVirtual(c, ctx, n, master)).filter(Boolean);
    }
    return (n.children || []).map((c) => get(c)).filter(Boolean);
  }

  /** Depth-first walk. fn(node, depth, hidden) → false to skip the subtree. */
  function walk(rootId, fn, { expand = false, maxDepth = Infinity } = {}) {
    const visit = (n, depth, hiddenAbove) => {
      const hidden = hiddenAbove || n.visible === false;
      if (fn(n, depth, hidden) === false || depth >= maxDepth) return;
      for (const c of children(n.id, { expand })) visit(c, depth + 1, hidden);
    };
    const root = get(rootId);
    if (root) visit(root, 0, false);
  }

  const pages = () => (nodes['0:0']?.children || []).map((p) => nodes[p]).filter((p) => p && p.type === 'PAGE');
  const readIds = new Set((snap.read || []).map((r) => r.id));

  /** Roots that were actually read (pages or a single node). */
  const readRoots = () => (snap.read || []).map((r) => nodes[r.id]).filter(Boolean);

  return { get, children, walk, pages, readRoots, readIds, componentName };
}

/** A node as JSON for output: internal fields dropped. */
export function publicNode(n) {
  if (!n) return null;
  const out = {};
  for (const [k, v] of Object.entries(n)) if (!k.startsWith('_')) out[k] = v;
  return out;
}
