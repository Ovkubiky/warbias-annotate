/**
 * WarBias annotation backend: a Google Sheet + this web app.
 * Run once from the Apps Script editor: setup(), then importWarBias(), then makeLinks().
 * The web app is a small JSON API used by the GitHub Pages front end.
 */

var TABS = {
  config: ['key', 'value', 'note'],
  annotators: ['id', 'name', 'token', 'link', 'active', 'created', 'onboarded', 'practice'],
  items: ['item_id', 'type', 'gold', 'group', 'payload'],
  reviews: ['review_id', 'ts', 'day', 'annotator', 'item_id', 'type', 'outcome', 'answer', 'raw', 'position', 'session', 'dwell_ms', 'result', 'undone']
};

var CONFIG_DEFAULTS = [
  ['pages_url', 'https://ovkubiky.github.io/warbias-annotate/', 'Адреса інтерфейсу; з неї будуються персональні посилання'],
  ['min_reviews_tri', 2, 'Скільки незалежних оцінок отримує кожна трійка'],
  ['min_reviews_qa', 2, 'Скільки незалежних оцінок отримує кожне питання'],
  ['min_reviews_sev', 2, 'Скільки людей оцінює небезпечність кожного стереотипу'],
  ['max_reviews', 3, 'Якщо хтось знайшов проблему (або відповіді різні) — ще одна думка, до цієї кількості'],
  ['gold_every', 10, 'Приблизно одна контрольна картка на стільки звичайних (позначте їх у items.gold: ok або bad)'],
  ['dwell_ms', 3000, 'Мінімальний час на картку, мс'],
  ['break_every', 25, 'Після скількох карток поспіль пропонувати перерву'],
  ['lease_minutes', 20, 'Скільки хвилин картка зарезервована за людиною, якій її видали'],
  ['hf_base', 'https://huggingface.co/datasets/FairForget/WarBias/resolve/main/', 'Звідки importWarBias() бере дані']
];

var TZ = 'Europe/Kyiv';

/* ---------- setup ---------- */

function setup() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('WarBias annotation');
  props.setProperty('SHEET_ID', ss.getId());
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  var cfg = ss.getSheetByName('config');
  if (cfg.getLastRow() === 1) cfg.getRange(2, 1, CONFIG_DEFAULTS.length, 3).setValues(CONFIG_DEFAULTS);
  ss.getSheets().forEach(function (sh) { if (!TABS[sh.getName()] && ss.getSheets().length > 1) ss.deleteSheet(sh); });
  Logger.log('Таблиця: ' + ss.getUrl());
  return ss.getUrl();
}

/** Pull the current WarBias release from Hugging Face into the items tab. Keeps gold marks. */
function importWarBias() {
  var c = config_(), base = c.hf_base;
  var jsonl = function (path) {
    return UrlFetchApp.fetch(base + path).getContentText().split('\n')
      .filter(function (l) { return l.trim(); }).map(function (l) { return JSON.parse(l); });
  };
  var uk = jsonl('data/uk/unassigned.jsonl'), en = byId_(jsonl('data/en/unassigned.jsonl'), 'id');
  var qaUk = jsonl('data/eval_uk/unassigned.jsonl'), qaEn = byId_(jsonl('data/eval_en/unassigned.jsonl'), 'id');
  var cases = byId_(jsonl('metadata/cases.jsonl'), 'case_id');
  var tags = {};
  JSON.parse(UrlFetchApp.fetch(base + 'metadata/tags.json').getContentText()).bias_tags
    .forEach(function (t) { tags[t.id] = t.definition; });

  var rows = [];
  uk.forEach(function (r) {
    var e = en[r.id] || {}, cs = cases[r.case_id] || {};
    rows.push([r.id, 'tri', '', r.case_id, JSON.stringify({
      actor: r.actor, section: cs.source_section_uk || '', def_en: tags[r.bias_tags[0]] || '',
      S: r.stereotype, C: r.counter_stereotype, U: r.unrelated,
      eS: e.stereotype || '', eC: e.counter_stereotype || '', eU: e.unrelated || ''
    })]);
  });
  qaUk.forEach(function (q) {
    var e = qaEn[q.id] || {};
    rows.push([q.id, 'qa', '', q.scenario_id, JSON.stringify({
      actor: q.target_group, ctx: q.context, q: q.question, ch: q.choices,
      en: { ctx: e.context || '', q: e.question || '', ch: e.choices || [] }
    })]);
  });
  var fam = {};
  uk.forEach(function (r) {
    var f = fam[r.case_id] || (fam[r.case_id] = { actor: r.actor, tag: r.bias_tags[0], plain: [], other: [] });
    (r.reporter ? f.other : f.plain).push(r.stereotype);
  });
  Object.keys(fam).sort().forEach(function (cid) {
    var f = fam[cid], cs = cases[cid] || {};
    var ex = uniq_(f.plain.concat(f.other)).slice(0, 3);
    rows.push([cid, 'sev', '', cid, JSON.stringify({ actor: f.actor, section: cs.source_section_uk || '', def_en: tags[f.tag] || '', ex: ex })]);
  });

  var sh = ss_().getSheetByName('items');
  var keep = {};
  rows_('items').forEach(function (r) { if (r.gold) keep[r.item_id] = r.gold; });
  rows.forEach(function (r) { if (keep[r[0]]) r[2] = keep[r[0]]; });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, TABS.items.length).clearContent();
  sh.getRange(2, 1, rows.length, TABS.items.length).setValues(rows);
  Logger.log('Імпортовано: ' + rows.length + ' карток');
  return rows.length;
}

/** Give every annotator row that has a name but no token a personal link. */
function makeLinks() {
  var c = config_(), sh = ss_().getSheetByName('annotators');
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    if (!v[i][1] || v[i][2]) continue;
    var token = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    var id = 'a' + ('0' + i).slice(-2);
    sh.getRange(i + 1, 1, 1, 6).setValues([[id, v[i][1], token, c.pages_url + '?t=' + token, true, new Date()]]);
  }
}

/* ---------- web app ---------- */

function doGet(e) {
  if (e && e.parameter && e.parameter.action) return json_(handle_(e.parameter));
  return ContentService.createTextOutput('WarBias annotation API');
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  return json_(handle_(req));
}

function handle_(req) {
  try {
    if (req.action === 'ping') return { ok: true };
    var me = annotator_(req.token);
    if (!me) return { ok: false, error: 'unknown_token' };
    switch (req.action) {
      case 'hello': return hello_(me);
      case 'next': return next_(me, req);
      case 'submit': return submit_(me, req);
      case 'undo': return undo_(me, req);
      case 'board': return board_(me);
      case 'onboarded': return onboarded_(me, req);
    }
    return { ok: false, error: 'unknown_action' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function hello_(me) {
  var c = config_();
  return {
    ok: true, me: { id: me.id, name: me.name, onboarded: !!me.onboarded },
    config: { dwell_ms: +c.dwell_ms || 3000, break_every: +c.break_every || 25 },
    stats: stats_(me.id)
  };
}

function next_(me, req) {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var c = config_(), opts = opts_(c), items = itemIndex_(), reviews = reviewIndex_();
    var cache = CacheService.getScriptCache();
    var leases = JSON.parse(cache.get('leases') || '{}'), now = Date.now();
    var picked = pickNext(items.list, reviews, leases, {
      annotator: me.id, mode: req.mode || 'all', count: Math.min(+req.count || opts.batch, 5),
      exclude: req.exclude || [], now: now
    }, opts);
    Object.keys(leases).forEach(function (k) {
      leases[k] = leases[k].filter(function (l) { return l.exp > now; });
      if (!leases[k].length) delete leases[k];
    });
    picked.forEach(function (it) {
      (leases[it.item_id] = (leases[it.item_id] || []).filter(function (l) { return l.a !== me.id; }))
        .push({ a: me.id, exp: now + opts.leaseMinutes * 60000 });
    });
    cache.put('leases', JSON.stringify(leases), 21600);
    var sh = ss_().getSheetByName('items');
    var cards = picked.map(function (it) {
      return { item_id: it.item_id, type: it.type, payload: JSON.parse(sh.getRange(it.row, 5).getValue()) };
    });
    return { ok: true, cards: cards, remaining: remainingFor(items.list, reviews, me.id, opts) };
  } finally { lock.releaseLock(); }
}

/** Accepts one review or a batch (offline queue flush). Idempotent on review_id. */
function submit_(me, req) {
  var list = req.reviews || (req.review ? [req.review] : []);
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = ss_().getSheetByName('reviews');
    var existing = {};
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { existing[r[0]] = true; });
    var now = new Date(), day = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
    var rows = list.filter(function (r) { return r && r.review_id && !existing[r.review_id]; }).map(function (r) {
      return [r.review_id, now, day, me.id, r.item_id, r.type, r.outcome, r.answer === null || r.answer === undefined ? '' : r.answer,
        r.raw === null || r.raw === undefined ? '' : r.raw, r.position || '', r.session || '', r.dwell_ms || '',
        JSON.stringify(r.result || {}), false];
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, TABS.reviews.length).setValues(rows);
    var cache = CacheService.getScriptCache(), leases = JSON.parse(cache.get('leases') || '{}');
    list.forEach(function (r) {
      if (leases[r.item_id]) leases[r.item_id] = leases[r.item_id].filter(function (l) { return l.a !== me.id; });
    });
    cache.put('leases', JSON.stringify(leases), 21600);
    return { ok: true, saved: rows.length, stats: stats_(me.id) };
  } finally { lock.releaseLock(); }
}

function undo_(me, req) {
  var sh = ss_().getSheetByName('reviews');
  var hit = sh.getRange('A:A').createTextFinder(String(req.review_id)).matchEntireCell(true).findNext();
  if (!hit) return { ok: true, found: false };
  var row = hit.getRow();
  if (sh.getRange(row, 4).getValue() !== me.id) return { ok: false, error: 'not_yours' };
  sh.getRange(row, TABS.reviews.indexOf('undone') + 1).setValue(true);
  return { ok: true, found: true, stats: stats_(me.id) };
}

/** Remember that this person finished (or skipped) the walkthrough, with their practice answers. */
function onboarded_(me, req) {
  var sh = ss_().getSheetByName('annotators');
  var head = ensureCols_(sh, ['onboarded', 'practice']);
  var ids = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).getValues().map(function (r) { return r[0]; });
  var i = ids.indexOf(me.id);
  if (i < 0) return { ok: false, error: 'not_found' };
  sh.getRange(i + 2, head.indexOf('onboarded') + 1).setValue(new Date());
  sh.getRange(i + 2, head.indexOf('practice') + 1).setValue(JSON.stringify(req.results || {}));
  return { ok: true };
}

/** Add missing header columns to an existing sheet (older setups). Returns the header row. */
function ensureCols_(sh, cols) {
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  cols.forEach(function (c) {
    if (head.indexOf(c) < 0) { head.push(c); sh.getRange(1, head.length).setValue(c).setFontWeight('bold'); }
  });
  return head;
}

function board_(me) {
  var items = itemIndex_(), reviews = reviewIndex_();
  var people = rows_('annotators').filter(function (a) { return a.id; }).map(function (a) { return { id: a.id, name: a.name }; });
  var lb = leaderboard(items.list, reviews, people);
  return { ok: true, me: me.id, board: lb, team: teamProgress(items.list, reviews, opts_(config_())) };
}

function stats_(id) {
  var items = itemIndex_(), reviews = reviewIndex_(), opts = opts_(config_());
  var mine = reviews.filter(function (r) { return r.annotator === id && !r.undone; });
  var days = {};
  mine.forEach(function (r) { days[r.day] = true; });
  return {
    done: mine.length, remaining: remainingFor(items.list, reviews, id, opts),
    team: teamProgress(items.list, reviews, opts), streak: streak(Object.keys(days))
  };
}

/* ---------- sheet helpers ---------- */

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Спершу запустіть setup()');
  return SpreadsheetApp.openById(id);
}

function rows_(name) {
  var v = ss_().getSheetByName(name).getDataRange().getValues(), h = v.shift();
  return v.filter(function (r) { return r[0] !== ''; }).map(function (r) {
    var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o;
  });
}

function config_() {
  var c = {};
  rows_('config').forEach(function (r) { c[r.key] = r.value; });
  return c;
}

function opts_(c) {
  return {
    minReviews: { tri: +c.min_reviews_tri || 2, qa: +c.min_reviews_qa || 2, sev: +c.min_reviews_sev || 2 },
    maxReviews: +c.max_reviews || 3, goldEvery: +c.gold_every || 10,
    leaseMinutes: +c.lease_minutes || 20, batch: 3
  };
}

function annotator_(token) {
  if (!token) return null;
  var hit = rows_('annotators').filter(function (a) { return a.token === token && a.active !== false && a.active !== 'FALSE'; })[0];
  return hit || null;
}

/** Items without payloads (payload is fetched per picked row). */
function itemIndex_() {
  var sh = ss_().getSheetByName('items'), n = sh.getLastRow() - 1;
  if (n < 1) return { list: [] };
  var v = sh.getRange(2, 1, n, 3).getValues(), list = [];
  v.forEach(function (r, i) { if (r[0] !== '') list.push({ item_id: String(r[0]), type: r[1], gold: r[2], row: i + 2 }); });
  return { list: list };
}

function reviewIndex_() {
  var sh = ss_().getSheetByName('reviews'), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var h = TABS.reviews, v = sh.getRange(2, 1, n, h.length).getValues();
  var ix = function (k) { return h.indexOf(k); };
  return v.map(function (r) {
    return {
      item_id: String(r[ix('item_id')]), annotator: r[ix('annotator')], outcome: r[ix('outcome')],
      answer: r[ix('answer')], day: r[ix('day')] instanceof Date ? Utilities.formatDate(r[ix('day')], TZ, 'yyyy-MM-dd') : String(r[ix('day')]),
      undone: r[ix('undone')] === true || r[ix('undone')] === 'TRUE'
    };
  });
}

function byId_(list, key) { var m = {}; list.forEach(function (x) { m[x[key]] = x; }); return m; }
function uniq_(a) { var s = {}; return a.filter(function (x) { return s[x] ? false : (s[x] = true); }); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
