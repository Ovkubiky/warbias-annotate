/* In-memory stand-ins for the Google Apps Script services Code.js uses, so the
 * backend can be exercised in Node. Only the methods Code.js calls are implemented.
 * `stats.reads` counts sheet reads, to check that caching actually avoids them.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEnv(fixtureDir) {
  const stats = { reads: 0, writes: 0 };
  const store = {};           // spreadsheets by id
  let nextId = 1;

  class Range {
    constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
    getValues() {
      stats.reads++;
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sheet.rows[this.r - 1 + i] || [];
        out.push(Array.from({ length: this.nc }, (_, j) => row[this.c - 1 + j] ?? ''));
      }
      return out;
    }
    getValue() { return this.getValues()[0][0]; }
    setValues(v) {
      stats.writes++;
      v.forEach((row, i) => {
        const R = this.sheet.rows[this.r - 1 + i] || (this.sheet.rows[this.r - 1 + i] = []);
        row.forEach((x, j) => { R[this.c - 1 + j] = x; });
      });
      return this;
    }
    setValue(x) { return this.setValues([[x]]); }
    clearContent() { return this.setValues(Array.from({ length: this.nr }, () => Array(this.nc).fill(''))); }
    setFontWeight() { return this; }
    getRow() { return this.r; }
    createTextFinder(text) {
      const sheet = this.sheet, col = this.c;
      return { matchEntireCell() { return this; }, findNext() {
        stats.reads++;
        const i = sheet.rows.findIndex(r => String(r[col - 1]) === text);
        return i < 0 ? null : new Range(sheet, i + 1, col, 1, 1);
      } };
    }
  }
  class Sheet {
    constructor(name) { this.name = name; this.rows = []; }
    getName() { return this.name; }
    getLastRow() { let n = this.rows.length; while (n && this.rows[n - 1].every(x => x === '' || x === undefined)) n--; return n; }
    getLastColumn() { return Math.max(0, ...this.rows.map(r => r.length)); }
    getRange(a, c, nr, nc) {
      if (typeof a === 'string') return new Range(this, 1, a.charCodeAt(0) - 64, Math.max(1, this.getLastRow()), 1);
      return new Range(this, a, c, nr || 1, nc || 1);
    }
    getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    setFrozenRows() {}
  }
  class SS {
    constructor(name) { this.id = 'ss' + String(nextId++).padStart(30, '0'); this.name = name; this.sheets = [new Sheet('Sheet1')]; store[this.id] = this; }
    getId() { return this.id; }
    getUrl() { return 'https://sheets/' + this.id; }
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
    insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
    getSheets() { return this.sheets.slice(); }
    deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  }

  const props = {};
  const cache = {};
  const fixtures = {
    'data/uk/unassigned.jsonl': 'uk.jsonl', 'data/en/unassigned.jsonl': 'en.jsonl',
    'data/eval_uk/unassigned.jsonl': 'eval_uk.jsonl', 'data/eval_en/unassigned.jsonl': 'eval_en.jsonl',
    'metadata/cases.jsonl': 'cases.jsonl', 'metadata/tags.json': 'tags.json'
  };
  let uuid = 0;
  const ctx = {
    console,
    SpreadsheetApp: { create: n => new SS(n), openById: id => store[id] },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({
      get: k => (k in cache ? cache[k] : null),
      getAll: ks => Object.fromEntries(ks.filter(k => k in cache).map(k => [k, cache[k]])),
      put: (k, v) => {
        if (String(v).length > 100000) throw new Error('cache value too large: ' + k);
        cache[k] = String(v);
      },
      putAll: m => Object.keys(m).forEach(k => {
        if (String(m[k]).length > 100000) throw new Error('cache value too large: ' + k);
        cache[k] = String(m[k]);
      }),
      remove: k => { delete cache[k]; },
      removeAll: ks => ks.forEach(k => delete cache[k])
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: { fetch: url => {
      const rel = Object.keys(fixtures).find(k => url.endsWith(k));
      if (!rel) throw new Error('no fixture for ' + url);
      const text = fs.readFileSync(path.join(fixtureDir, fixtures[rel]), 'utf8');
      return { getContentText: () => text };
    } },
    Utilities: {
      getUuid: () => 'uuid-' + (++uuid).toString(16).padStart(8, '0') + '-xxxx-xxxx',
      formatDate: (d, tz, fmt) => new Date(d).toISOString().slice(0, 10)
    },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Logger: { log() {} }
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'apps-script');
  for (const f of ['Logic.js', 'Code.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  return { ctx, stats, cache, store };
}

module.exports = { makeEnv };
