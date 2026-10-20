#!/usr/bin/env node
'use strict';
/*
 * thunder-structure: reads the data folder of the Thunder Client extension and reports its STRUCTURE.
 *
 * Read-only. Offline. No dependencies. It never writes inside the folder it reads, and it never prints free text:
 *   - values are described by SHAPE (empty, variable-only, URL-like, token-like, JSON-like, text) and a length bucket;
 *   - only fields on a short allow-list print their values (method, body type, auth type, test type and action,
 *     boolean flags, version, request type, MIME types of Content-Type headers, names of dynamic variables from Thunder's own list);
 *   - names of collections, folders, requests, headers (other than a list of common ones), variables and files are never printed;
 *   - key names ARE printed (that is the point: to find fields the spec does not know), and keys the spec does not know are marked "*new".
 * Read the report before you share it. `--selftest` proves with canary strings that no value reaches the output.
 *
 * Usage:
 *   node thunder-structure.cjs                       show candidate folders (existence only) and this help
 *   node thunder-structure.cjs --auto                use the only candidate folder that exists
 *   node thunder-structure.cjs --root <dir|file>     read this folder (or one JSON file)
 *   options: --out <report.md>  --json <report.json>  --strict  (unknown keys shown as <key-N>)
 *   node thunder-structure.cjs --selftest            build a fixture with canary secrets, check none leaks
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL_VERSION = '1.0';
const EXTENSION_ID = 'rangav.vscode-thunder-client';
const LIMITS = {
  fileBytes: Number(process.env.TC_MAX_FILE_BYTES) || 50 * 1024 * 1024,
  files: 5000,
  depth: 40,
  arrayItems: 5000,
  keysPerPath: 60,
  jsonProbeBytes: 1024 * 1024,
};
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,39}$/;
const ID_KEY = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
const ENUM_VALUE = /^[A-Za-z0-9_.:+\/<>=!-]{1,24}$/;
// Keys the importer spec already knows (any level). Anything else is flagged "*new".
const KNOWN_KEYS = new Set(['_id', 'colId', 'containerId', 'name', 'url', 'method', 'sortNum', 'created', 'modified', 'headers', 'params', 'body', 'auth', 'tests', 'docs', 'reqType', 'preReq', 'postReq', 'cookies', 'settings', 'type', 'raw', 'form', 'files', 'graphql', 'query', 'variables', 'bearer', 'basic', 'username', 'password', 'oauth2', 'isDisabled', 'isPath', 'isFile', 'custom', 'action', 'value', 'colName', 'folders', 'requests', 'options', 'baseUrl', 'envId', 'runOptions', 'runRequests', 'runFilters', 'inlineScripts', 'script', 'skipRequest', 'clearCookies', 'data', 'default', 'global', 'local', 'envFile', 'encrypted', 'client', 'collectionName', 'dateExported', 'version', 'environmentName']);
const KNOWN_FILES = new Set(['thunderclient.json', 'thundercollection.json', 'thunderenvironment.json', 'thunderlocalenvironment.json', 'thunderactivity.json', 'thunderresponses.json']);
const KNOWN_DIRS = new Set(['collections', 'environments', 'files', 'res-files', '_db-backup', '_db-backupv3', 'thunder-tests']);
const KNOWN_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'authorization', 'cache-control', 'connection', 'content-type', 'content-length', 'cookie', 'host', 'origin', 'referer', 'user-agent', 'x-api-key', 'x-requested-with', 'x-auth-token', 'if-none-match', 'if-modified-since', 'pragma', 'api-key', 'proxy-authorization', 'x-csrf-token', 'x-forwarded-for']);
const SYSVARS = new Set(['guid', 'name', 'string', 'number', 'email', 'bool', 'enum', 'date', 'dateISO']);
const STD_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']);

// ---------- small helpers ----------

let STRICT = false;
const ALIASES = new Map();
function keyLabel(k) {
  if (ID_KEY.test(k)) return '<id>';
  if (!SAFE_KEY.test(k)) return '<key>';
  if (STRICT && !KNOWN_KEYS.has(k)) { if (!ALIASES.has(k)) ALIASES.set(k, '<key-' + (ALIASES.size + 1) + '>'); return ALIASES.get(k); }
  return k;
}

class Hist {
  constructor() { this.map = new Map(); }
  inc(label, n = 1) { this.map.set(label, (this.map.get(label) || 0) + n); }
  get size() { return this.map.size; }
  total() { let t = 0; for (const v of this.map.values()) t += v; return t; }
  toObject() { const o = Object.create(null); for (const [k, v] of [...this.map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))) o[k] = v; return o; }
  text() { return this.map.size ? [...this.map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([k, v]) => `${k} ${v}`).join(', ') : 'none'; }
}
const bucket = n => n === 0 ? '0' : n === 1 ? '1' : n <= 5 ? '2-5' : n <= 20 ? '6-20' : n <= 100 ? '21-100' : '>100';
const lenBucket = n => n === 0 ? '0' : n <= 10 ? '1-10' : n <= 50 ? '11-50' : n <= 200 ? '51-200' : n <= 1000 ? '201-1000' : '>1000';
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = v => Array.isArray(v) ? v : [];

function redactPath(p) {
  let out = String(p);
  const home = os.homedir();
  if (home && out.toLowerCase().startsWith(home.toLowerCase())) out = '~' + out.slice(home.length);
  let user = '';
  try { user = os.userInfo().username; } catch { /* no user info */ }
  if (user && user.length > 2) out = out.split(user).join('<user>');
  return out;
}

function shapeOf(s) {
  if (s === '') return 'empty';
  if (/^\{\{[^{}]+\}\}$/.test(s.trim())) return 'var-only';
  if (/^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(s)) return 'jwt-like';
  if (/^https?:\/\//i.test(s)) return 'url-absolute';
  if (/^\d+$/.test(s)) return 'digits';
  if (/^(true|false)$/i.test(s)) return 'bool-text';
  if (s.length <= LIMITS.jsonProbeBytes && /^\s*[\[{]/.test(s)) { try { JSON.parse(s); return 'json-text'; } catch { /* not JSON */ } }
  if (s.includes('{{')) return 'has-var';
  if (/^[A-Za-z0-9+\/=_-]{24,}$/.test(s)) return 'token-like';
  return 'text';
}

function enumPath(p) {
  return /\.(method|reqType|version)$/.test(p) || /\.body\.type$/.test(p) || /\.auth\.type$/.test(p) || /\.tests\[\]\.(type|action)$/.test(p)
    || /\.auth\..*(type|flow|grant|placement|location|addto|algorithm|prefix|scheme|mode)$/i.test(p);
}

// ---------- generic structure inventory ----------

class Inventory {
  constructor(strict) { this.strict = strict; this.stats = new Map(); this.children = new Map(); this.unknownIndex = new Map(); this.sysvars = new Hist(); this.keyAlias = new Map(); }
  stat(p) {
    let s = this.stats.get(p);
    if (!s) { s = { count: 0, types: new Hist(), shapes: new Hist(), enums: new Hist(), lens: new Hist(), strLen: new Hist() }; this.stats.set(p, s); }
    return s;
  }
  keyName(parentPath, key) {
    const k = keyLabel(key);
    let set = this.children.get(parentPath);
    if (!set) { set = new Set(); this.children.set(parentPath, set); }
    if (!set.has(k) && set.size >= LIMITS.keysPerPath) return '<more-keys>';
    set.add(k);
    return k;
  }
  walk(p, v, depth) {
    const st = this.stat(p); st.count++;
    if (v === null) { st.types.inc('null'); return; }
    const t = typeof v;
    if (t === 'string') {
      st.types.inc('string'); st.shapes.inc(shapeOf(v)); st.strLen.inc(lenBucket(v.length));
      if (enumPath(p) && ENUM_VALUE.test(v)) st.enums.inc(v);
      for (const m of v.matchAll(/\{\{#([A-Za-z]+)/g)) this.sysvars.inc(SYSVARS.has(m[1]) ? m[1] : '<other>');
      return;
    }
    if (t === 'number') { st.types.inc('number'); return; }
    if (t === 'boolean') { st.types.inc('boolean'); st.enums.inc(String(v)); return; }
    if (Array.isArray(v)) {
      st.types.inc('array'); st.lens.inc(bucket(v.length));
      if (depth >= LIMITS.depth) return;
      const n = Math.min(v.length, LIMITS.arrayItems);
      for (let i = 0; i < n; i++) this.walk(p + '[]', v[i], depth + 1);
      return;
    }
    if (t === 'object') {
      st.types.inc('object');
      if (depth >= LIMITS.depth) return;
      for (const key of Object.keys(v)) this.walk(p + '.' + this.keyName(p, key), v[key], depth + 1);
    }
  }
}

// ---------- reading the folder ----------

function readTree(root) {
  const found = { jsonFiles: [], layout: { entries: [], unknownFiles: new Hist(), unknownDirs: 0, dirs: Object.create(null) }, skipped: new Hist() };
  let st;
  try { st = fs.lstatSync(root); } catch (e) { throw new Error(`Cannot read ${redactPath(root)}: ${e.code || 'error'}`); }
  if (st.isSymbolicLink()) throw new Error('The root is a symbolic link; pass the real folder.');
  if (st.isFile()) {
    if (st.size > LIMITS.fileBytes) { found.skipped.inc('too-large'); return found; }
    found.jsonFiles.push({ rel: path.basename(root), abs: root, size: st.size, nameClass: classifyName(path.basename(root)), dir: '' });
    return found;
  }
  let count = 0;
  const walk = (dir, rel, depth) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { found.skipped.inc('unreadable-dir'); return; }
    names.sort();
    for (const name of names) {
      if (++count > LIMITS.files) { found.skipped.inc('file-limit'); return; }
      const abs = path.join(dir, name);
      let s;
      try { s = fs.lstatSync(abs); } catch { found.skipped.inc('unreadable'); continue; }
      if (s.isSymbolicLink()) { found.skipped.inc('symlink'); continue; }
      const lower = name.toLowerCase();
      if (s.isDirectory()) {
        if (depth === 0) {
          if (KNOWN_DIRS.has(lower)) found.layout.entries.push({ kind: 'dir', name: lower });
          else found.layout.unknownDirs++;
        }
        if (depth < 3) walk(abs, rel ? rel + '/' + lower : lower, depth + 1);
        continue;
      }
      if (!s.isFile()) { found.skipped.inc('special'); continue; }
      const nameClass = classifyName(name);
      if (depth === 0) {
        if (KNOWN_FILES.has(lower)) found.layout.entries.push({ kind: 'file', name: lower, size: s.size });
        else found.layout.unknownFiles.inc(extOf(name));
      }
      if (!lower.endsWith('.json')) { if (depth > 0) found.layout.dirs[rel] = found.layout.dirs[rel] || new Hist(); if (depth > 0) found.layout.dirs[rel].inc(extOf(name)); continue; }
      if (depth > 0) { found.layout.dirs[rel] = found.layout.dirs[rel] || new Hist(); found.layout.dirs[rel].inc(nameClass); }
      if (nameClass === 'responses' ) { found.skipped.inc('responses-file-size-only'); found.responsesBytes = (found.responsesBytes || 0) + s.size; continue; }
      if (rel.startsWith('res-files') || rel.startsWith('files') || rel.startsWith('_db-backup')) { found.skipped.inc('not-analysed-dir'); continue; }
      if (s.size > LIMITS.fileBytes) { found.skipped.inc('too-large'); continue; }
      found.jsonFiles.push({ rel: rel ? rel + '/' + lower : lower, abs, size: s.size, nameClass, dir: rel });
    }
  };
  walk(root, '', 0);
  return found;
}
function indentOf(text) { const m = /\r?\n( +|\t+)\S/.exec(text); return !m ? 'compact' : m[1][0] === '\t' ? 'tab' : m[1].length + '-space'; }
function extOf(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i).toLowerCase().slice(0, 8) : '(none)'; }
function classifyName(name) {
  const l = name.toLowerCase();
  if (l.startsWith('tc_col')) return 'tc_col*';
  if (l.startsWith('tc_env')) return 'tc_env*';
  if (l === 'thunderclient.json') return 'thunderclient';
  if (l === 'thundercollection.json') return 'thunderCollection';
  if (l === 'thunderenvironment.json') return 'thunderEnvironment';
  if (l === 'thunderlocalenvironment.json') return 'thunderLocalEnvironment';
  if (l === 'thunderactivity.json') return 'activity';
  if (l === 'thunderresponses.json') return 'responses';
  if (l.startsWith('thunder-collection_')) return 'export-collection';
  if (l.startsWith('thunder-environment_')) return 'export-environment';
  return 'other-json';
}

function classifyContent(json) {
  if (Array.isArray(json)) {
    const first = json.find(isObj);
    if (!first) return 'array-empty-or-scalars';
    if ('colName' in first) return 'v3-collections';
    if ('colId' in first && 'url' in first) return 'v3-requests';
    if ('name' in first && 'data' in first) return 'v3-environments';
    return 'array-other';
  }
  if (isObj(json)) {
    if ('collectionName' in json && 'requests' in json) return 'export-collection';
    if ('environmentName' in json && 'variables' in json) return 'export-environment';
    if ('colName' in json && Array.isArray(json.requests)) return 'v4-collection';
    if ('name' in json && Array.isArray(json.data)) return 'v4-environment';
    return 'object-other';
  }
  return 'scalar';
}

// ---------- analysis ----------

function analyze(root, options = {}) {
  STRICT = Boolean(options.strict); ALIASES.clear();
  const tree = readTree(root);
  const inv = new Inventory(Boolean(options.strict));
  const parsed = [];
  const parseErrors = new Hist();
  const contentKinds = new Hist();
  const fileSummaries = [];
  for (const f of tree.jsonFiles) {
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { parseErrors.inc('read-error'); continue; }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    let json;
    try { json = JSON.parse(text); } catch { parseErrors.inc('invalid-json'); continue; }
    const kind = classifyContent(json);
    contentKinds.inc(`${f.nameClass} -> ${kind}`);
    parsed.push({ file: f, json, kind });
    fileSummaries.push({ name: f.nameClass, kind, bytes: f.size, indent: indentOf(text), eol: text.includes('\r\n') ? 'CRLF' : 'LF' });
    const rootLabel = kind;
    if (kind === 'v3-collections' || kind === 'v3-requests' || kind === 'v3-environments') { for (const item of arr(json).slice(0, LIMITS.arrayItems)) inv.walk(rootLabel, item, 0); }
    else inv.walk(rootLabel, json, 0);
  }

  // layout (same rule as the extension and spec section 2.2)
  const colFiles = parsed.filter(p => p.file.nameClass === 'tc_col*' && p.file.dir.endsWith('collections')).length;
  const hasV4 = colFiles > 0;
  const hasV3 = parsed.some(p => p.file.nameClass === 'thunderclient' || p.file.nameClass === 'thunderCollection');
  const layout = hasV4 && hasV3 ? 'v4 and v3 files both present (v4 wins)' : hasV4 ? 'v4' : hasV3 ? 'v3' : parsed.some(p => /^export-/.test(p.kind)) ? 'export file(s)' : 'not recognised';

  // entities
  const collections = []; const envs = []; const looseRequests = []; const v3Cols = [];
  for (const p of parsed) {
    if (p.kind === 'v4-collection' || p.kind === 'export-collection') {
      collections.push({ origin: p.kind, obj: p.json, requests: arr(p.json.requests), folders: arr(p.json.folders), settings: p.json.settings });
    } else if (p.kind === 'v3-collections') {
      for (const c of arr(p.json)) { if (isObj(c)) v3Cols.push(c); }
    } else if (p.kind === 'v3-requests') {
      for (const r of arr(p.json)) { if (isObj(r)) looseRequests.push(r); }
    } else if (p.kind === 'v4-environment' || p.kind === 'export-environment') {
      envs.push(p.json);
    } else if (p.kind === 'v3-environments') {
      for (const e of arr(p.json)) { if (isObj(e)) envs.push(e); }
    }
  }
  for (const c of v3Cols) collections.push({ origin: 'v3-collections', obj: c, requests: looseRequests.filter(r => r && r.colId === c._id), folders: arr(c.folders), settings: c.settings });
  const orphanV3Requests = looseRequests.filter(r => r.colId !== 'history' && !v3Cols.some(c => c._id === r.colId)).length;
  const historyRequests = looseRequests.filter(r => r.colId === 'history').length;

  const S = summarize(collections, envs);
  S.v3 = { requests: looseRequests.length, orphanRequests: orphanV3Requests, historyEntries: historyRequests };

  const layoutOut = {
    entries: tree.layout.entries.map(e => e.kind === 'file' ? `${e.name} (${lenBucketSize(e.size)})` : `${e.name}/`),
    unknownFiles: tree.layout.unknownFiles.toObject(), unknownDirs: tree.layout.unknownDirs,
    subfolders: mergeDirs(tree.layout.dirs),
    responsesFileBytes: tree.responsesBytes ? lenBucketSize(tree.responsesBytes) : undefined,
    skipped: tree.skipped.toObject(),
  };
  const report = {
    tool: { name: 'thunder-structure', version: TOOL_VERSION, node: process.version, platform: process.platform },
    root: redactPath(root), layout, layoutOut, contentKinds: contentKinds.toObject(), parseErrors: parseErrors.toObject(), files: fileSummaries,
    summary: S, sysvars: inv.sysvars.toObject(),
    inventory: [...inv.stats.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, s]) => ({
      path: p, count: s.count, types: s.types.toObject(), shapes: s.shapes.size ? s.shapes.toObject() : undefined, values: s.enums.size ? s.enums.toObject() : undefined, lengths: s.lens.size ? s.lens.toObject() : undefined,
    })),
  };
  return report;
}
const lenBucketSize = n => n < 1024 ? '<1 KiB' : n < 100 * 1024 ? '1-100 KiB' : n < 1024 * 1024 ? '100 KiB-1 MiB' : n < 10 * 1024 * 1024 ? '1-10 MiB' : '>10 MiB';
function mergeDirs(dirs) {
  const merged = new Map();
  for (const [rel, hist] of Object.entries(dirs)) { const label = knownDirLabel(rel); const target = merged.get(label) || new Hist(); for (const [k, v] of hist.map) target.inc(k, v); merged.set(label, target); }
  const out = Object.create(null); for (const [k, v] of merged) out[k] = v.toObject(); return out;
}
const knownDirLabel = rel => rel.split('/').map(seg => KNOWN_DIRS.has(seg) ? seg : '<dir>').join('/');

function summarize(collections, envs) {
  const S = {
    counts: { collections: collections.length, folders: 0, requests: 0, environments: envs.length },
    tree: { maxDepth: 0, orphanFolders: 0, cycles: 0, orphanRequests: 0, colIdMismatch: 0, duplicateIds: 0, duplicateSortNumInContainer: 0, missingSortNum: 0 },
    requests: {
      reqType: new Hist(), method: new Hist(), bodyType: new Hist(), rawKind: new Hist(), docsKind: new Hist(), authType: new Hist(), authKeys: Object.create(null), url: new Hist(), paramVsUrl: new Hist(), disabledParamInUrl: 0, pathParams: new Hist(),
      headerNames: new Hist(), headerState: new Hist(), contentTypeByBody: Object.create(null), mimeByBody: Object.create(null), rawByType: Object.create(null), authorizationScheme: new Hist(), defaultHeaders: new Hist(),
      scripts: { preInline: new Hist(), postInline: new Hist(), preKeys: new Hist(), postKeys: new Hist(), runRequests: new Hist() }, cookiesKeys: new Hist(), settingsKeys: new Hist(), formFileValue: new Hist(), requestKeys: new Hist(),
    },
    tests: { matrix: new Hist(), customShape: Object.create(null), setEnvTarget: new Hist(), setEnvSource: new Hist(), perRequest: new Hist() },
    settings: { collection: { present: 0, headers: new Hist(), authType: new Hist(), baseUrl: new Hist(), tests: new Hist(), preReqKeys: new Hist(), postReqKeys: new Hist(), keys: new Hist() }, folder: { present: 0, headers: new Hist(), authType: new Hist(), baseUrl: new Hist(), tests: new Hist(), preReqKeys: new Hist(), postReqKeys: new Hist(), keys: new Hist() } },
    env: { kind: new Hist(), itemKeys: new Hist(), encrypted: 0, disabled: 0, envFile: 0, variables: new Hist(), duplicateNames: 0, topKeys: new Hist() },
  };
  const settingsSummary = (target, st) => {
    if (!isObj(st) || Object.keys(st).length === 0) return;
    target.present++;
    for (const k of Object.keys(st)) target.keys.inc(keyLabel(k));
    if ('headers' in st) target.headers.inc(bucket(arr(st.headers).length));
    if (isObj(st.auth)) target.authType.inc(typeof st.auth.type === 'string' && ENUM_VALUE.test(st.auth.type) ? st.auth.type : '<absent>');
    const bu = st.options && st.options.baseUrl; if (typeof bu === 'string') target.baseUrl.inc(/^https?:\/\//i.test(bu) ? 'absolute' : bu.startsWith('{{') ? 'var-prefix' : bu === '' ? 'empty' : 'other');
    if ('tests' in st) target.tests.inc(bucket(arr(st.tests).length));
    if (isObj(st.preReq)) for (const k of Object.keys(st.preReq)) target.preReqKeys.inc(keyLabel(k));
    if (isObj(st.postReq)) for (const k of Object.keys(st.postReq)) target.postReqKeys.inc(keyLabel(k));
  };
  for (const c of collections) {
    const folders = c.folders.filter(isObj); S.counts.folders += folders.length;
    settingsSummary(S.settings.collection, c.settings);
    const byId = new Map(); for (const f of folders) { if (byId.has(f._id)) S.tree.duplicateIds++; byId.set(f._id, f); settingsSummary(S.settings.folder, f.settings); }
    const depthOf = f => { let d = 1, cur = f; const seenLocal = new Set(); while (cur && cur.containerId) { if (seenLocal.has(cur._id)) { S.tree.cycles++; return d; } seenLocal.add(cur._id); const parent = byId.get(cur.containerId); if (!parent) { S.tree.orphanFolders++; return d; } d++; cur = parent; } return d; };
    for (const f of folders) S.tree.maxDepth = Math.max(S.tree.maxDepth, depthOf(f));
    const reqs = c.requests.filter(isObj); S.counts.requests += reqs.length;
    const sortSeen = new Map(); const reqIds = new Set();
    for (const f of folders) { const key = 'f|' + (f.containerId || ''); const set = sortSeen.get(key) || new Set(); if (typeof f.sortNum !== 'number') S.tree.missingSortNum++; else if (set.has(f.sortNum)) S.tree.duplicateSortNumInContainer++; else set.add(f.sortNum); sortSeen.set(key, set); }
    for (const r of reqs) {
      if (reqIds.has(r._id)) S.tree.duplicateIds++; reqIds.add(r._id);
      if (r.containerId && !byId.has(r.containerId)) S.tree.orphanRequests++;
      if (c.origin !== 'export-collection' && c.obj._id && r.colId !== c.obj._id) S.tree.colIdMismatch++;
      const key = 'r|' + (r.containerId || ''); const set = sortSeen.get(key) || new Set(); if (typeof r.sortNum !== 'number') S.tree.missingSortNum++; else if (set.has(r.sortNum)) S.tree.duplicateSortNumInContainer++; else set.add(r.sortNum); sortSeen.set(key, set);
      requestSummary(S, r);
    }
  }
  for (const e of envs) {
    const flags = []; if (e.global === true) flags.push('global'); if (e.local === true) flags.push('local'); if (e.default === true) flags.push('default');
    S.env.kind.inc(flags.length ? flags.join('+') : 'plain');
    for (const k of Object.keys(e)) S.env.topKeys.inc(keyLabel(k));
    if (typeof e.envFile === 'string' && e.envFile) S.env.envFile++;
    const items = arr(e.data || e.variables); S.env.variables.inc(bucket(items.length));
    const names = new Set(); let dup = 0;
    for (const it of items) { if (!isObj(it)) continue; for (const k of Object.keys(it)) S.env.itemKeys.inc(keyLabel(k)); if (it.encrypted === true) S.env.encrypted++; if (it.isDisabled === true) S.env.disabled++; if (typeof it.name === 'string') { if (names.has(it.name)) dup++; names.add(it.name); } }
    S.env.duplicateNames += dup;
  }
  return S;
}

function requestSummary(S, r) {
  const R = S.requests;
  for (const k of Object.keys(r)) R.requestKeys.inc(keyLabel(k));
  R.reqType.inc(typeof r.reqType === 'string' && ENUM_VALUE.test(r.reqType) ? r.reqType : (r.reqType === undefined ? '<absent>' : '<other>'));
  const m = typeof r.method === 'string' ? r.method.toUpperCase() : '<none>'; R.method.inc(STD_METHODS.has(m) ? m : (m === '<none>' ? m : '<custom>'));
  const body = isObj(r.body) ? r.body : undefined;
  const bodyType = body ? (typeof body.type === 'string' && ENUM_VALUE.test(body.type) ? body.type : '<absent>') : '<no body>';
  R.bodyType.inc(bodyType);
  if (body) { const rk = body.raw === undefined ? 'absent' : typeof body.raw === 'string' ? 'string' : Array.isArray(body.raw) ? 'array-of-lines' : typeof body.raw; (R.rawByType[bodyType] = R.rawByType[bodyType] || new Hist()).inc(rk); R.rawKind.inc(rk); }
  R.docsKind.inc(r.docs === undefined ? 'absent' : typeof r.docs === 'string' ? 'string' : Array.isArray(r.docs) ? 'array' : typeof r.docs);
  const authType = isObj(r.auth) ? (typeof r.auth.type === 'string' && ENUM_VALUE.test(r.auth.type) ? r.auth.type : '<absent-type>') : '<no auth object>';
  R.authType.inc(authType);
  if (isObj(r.auth)) { const hk = (R.authKeys[authType] = R.authKeys[authType] || new Hist()); for (const k of Object.keys(r.auth)) hk.inc(keyLabel(k)); if (isObj(r.auth.oauth2)) { const ok = (R.authKeys['oauth2.*'] = R.authKeys['oauth2.*'] || new Hist()); for (const k of Object.keys(r.auth.oauth2)) ok.inc(keyLabel(k)); } }
  const url = typeof r.url === 'string' ? r.url : '';
  const low = url.toLowerCase();
  R.url.inc(url === '' ? 'empty' : low.startsWith('http://') || low.startsWith('https://') ? 'absolute' : url.startsWith('{{') ? 'var-prefix' : url.startsWith('/') ? 'path-only' : 'relative-or-host');
  if (url.includes('?')) R.url.inc('has-query'); if (/\/:[A-Za-z_]/.test(url)) R.url.inc('has-:param'); if (url.includes('#')) R.url.inc('has-fragment');
  const params = arr(r.params).filter(isObj);
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const queryNames = new Set(query.split('&').filter(Boolean).map(x => x.split('=')[0]));
  const enabledQuery = params.filter(p => !p.isDisabled && !p.isPath && typeof p.name === 'string');
  if (enabledQuery.length) { const inUrl = enabledQuery.filter(p => queryNames.has(p.name)).length; R.paramVsUrl.inc(inUrl === enabledQuery.length ? 'all-enabled-in-url' : inUrl === 0 ? 'none-in-url' : 'some-in-url'); } else R.paramVsUrl.inc('no-enabled-query-params');
  for (const p of params) if (p.isDisabled && !p.isPath && typeof p.name === 'string' && queryNames.has(p.name)) R.disabledParamInUrl++;
  const pathParams = params.filter(p => p.isPath === true);
  if (pathParams.length) R.pathParams.inc(pathParams.every(p => typeof p.name === 'string' && url.includes(':' + p.name)) ? 'all-named-in-url' : 'some-missing-in-url');
  let ctype;
  for (const h of arr(r.headers).filter(isObj)) {
    const n = typeof h.name === 'string' ? h.name.toLowerCase() : '';
    R.headerNames.inc(KNOWN_HEADERS.has(n) ? n : '<other>'); R.headerState.inc(h.isDisabled ? 'disabled' : 'enabled');
    if (n === 'accept' && h.value === '*/*') R.defaultHeaders.inc(h.isDisabled ? 'Accept */* (disabled)' : 'Accept */* (enabled)');
    if (n === 'user-agent' && typeof h.value === 'string' && /thunderclient/i.test(h.value)) R.defaultHeaders.inc(h.isDisabled ? 'User-Agent thunderclient (disabled)' : 'User-Agent thunderclient (enabled)');
    if (n === 'authorization' && typeof h.value === 'string') { const sch = /^(Bearer|Basic|Digest|OAuth|Token)\b/i.exec(h.value); R.authorizationScheme.inc(sch ? sch[1] : (h.value.startsWith('{{') ? '{{var}}' : '<other>')); }
    if (n === 'content-type' && !h.isDisabled) ctype = typeof h.value === 'string' ? h.value : '';
  }
  if (body && bodyType !== '<no body>') {
    (R.contentTypeByBody[bodyType] = R.contentTypeByBody[bodyType] || new Hist()).inc(ctype === undefined ? 'no Content-Type header' : 'has Content-Type header');
    if (ctype !== undefined) { const mm = /^([A-Za-z]+\/[A-Za-z0-9.+*-]+)/.exec(ctype.trim()); (R.mimeByBody[bodyType] = R.mimeByBody[bodyType] || new Hist()).inc(mm ? mm[1].toLowerCase() : '<non-mime>'); }
    for (const f of arr(body.files).filter(isObj)) { const v = typeof f.value === 'string' ? f.value : ''; R.formFileValue.inc(v === '' ? 'empty' : /^([A-Za-z]:[\\/]|\/)/.test(v) ? 'absolute-path' : v.startsWith('./') || v.startsWith('../') ? 'relative-path' : 'other'); }
  }
  if (isObj(r.preReq)) { for (const k of Object.keys(r.preReq)) R.scripts.preKeys.inc(keyLabel(k)); R.scripts.preInline.inc(bucket(arr(r.preReq.inlineScripts).length)); if ('runRequests' in r.preReq) R.scripts.runRequests.inc(bucket(arr(r.preReq.runRequests).length)); }
  if (isObj(r.postReq)) { for (const k of Object.keys(r.postReq)) R.scripts.postKeys.inc(keyLabel(k)); R.scripts.postInline.inc(bucket(arr(r.postReq.inlineScripts).length)); }
  if (isObj(r.cookies)) for (const k of Object.keys(r.cookies)) R.cookiesKeys.inc(keyLabel(k));
  if (isObj(r.settings)) for (const k of Object.keys(r.settings)) R.settingsKeys.inc(keyLabel(k));
  const tests = arr(r.tests).filter(isObj); S.tests.perRequest.inc(bucket(tests.length));
  for (const t of tests) {
    const ty = typeof t.type === 'string' && ENUM_VALUE.test(t.type) ? t.type : '<other>'; const ac = typeof t.action === 'string' && ENUM_VALUE.test(t.action) ? t.action : '<other>';
    S.tests.matrix.inc(`${ty} | ${ac}`);
    if (ty === 'json-query' || ty === 'custom-header' || ty === 'set-env-var') (S.tests.customShape[ty] = S.tests.customShape[ty] || new Hist()).inc(customShape(t.custom));
    if (ty === 'set-env-var') { S.tests.setEnvSource.inc(customShape(t.custom)); const v = typeof t.value === 'string' ? t.value : ''; S.tests.setEnvTarget.inc(/^\{\{[^{},]+\}\}$/.test(v) ? '{{var}}' : /^\{\{[^{},]+,\s*local\s*\}\}$/.test(v) ? '{{var, local}}' : /^\{\{[^{},]+,\s*global\s*\}\}$/.test(v) ? '{{var, global}}' : '<other>'); }
  }
}
function customShape(c) {
  if (typeof c !== 'string') return '<non-string>';
  if (c === '') return 'empty';
  const f = [];
  if (c.startsWith('json.')) f.push('json.-prefix'); else if (c.startsWith('$')) f.push('$-prefix'); else if (c === 'text') f.push('keyword:text'); else if (c.startsWith('header.')) f.push('header.-prefix'); else if (c.startsWith('cookie.')) f.push('cookie.-prefix'); else if (c === 'null' || c === 'delete') f.push('keyword:' + c); else f.push('other');
  if (/\[\d+\]/.test(c)) f.push('index'); if (/\[\*\]|\.\*/.test(c)) f.push('wildcard'); if (/\[['"]/.test(c)) f.push('quoted-key'); if (c.includes('{{')) f.push('has-var');
  return f.join('+');
}

// ---------- rendering ----------

function plain(v) {
  if (v instanceof Hist) return v.toObject();
  if (Array.isArray(v)) return v.map(plain);
  if (isObj(v)) { const o = Object.create(null); for (const [k, x] of Object.entries(v)) o[k] = plain(x); return o; }
  return v;
}
function fmt(h) { return h instanceof Hist ? h.text() : Object.entries(h || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'; }

function render(report) {
  const S = report.summary; const R = S.requests;
  const out = [];
  const line = s => out.push(s);
  line('# Thunder Client structure report'); line('');
  line(`Tool: thunder-structure ${report.tool.version}, Node ${report.tool.node}, ${report.tool.platform}.`);
  line('This report holds structure only: counts, key names, types, value shapes and a short allow-list of enumerations. It holds no names, URLs, tokens, request bodies or variable values. Check it before sharing.'); line('');
  line('## 1. Layout'); line('');
  line(`- Root: \`${report.root}\``);
  line(`- Detected layout: **${report.layout}** (rule of the extension: v4 if \`collections/\` holds \`tc_col*\` files, else v3).`);
  line(`- Top-level entries (known names only): ${report.layoutOut.entries.join(', ') || 'none'}`);
  line(`- Unknown top-level files by extension: ${fmt(report.layoutOut.unknownFiles)}; unknown top-level folders: ${report.layoutOut.unknownDirs}`);
  for (const [k, v] of Object.entries(report.layoutOut.subfolders)) line(`- Folder \`${k}/\`: ${fmt(v)}`);
  if (report.layoutOut.responsesFileBytes) line(`- thunderResponses.json: size only (${report.layoutOut.responsesFileBytes}); content not read.`);
  line(`- File kinds (name class -> content kind): ${fmt(report.contentKinds)}`);
  line(`- Parse problems: ${fmt(report.parseErrors)}; skipped: ${fmt(report.layoutOut.skipped)}`);
  line(`- JSON style of each file: ${report.files.map(f => `${f.name}: ${f.indent}, ${f.eol}`).join('; ') || 'none'}`); line('');
  line('## 2. Entities and tree'); line('');
  line(`- Collections ${S.counts.collections}, folders ${S.counts.folders}, requests ${S.counts.requests}, environments ${S.counts.environments}`);
  line(`- v3 loose requests ${S.v3.requests}, of which history entries ${S.v3.historyEntries}, without a collection ${S.v3.orphanRequests}`);
  line(`- Max folder depth ${S.tree.maxDepth}; orphan folders ${S.tree.orphanFolders}; cycles ${S.tree.cycles}; requests pointing to a missing folder ${S.tree.orphanRequests}; colId different from the collection ${S.tree.colIdMismatch}; duplicate ids ${S.tree.duplicateIds}; same sortNum in one container ${S.tree.duplicateSortNumInContainer}; missing sortNum ${S.tree.missingSortNum}`); line('');
  line('## 3. Requests'); line('');
  line(`- reqType: ${fmt(R.reqType)}`); line(`- method: ${fmt(R.method)}`); line(`- body.type: ${fmt(R.bodyType)}`);
  line(`- body.raw representation: ${fmt(R.rawKind)} (by body type: ${Object.entries(R.rawByType).map(([k, h]) => `${k} -> ${h.text()}`).join('; ') || 'n/a'})`);
  line(`- docs representation: ${fmt(R.docsKind)}`);
  line(`- auth.type: ${fmt(R.authType)}`);
  for (const [k, h] of Object.entries(R.authKeys)) line(`  - keys of auth (${k}): ${fmt(h)}`);
  line(`- url shape: ${fmt(R.url)}`); line(`- enabled query params vs url: ${fmt(R.paramVsUrl)}; disabled params still present in url: ${R.disabledParamInUrl}; path params: ${fmt(R.pathParams)}`);
  line(`- header names (common ones only): ${fmt(R.headerNames)}; state: ${fmt(R.headerState)}`);
  line(`- Thunder default headers stored: ${fmt(R.defaultHeaders)}`); line(`- Authorization header scheme: ${fmt(R.authorizationScheme)}`);
  for (const [k, h] of Object.entries(R.contentTypeByBody)) line(`- body ${k}: ${h.text()}${R.mimeByBody[k] ? '; MIME ' + R.mimeByBody[k].text() : ''}`);
  line(`- multipart file values: ${fmt(R.formFileValue)}`);
  line(`- preReq keys: ${fmt(R.scripts.preKeys)}; inline scripts: ${fmt(R.scripts.preInline)}; runRequests: ${fmt(R.scripts.runRequests)}; postReq keys: ${fmt(R.scripts.postKeys)}; inline scripts: ${fmt(R.scripts.postInline)}`);
  line(`- cookies keys: ${fmt(R.cookiesKeys)}; request settings keys: ${fmt(R.settingsKeys)}`);
  line(`- all request keys: ${fmt(R.requestKeys)}`);
  line(`- dynamic variables \`{{#...}}\` used: ${fmt(report.sysvars)}`); line('');
  line('## 4. Inherited settings (collection and folder)'); line('');
  for (const lvl of ['collection', 'folder']) { const x = S.settings[lvl]; line(`- ${lvl}: with settings ${x.present}; keys ${fmt(x.keys)}; headers ${fmt(x.headers)}; auth.type ${fmt(x.authType)}; baseUrl ${fmt(x.baseUrl)}; tests ${fmt(x.tests)}; preReq keys ${fmt(x.preReqKeys)}; postReq keys ${fmt(x.postReqKeys)}`); }
  line(''); line('## 5. Tests and captures'); line('');
  line(`- tests per request: ${fmt(S.tests.perRequest)}`); line(`- type | action: ${fmt(S.tests.matrix)}`);
  for (const [k, h] of Object.entries(S.tests.customShape)) line(`- shape of \`custom\` for ${k}: ${fmt(h)}`);
  line(`- set-env-var target form: ${fmt(S.tests.setEnvTarget)}`); line('');
  line('## 6. Environments'); line('');
  line(`- kinds: ${fmt(S.env.kind)}; top-level keys: ${fmt(S.env.topKeys)}`); line(`- variable count per environment: ${fmt(S.env.variables)}; item keys: ${fmt(S.env.itemKeys)}`);
  line(`- encrypted values ${S.env.encrypted}; disabled ${S.env.disabled}; with envFile ${S.env.envFile}; duplicate variable names ${S.env.duplicateNames}`); line('');
  line('## 7. Structure inventory (path, count, types, shapes, allowed values)'); line('');
  const unknown = [];
  for (const row of report.inventory) {
    const last = row.path.split('.').pop().replace(/\[\]$/, '');
    const isNew = row.path.includes('.') && SAFE_KEY.test(last) && !KNOWN_KEYS.has(last);
    if (isNew) unknown.push(row.path);
    const bits = [`${row.count}x`, Object.entries(row.types).map(([k, v]) => `${k} ${v}`).join('/')];
    if (row.shapes) bits.push('shapes: ' + Object.entries(row.shapes).map(([k, v]) => `${k} ${v}`).join(', '));
    if (row.values) bits.push('values: ' + Object.entries(row.values).map(([k, v]) => `${k} ${v}`).join(', '));
    if (row.lengths) bits.push('lengths: ' + Object.entries(row.lengths).map(([k, v]) => `${k} ${v}`).join(', '));
    line(`- \`${row.path}\`${isNew ? ' *new' : ''}: ${bits.join('; ')}`);
  }
  line(''); line('## 8. Keys the spec does not know (*new)'); line('');
  if (unknown.length) for (const p of unknown) line(`- \`${p}\``); else line('- none');
  line('');
  return out.join('\n') + '\n';
}

// ---------- self test ----------

function selfTest() {
  const crypto = require('crypto');
  const tag = 'CNRY' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const c = n => `${tag}_${n}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-structure-selftest-'));
  const write = (rel, data) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); return f; };
  const request = (i, extra = {}) => Object.assign({ _id: `00000000-0000-4000-8000-00000000000${i}`, colId: 'col-1', containerId: i === 2 ? 'fold-1' : '', name: c('req' + i), url: `https://${c('host')}.example.com/${c('path')}?${c('qn')}=${c('qv')}`, method: 'POST', sortNum: i * 10000, created: '2026-01-01T00:00:00.000Z', modified: '2026-01-02T00:00:00.000Z',
    headers: [{ name: c('Header-Name'), value: c('header-value') }, { name: 'Authorization', value: 'Bearer ' + c('bearer-secret') }, { name: 'Accept', value: '*/*' }, { name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    params: [{ name: c('qn'), value: c('qv') }, { name: c('pathname'), value: c('pathval'), isPath: true }],
    body: { type: 'text', raw: [c('body-line-1'), c('body-line-2')], form: [{ name: c('fn'), value: c('fv') }], files: [{ name: c('file'), value: `C:\\Users\\${c('user')}\\secret.pdf` }] },
    auth: { type: 'oauth2', oauth2: { grantType: 'client_credentials', clientSecret: c('client-secret'), accessTokenUrl: `https://${c('tokenhost')}/token`, scope: c('scope') } },
    tests: [{ type: 'json-query', custom: `json.${c('field')}[0]`, action: 'equal', value: c('expected') }, { type: 'set-env-var', custom: `json.${c('tok')}`, action: 'setto', value: `{{${c('varname')}, local}}` }, { type: 'custom-header', custom: c('hdrname'), action: 'contains', value: c('hv') }],
    docs: [c('doc-line')], reqType: 'http', preReq: { inlineScripts: [{ script: [`console.log("${c('script')}")`] }], options: { clearCookies: true } }, postReq: { inlineScripts: [] } }, extra);
  write('collections/tc_col_a.json', { _id: 'col-1', colName: c('collection'), created: '2026-01-01T00:00:00.000Z', sortNum: 10000, folders: [{ _id: 'fold-1', name: c('folder'), containerId: '', sortNum: 10000, created: 'x', settings: { headers: [{ name: c('fh'), value: c('fhv') }], auth: { type: 'bearer', bearer: c('folder-token') }, options: { baseUrl: `https://${c('base')}.example.com` } } }], settings: { options: { baseUrl: '{{baseUrl}}' }, auth: { type: 'inherit' }, tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }], UNKNOWNKEYxyz: 1 }, requests: [request(1), request(2), request(3, { auth: undefined, body: { type: 'json', raw: `{"${c('jsonkey')}":"${c('jsonval')}"}` } }), request(4, { auth: { type: '__proto__', k: 1 }, body: { type: 'constructor', raw: 5 } })] });
  write('environments/tc_env_dev.json', { _id: 'env-1', name: c('env'), default: true, global: false, local: false, sortNum: 10000, created: 'x', modified: 'x', data: [{ name: c('var1'), value: c('val1') }, { name: c('var2'), value: c('enc'), encrypted: true }, { name: c('var1'), value: c('dup') }], envFile: `/home/${c('user')}/.env` });
  write('thunderLocalEnvironment.json', [{ _id: 'l1', name: c('local'), global: true, local: true, data: [{ name: c('lv'), value: c('lval') }] }]);
  write('thunderResponses.json', { [c('resp')]: { body: c('respbody') } });
  write('res-files/' + c('resfile') + '.json', { secret: c('resfile-secret') });
  write('files/' + c('upload') + '.pdf', c('pdf'));
  write('notes-' + c('random') + '.txt', c('text'));
  write('thunderclient.json', [{ _id: 'h1', colId: 'history', name: c('hist'), url: `https://${c('histhost')}`, method: 'GET', sortNum: 1 }]);
  write('thunderCollection.json', [{ _id: 'col-v3', colName: c('v3col'), folders: [], settings: { options: { baseUrl: `https://${c('v3base')}` } } }]);
  write('bad.json', '{ not json ' + c('bad'));
  let linked = true;
  try { fs.symlinkSync(os.tmpdir(), path.join(tmp, 'link-' + c('link')), 'dir'); } catch { linked = false; }
  const protoRoot = path.join(tmp, 'collections');
  fs.writeFileSync(path.join(protoRoot, 'tc_col_proto.json'), `{"_id":"p","colName":"${c('proto')}","__proto__":{"polluted":"${c('pollute')}"},"folders":[],"requests":[],"settings":{"constructor":{"prototype":{"x":"${c('ctor')}"}}}}`);
  const before = JSON.stringify(Object.getPrototypeOf({}));
  const snapshot = () => { const out = []; const walkDir = d => { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n); const st = fs.lstatSync(f); if (st.isDirectory()) walkDir(f); else out.push(`${path.relative(tmp, f)}|${st.size}|${st.mtimeMs}`); } }; walkDir(tmp); return out.join('\n'); };
  const treeBefore = snapshot();

  const failures = [];
  let context = '';
  const expect = (cond, msg) => { if (!cond) failures.push(msg + (context ? ` (${context})` : '')); };
  for (const strict of [false, true]) {
    context = strict ? 'strict' : 'normal';
    const report = analyze(tmp, { strict });
    const text = render(report) + JSON.stringify(plain(report));
    if (text.includes(tag)) { const i = text.indexOf(tag); failures.push(`canary leaked (${context}): ...${text.slice(Math.max(0, i - 30), i + 40)}...`); }
    const S = report.summary;
    expect(S.counts.requests >= 4 && S.counts.folders >= 1, 'counts look wrong');
    expect(S.requests.rawKind.map.get('array-of-lines') >= 2 && S.requests.rawKind.map.get('string') >= 1, 'raw representation not detected');
    expect(S.requests.authType.map.get('oauth2') >= 2, 'oauth2 auth not counted');
    expect(S.requests.authKeys['oauth2.*'] && (strict ? S.requests.authKeys['oauth2.*'].size > 0 && !S.requests.authKeys['oauth2.*'].map.has('grantType') : S.requests.authKeys['oauth2.*'].map.has('grantType')), 'oauth2 keys not listed (or not hidden in strict mode)');
    expect(S.env.encrypted === 1 && S.env.duplicateNames === 1, 'env summary wrong');
    expect(S.settings.collection.baseUrl.map.get('var-prefix') === 1 && S.settings.folder.baseUrl.map.get('absolute') === 1, 'baseUrl shapes wrong');
    expect(report.layout.startsWith('v4'), 'layout should be v4 (with v3 files also present)');
    expect(text.includes('UNKNOWNKEYxyz') === !strict, strict ? 'unknown key should be hidden in strict mode' : 'unknown key should be listed in normal mode');
    expect(!linked || report.layoutOut.skipped.symlink >= 1, 'symlink not skipped');
    expect(report.parseErrors['invalid-json'] === 1, 'invalid JSON not counted');
    expect(S.requests.authType.map.get('__proto__') === 1 && S.requests.bodyType.map.get('constructor') === 1, 'values named like prototype members were not counted');
  }
  context = '';
  expect(JSON.stringify(Object.getPrototypeOf({})) === before && !({}).polluted && !({}).x, 'prototype pollution');
  expect(snapshot() === treeBefore, 'the tool changed the folder it reads');
  // the command line path, with --json and --out (no overwrite)
  const cp = require('child_process');
  const jsonOut = path.join(os.tmpdir(), 'tc-structure-selftest-' + tag + '.json'); const mdOut = path.join(os.tmpdir(), 'tc-structure-selftest-' + tag + '.md');
  const run = cp.spawnSync(process.execPath, [__filename, '--root', tmp, '--json', jsonOut, '--out', mdOut], { encoding: 'utf8' });
  expect(run.status === 0, 'CLI run failed: ' + (run.stderr || '').slice(0, 200));
  const again = cp.spawnSync(process.execPath, [__filename, '--root', tmp, '--out', mdOut], { encoding: 'utf8' });
  expect(again.status !== 0, 'CLI overwrote an existing report');
  try { const written = fs.readFileSync(jsonOut, 'utf8') + fs.readFileSync(mdOut, 'utf8'); expect(!written.includes(tag), 'canary in written files'); JSON.parse(fs.readFileSync(jsonOut, 'utf8')); } catch (e) { failures.push('written report unreadable: ' + e.message); }
  for (const f of [jsonOut, mdOut]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length) { console.error('SELFTEST FAILED:\n- ' + failures.join('\n- ')); process.exit(1); }
  console.log('SELFTEST OK: no canary string reached the report (normal and strict mode, console and files), structure facts detected, symlink skipped, invalid JSON counted, no prototype pollution, the folder was left untouched, existing reports are never overwritten.');
}

// ---------- main ----------

function candidateRoots() {
  const home = os.homedir(); const apps = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Kiro', 'Antigravity'];
  const bases = [];
  if (process.platform === 'win32') { if (process.env.APPDATA) bases.push(process.env.APPDATA); }
  else if (process.platform === 'darwin') bases.push(path.join(home, 'Library', 'Application Support'));
  else bases.push(path.join(home, '.config'));
  const list = [];
  for (const b of bases) for (const a of apps) list.push(path.join(b, a, 'User', 'globalStorage', EXTENSION_ID));
  if (process.platform === 'linux') list.push(path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', EXTENSION_ID));
  return list;
}

const USAGE = [
  'thunder-structure ' + TOOL_VERSION + ': describes the STRUCTURE of the Thunder Client data folder. Read-only, offline, prints no names, URLs, tokens or variable values.',
  '',
  '  node thunder-structure.cjs                       this help and the candidate folders that exist (existence only)',
  '  node thunder-structure.cjs --auto                read the only candidate folder that exists',
  '  node thunder-structure.cjs --root <dir|file>     read this folder, or one JSON file',
  '  options: --out <report.md>  --json <report.json>  (never overwrite an existing file)',
  '           --strict            show keys the spec does not know as <key-N>, not by name',
  '  node thunder-structure.cjs --selftest            fixture with canary secrets; proves none reaches the report',
].join('\n');

function main(argv) {
  const opt = { root: undefined, auto: false, out: undefined, json: undefined, strict: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opt.root = argv[++i]; else if (a === '--auto') opt.auto = true; else if (a === '--out') opt.out = argv[++i]; else if (a === '--json') opt.json = argv[++i];
    else if (a === '--strict') opt.strict = true; else if (a === '--selftest') opt.selftest = true; else if (a === '--help' || a === '-h') { opt.help = true; } else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  if (opt.selftest) return selfTest();
  const cands = candidateRoots().filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  if (!opt.root && !opt.auto) {
    console.log(USAGE);
    console.log('\nCandidate folders that exist on this machine (existence only, nothing was read):');
    if (cands.length) for (const c of cands) console.log('  ' + redactPath(c)); else console.log('  none found; pass --root <folder>');
    return;
  }
  let root = opt.root;
  if (!root) {
    if (cands.length !== 1) { console.error(cands.length ? `--auto needs exactly one candidate, found ${cands.length}; pass --root.` : 'No candidate folder found; pass --root <folder>.'); process.exit(2); }
    root = cands[0];
  }
  let report;
  try { report = analyze(path.resolve(root), { strict: opt.strict }); } catch (e) { console.error(e.message); process.exit(1); }
  const md = render(report);
  if (opt.out) fs.writeFileSync(opt.out, md, { flag: 'wx' });   // never overwrite an existing file
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(plain(report), null, 2) + '\n', { flag: 'wx' });
  if (!opt.out) process.stdout.write(md);
  else console.log(`Report written to ${redactPath(path.resolve(opt.out))}${opt.json ? ' and ' + redactPath(path.resolve(opt.json)) : ''}.`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { analyze, render };
