/**
 * WarBias annotation backend: a Google Sheet + this web app.
 * Run once from the Apps Script editor: setup(), then importWarBias(), then makeLinks().
 * The web app is a small JSON API used by the GitHub Pages front end.
 */

var TABS = {
  config: ['key', 'value', 'note'],
  annotators: ['id', 'name', 'token', 'link', 'active', 'created', 'onboarded', 'practice', 'admin'],
  items: ['item_id', 'type', 'gold', 'group', 'payload'],
  reviews: ['review_id', 'ts', 'day', 'annotator', 'item_id', 'type', 'outcome', 'answer', 'raw', 'position', 'session', 'dwell_ms', 'result', 'undone', 'edits', 'flags', 'source']
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
  ['hf_base', 'https://huggingface.co/datasets/FairForget/WarBias/resolve/main/', 'Звідки importWarBias() бере дані'],
  ['count_round1', false, 'TRUE — оцінки раунду 1 (importRound1) зараховуються до потрібної кількості оцінок'],
  ['round1_sheet', '', 'Посилання або ID таблиці першого раунду для importRound1()']
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
  // new item version: cached index and payloads from the old import are ignored from now on
  PropertiesService.getScriptProperties().setProperty('ITEMS_VER', String(Date.now()));
  Logger.log('Імпортовано: ' + rows.length + ' карток');
  return rows.length;
}

/** Give every annotator row that has a name but no token a personal link. */
function makeLinks() {
  var c = config_(), sh = ss_().getSheetByName('annotators');
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    if (!v[i][1] || v[i][2] || String(v[i][0]).indexOf('r1-') === 0) continue;   // round-1 volunteers get no link
    var token = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    var id = 'a' + ('0' + i).slice(-2);
    sh.getRange(i + 1, 1, 1, 6).setValues([[id, v[i][1], token, c.pages_url + '?t=' + token, true, new Date()]]);
  }
  cDel_('ann');
}

/* ---------- round 1 (the Google Sheets annotation) ---------- */

/**
 * Copy the first annotation round into `reviews` (source = round1), so it is kept next to the new data
 * and shown on the dashboard as a baseline. Put the old spreadsheet's link in config.round1_sheet and run
 * this from the editor. Safe to re-run: rows already imported are skipped.
 * Volunteers become `annotators` rows `r1-NN` without links, unless someone with the same name already
 * has a link — then their old reviews go under that id, so they are not shown the same cards again.
 * Whether round 1 counts towards the review targets is config.count_round1 (FALSE by default).
 */
function importRound1() {
  var c = config_(), ref = String(c.round1_sheet || '');
  if (!ref) {
    addConfig_([['count_round1', false, 'TRUE — оцінки раунду 1 зараховуються до потрібної кількості оцінок'],
      ['round1_sheet', '', 'Посилання або ID таблиці першого раунду для importRound1()']]);
    throw new Error('Вставте посилання на таблицю першого раунду в config.round1_sheet і запустіть ще раз');
  }
  var m = ref.match(/[-\w]{25,}/), src = SpreadsheetApp.openById(m ? m[0] : ref);
  var res = round1Rows_(src, rows_('items'), people_());
  var sh = ss_().getSheetByName('reviews');
  ensureReviewCols_(sh);
  var have = {};
  reviewIndex_().forEach(function (r) { have[r.review_id] = true; });
  var fresh = res.rows.filter(function (r) { return !have[r[0]]; });
  if (fresh.length) sh.getRange(sh.getLastRow() + 1, 1, fresh.length, TABS.reviews.length).setValues(fresh);
  if (res.newPeople.length) {
    var ann = ss_().getSheetByName('annotators');
    ensureCols_(ann, TABS.annotators);
    ann.getRange(ann.getLastRow() + 1, 1, res.newPeople.length, TABS.annotators.length).setValues(res.newPeople);
  }
  ['rv', 'ann', 'board', 'dash'].forEach(cDel_);
  var msg = 'Раунд 1: додано ' + fresh.length + ' оцінок (уже були: ' + (res.rows.length - fresh.length) + '), ' +
    'людей: ' + res.people + ' (з них знайдено серед поточних: ' + res.matched + '). ' +
    'Пропущено: ' + res.missing.length + ' прикладів, яких немає в поточному датасеті' +
    (res.missing.length ? ' (' + res.missing.slice(0, 10).join(', ') + (res.missing.length > 10 ? '…' : '') + ')' : '') +
    (res.unparsed ? '; відповідей QA не розпізнано: ' + res.unparsed : '') + '.';
  Logger.log(msg);
  return msg;
}

function addConfig_(rows) {
  var sh = ss_().getSheetByName('config'), keys = rows_('config').map(function (r) { return r.key; });
  rows = rows.filter(function (r) { return keys.indexOf(r[0]) < 0; });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  cDel_('cfg');
}

/** Pure conversion of the round-1 spreadsheet into review rows (no writes), for importRound1 and tests. */
function round1Rows_(src, itemRows, people) {
  var norm = function (t) { return String(t || '').replace(/\s+/g, ' ').trim(); };
  var key = function (t) { return norm(t).toLowerCase(); };
  var payload = {};
  itemRows.forEach(function (r) { try { payload[String(r.item_id)] = JSON.parse(r.payload); } catch (e) {} });

  // volunteers: sheet number → annotator id (an existing person with the same name, or a new r1-NN row)
  var byName = {};
  people.forEach(function (p) { if (p.id && p.name) byName[key(p.name)] = String(p.id); });
  var vol = {}, newPeople = [], matched = 0;
  var vs = src.getSheetByName('волонтери');
  (vs ? vs.getDataRange().getValues().slice(1) : []).forEach(function (r) {
    var n = parseInt(r[0], 10); if (!n || !r[1]) return;
    var id = byName[key(r[1])];
    if (id && id.indexOf('r1-') !== 0) matched++;
    if (!id) {
      id = 'r1-' + ('0' + n).slice(-2);
      var row = TABS.annotators.map(function () { return ''; });
      row[0] = id; row[1] = norm(r[1]); row[4] = false; row[5] = new Date();
      newPeople.push(row);
    }
    vol[n] = id;
  });

  var ST = { 'прийнято': 'ok', 'переробити повністю': 'redo', 'виправлено вручну': 'edit' };
  var status = function (v) { return ST[key(v)] || ''; };
  var rows = [], missing = {}, unparsed = 0;
  var push = function (sheet, rowNo, pos, id, type, outcome, answer, result) {
    result.source = 'round1';
    var r = { review_id: 'r1:' + sheet + ':' + rowNo, item_id: id, type: type, outcome: outcome, answer: answer, result: result };
    var n = parseInt(sheet.replace(/\D+/g, ''), 10);
    rows.push([r.review_id, '', '', vol[n] || ('r1-' + ('0' + n).slice(-2)), id, type, outcome, answer === null ? '' : answer, '',
      pos, 'round1:' + sheet, '', JSON.stringify(result), false].concat(readable_(result), ['round1']));
  };

  src.getSheets().forEach(function (ws) {
    var name = ws.getName(), isQa = /^WB_EVAL_\d+$/.test(name), isTri = /^WB_\d+$/.test(name);
    if (!isQa && !isTri) return;
    var v = ws.getDataRange().getValues(), pos = 0;
    for (var i = 1; i < v.length; i++) {
      var r = v[i], id = norm(r[0]);
      if (!id) continue;
      pos++;
      var p = payload[id];
      if (!p) { missing[id] = 1; continue; }
      var comment = norm(isTri ? r[7] : r[4]);
      if (isTri) {
        var st = {}, text = {}, why = {}, notes = [];
        [['S', 1, 2], ['C', 3, 4], ['U', 5, 6]].forEach(function (k) {
          var s = status(r[k[2]]), cell = norm(r[k[1]]), orig = norm(p[k[0]]);
          if (cell && cell !== orig) {
            if (similar_(cell, orig) >= 0.5) { text[k[0]] = cell; if (s !== 'redo') s = 'edit'; }
            else notes.push(k[0] + ': ' + cell);             // a remark typed into the sentence cell
          }
          if (s === 'edit' && !text[k[0]]) notes.push(k[0] + ': позначено «Виправлено вручну», але текст не змінено');
          st[k[0]] = s;
          if (s === 'redo') why[k[0]] = [{ frag: null, range: null, reason: comment || 'Переробити повністю' }];
        });
        if (!st.S && !st.C && !st.U) { pos--; continue; }   // not annotated yet
        var res = { status: st };
        if (Object.keys(text).length) res.text = text;
        if (Object.keys(why).length) res.why = why;
        if (comment || notes.length) res.comment = [comment].concat(notes).filter(String).join(' | ');
        var bad = ['S', 'C', 'U'].some(function (k) { return st[k] === 'redo' || st[k] === 'edit'; });
        push(name, i + 1, pos, id, 'tri', bad ? 'no' : 'yes', null, res);
      } else {
        var s = status(r[3]);
        if (!s && !norm(r[2])) { pos--; continue; }
        // the cell holds "context\n\nquestion\n\nA. …\nB. …\nC. …"; map the letter to the choice text
        var raw = String(r[1] || ''), opts = {}, ans = null;
        raw.split('\n').forEach(function (l) { var mm = l.match(/^\s*([ABCАВС])[.)]\s*(.+)$/); if (mm) opts['ABCАВС'.indexOf(mm[1]) % 3] = key(mm[2]); });
        var letter = norm(r[2]).toUpperCase().replace('А', 'A').replace('В', 'B').replace('С', 'C');
        var li = 'ABC'.indexOf(letter);
        if (li >= 0) {
          var chosen = opts[li];
          ans = chosen ? (p.ch || []).map(key).indexOf(chosen) : -1;
          if (ans < 0) { ans = null; unparsed++; }
        }
        var parts = raw.split(/\n\s*\n/), qres = { status: { X: s === 'ok' ? 'ok' : s } };
        var ctx = norm(parts[0]), qtext = norm(parts[1]);
        if (ctx && ctx !== norm(p.ctx) && similar_(ctx, p.ctx) >= 0.5) { qres.text = { X: ctx }; if (s !== 'redo') qres.status.X = 'edit'; }
        if (qtext && p.q && qtext !== norm(p.q) && similar_(qtext, p.q) >= 0.5) (qres.text = qres.text || {}).Q = qtext;
        if (qres.status.X === 'redo') qres.why = { X: [{ frag: null, range: null, reason: comment || 'Переробити повністю' }] };
        if (comment) qres.comment = comment;
        var qbad = qres.status.X === 'redo' || qres.status.X === 'edit';
        push(name, i + 1, pos, id, 'qa', qbad ? 'no' : 'yes', ans, qres);
      }
    }
  });
  return { rows: rows, newPeople: newPeople, people: Object.keys(vol).length, matched: matched,
    missing: Object.keys(missing), unparsed: unparsed };
}

/** Word-level similarity 0..1 (2·LCS / total words), to tell an edited sentence from a remark. */
function similar_(a, b) {
  var x = String(a || '').toLowerCase().split(/\s+/).filter(String), y = String(b || '').toLowerCase().split(/\s+/).filter(String);
  if (!x.length || !y.length) return 0;
  var prev = new Array(y.length + 1).fill(0);
  for (var i = 1; i <= x.length; i++) {
    var cur = [0];
    for (var j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return 2 * prev[y.length] / (x.length + y.length);
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
      case 'dashboard': return dashboard_(me);
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
    var cards = payloads_(picked).map(function (x) { return { item_id: x.it.item_id, type: x.it.type, payload: x.payload }; });
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
    reviewIndex_().forEach(function (r) { existing[r.review_id] = true; });
    var now = new Date(), day = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
    var rows = list.filter(function (r) { return r && r.review_id && !existing[r.review_id]; }).map(function (r) {
      return [r.review_id, now, day, me.id, r.item_id, r.type, r.outcome, r.answer === null || r.answer === undefined ? '' : r.answer,
        r.raw === null || r.raw === undefined ? '' : r.raw, r.position || '', r.session || '', r.dwell_ms || '',
        JSON.stringify(r.result || {}), false].concat(readable_(r.result), ['']);
    });
    if (rows.length) {
      ensureReviewCols_(sh);
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, TABS.reviews.length).setValues(rows);
      updateReviewCache_(function (rv) { rows.forEach(function (r) { rv.push(compactReview_(r)); }); });
      cDel_('board');
    }
    var cache = CacheService.getScriptCache(), leases = JSON.parse(cache.get('leases') || '{}');
    list.forEach(function (r) {
      if (leases[r.item_id]) leases[r.item_id] = leases[r.item_id].filter(function (l) { return l.a !== me.id; });
    });
    cache.put('leases', JSON.stringify(leases), 21600);
    return { ok: true, saved: rows.length, stats: stats_(me.id) };
  } finally { lock.releaseLock(); }
}

function undo_(me, req) {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var sh = ss_().getSheetByName('reviews');
    var hit = sh.getRange('A:A').createTextFinder(String(req.review_id)).matchEntireCell(true).findNext();
    if (!hit) return { ok: true, found: false };
    var row = hit.getRow();
    if (sh.getRange(row, 4).getValue() !== me.id) return { ok: false, error: 'not_yours' };
    sh.getRange(row, TABS.reviews.indexOf('undone') + 1).setValue(true);
    updateReviewCache_(function (rv) { rv.forEach(function (r) { if (r[0] === String(req.review_id)) r[6] = 1; }); });
    cDel_('board');
    return { ok: true, found: true, stats: stats_(me.id) };
  } finally { lock.releaseLock(); }
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
  cDel_('ann');
  return { ok: true };
}

/** Human-readable copies of result.text and result.why for the `edits` and `flags` columns. */
function readable_(res) {
  res = res || {};
  var text = res.text || {}, why = res.why || {}, st = res.status || {};
  var edits = Object.keys(text).map(function (k) { return k + ': ' + text[k]; }).join('\n');
  var flags = [];
  Object.keys(why).forEach(function (k) {
    (why[k] || []).forEach(function (it) {
      flags.push(k + ' ✕ ' + (it.frag ? '«' + it.frag + '» — ' : '') + it.reason);
    });
    if (!(why[k] || []).length && st[k] === 'redo') flags.push(k + ' ✕');
  });
  // a free-text remark (round 1) that is not already shown as a reason
  if (res.comment && flags.join('\n').indexOf(res.comment) < 0) flags.push('💬 ' + res.comment);
  return [edits, flags.join('\n')];
}
/** Sheets made before `edits`/`flags` existed get the headers once, and their old rows filled in. */
function ensureReviewCols_(sh) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('RV_COLS') === String(TABS.reviews.length)) return;
  ensureCols_(sh, TABS.reviews);
  fillReadable_(sh);
  props.setProperty('RV_COLS', String(TABS.reviews.length));
}
/** Can be run from the editor: (re)fill `edits` and `flags` from the `result` JSON of every row. */
function fillReadable() {
  var sh = ss_().getSheetByName('reviews');
  ensureCols_(sh, TABS.reviews);
  fillReadable_(sh);
}
function fillReadable_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  var col = TABS.reviews.indexOf('result') + 1;
  var vals = sh.getRange(2, col, n, 1).getValues().map(function (r) {
    var res = {};
    try { res = JSON.parse(r[0] || '{}'); } catch (e) {}
    return readable_(res);
  });
  sh.getRange(2, TABS.reviews.indexOf('edits') + 1, n, 2).setValues(vals);
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
  var b = cGet_('board');
  if (!b) {
    var items = itemIndex_(), reviews = reviewIndex_();
    var people = people_().filter(function (a) { return a.id && String(a.id).indexOf('r1-') !== 0; }).map(function (a) { return { id: a.id, name: a.name }; });
    b = { board: leaderboard(items.list, reviews, people), team: teamProgress(items.list, reviews, opts_(config_())) };
    cPut_('board', b, 60);
  }
  return { ok: true, me: me.id, board: b.board, team: b.team };
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

/**
 * Progress dashboard. Everyone with a link sees team numbers; people with `admin` = TRUE in the
 * annotators tab also see per-person numbers and the latest edits and flags. Cached for 2 minutes.
 */
function dashboard_(me) {
  var d = cGet_('dash');
  if (!d) {
    var sh = ss_().getSheetByName('annotators');
    if (people_().length && !('admin' in people_()[0])) { ensureCols_(sh, TABS.annotators); cDel_('ann'); }
    var reviews = rows_('reviews').map(function (r) {
      var res = {};
      try { res = JSON.parse(r.result || '{}'); } catch (e) {}
      var ts = r.ts instanceof Date ? r.ts.getTime() : (Date.parse(r.ts) || null);
      var day = r.day instanceof Date ? Utilities.formatDate(r.day, TZ, 'yyyy-MM-dd') : String(r.day);
      return { review_id: String(r.review_id), item_id: String(r.item_id), annotator: String(r.annotator), type: r.type,
        outcome: r.outcome, answer: r.answer, raw: r.raw, position: r.position, dwell_ms: r.dwell_ms, day: day, ts: ts,
        undone: r.undone === true || r.undone === 'TRUE', result: res, src: r.source === 'round1' ? 'r1' : '' };
    });
    var people = people_().filter(function (a) { return a.id; }).map(function (a) {
      return { id: String(a.id), name: a.name, onboarded: !!a.onboarded, active: a.active !== false && a.active !== 'FALSE' };
    });
    d = dashboardStats(itemIndex_().list, reviews, people, opts_(config_()));
    d.generated = new Date().toISOString();
    cPut_('dash', d, 120);
  }
  var admin = me.admin === true || String(me.admin).toUpperCase() === 'TRUE';
  var out = JSON.parse(JSON.stringify(d));
  if (!admin) delete out.admin;
  out.ok = true; out.isAdmin = admin; out.me = me.id;
  return out;
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
  var c = cGet_('cfg');
  if (c) return c;
  c = {};
  rows_('config').forEach(function (r) { c[r.key] = r.value; });
  cPut_('cfg', c, 300);                        // edits in the config tab apply within 5 minutes
  return c;
}

function people_() {
  var p = cGet_('ann');
  if (p) return p;
  p = rows_('annotators');
  cPut_('ann', p, 300);
  return p;
}

function opts_(c) {
  return {
    minReviews: { tri: +c.min_reviews_tri || 2, qa: +c.min_reviews_qa || 2, sev: +c.min_reviews_sev || 2 },
    maxReviews: +c.max_reviews || 3, goldEvery: +c.gold_every || 10,
    leaseMinutes: +c.lease_minutes || 20, batch: 3,
    countRound1: c.count_round1 === true || String(c.count_round1).toUpperCase() === 'TRUE'
  };
}

function annotator_(token) {
  if (!token) return null;
  var hit = people_().filter(function (a) { return a.token === token && a.active !== false && a.active !== 'FALSE'; })[0];
  return hit || null;
}

function itemsVer_() { return PropertiesService.getScriptProperties().getProperty('ITEMS_VER') || '0'; }

/** Items without payloads. Cached 5 minutes, so gold marks edited in the sheet apply within that time. */
function itemIndex_() {
  var key = 'items' + itemsVer_(), c = cGet_(key);
  if (c) return { list: c.map(function (r) { return { item_id: r[0], type: r[1], gold: r[2], row: r[3] }; }) };
  var sh = ss_().getSheetByName('items'), n = sh.getLastRow() - 1;
  if (n < 1) return { list: [] };
  var v = sh.getRange(2, 1, n, 3).getValues(), list = [];
  v.forEach(function (r, i) { if (r[0] !== '') list.push({ item_id: String(r[0]), type: r[1], gold: r[2], row: i + 2 }); });
  cPut_(key, list.map(function (it) { return [it.item_id, it.type, it.gold, it.row]; }), 300);
  return { list: list };
}

/** Card texts, from cache when possible (6 h), otherwise one sheet read per missing card. */
function payloads_(picked) {
  if (!picked.length) return [];
  var ver = itemsVer_(), keys = picked.map(function (it) { return 'p' + ver + ':' + it.item_id; });
  var got = cache_().getAll(keys), sh = null, put = {};
  var out = picked.map(function (it, i) {
    var s = got[keys[i]];
    if (!s) { sh = sh || ss_().getSheetByName('items'); s = String(sh.getRange(it.row, 5).getValue()); put[keys[i]] = s; }
    return { it: it, payload: JSON.parse(s) };
  });
  if (Object.keys(put).length) cache_().putAll(put, TTL_LONG);
  return out;
}

/* Reviews index: a compact copy of the reviews tab kept in cache and updated on every submit / undo,
 * so reads don't touch the sheet. The sheet stays the source of truth: on a cache miss it is rebuilt. */
function compactReview_(r) {
  var h = TABS.reviews, ix = function (k) { return h.indexOf(k); }, day = r[ix('day')];
  return [String(r[ix('review_id')]), String(r[ix('item_id')]), String(r[ix('annotator')]), String(r[ix('outcome')]),
    r[ix('answer')] === '' || r[ix('answer')] === null ? '' : r[ix('answer')],
    day instanceof Date ? Utilities.formatDate(day, TZ, 'yyyy-MM-dd') : String(day),
    (r[ix('undone')] === true || r[ix('undone')] === 'TRUE') ? 1 : 0, r[ix('source')] === 'round1' ? 1 : 0];
}
function reviewRows_() {
  var c = cGet_('rv');
  if (c) return c;
  var sh = ss_().getSheetByName('reviews'), n = sh.getLastRow() - 1;
  c = n < 1 ? [] : sh.getRange(2, 1, n, TABS.reviews.length).getValues().filter(function (r) { return r[0] !== ''; }).map(compactReview_);
  cPut_('rv', c, TTL_LONG);
  return c;
}
function updateReviewCache_(fn) {          // callers hold the script lock
  var c = cGet_('rv');
  if (!c) return;                          // nothing cached: next read rebuilds from the sheet
  fn(c);
  cPut_('rv', c, TTL_LONG);
}
function reviewIndex_() {
  return reviewRows_().map(function (r) {
    return { review_id: r[0], item_id: r[1], annotator: r[2], outcome: r[3], answer: r[4], day: r[5], undone: r[6] === 1, src: r[7] ? 'r1' : '' };
  });
}

/* ---------- cache helpers: JSON values, split into chunks under the 100 KB limit ---------- */
var TTL_LONG = 21600, CHUNK = 30000;       // Cyrillic is up to 3 bytes per character
function cache_() { return CacheService.getScriptCache(); }
function cGet_(key) {
  var c = cache_(), head = c.get(key);
  if (!head) return null;
  var h = JSON.parse(head);
  if (!h.n) return h.v;
  var keys = [];
  for (var i = 0; i < h.n; i++) keys.push(key + ':' + i);
  var parts = c.getAll(keys), s = '';
  for (var j = 0; j < h.n; j++) { if (parts[keys[j]] == null) return null; s += parts[keys[j]]; }
  return JSON.parse(s);
}
function cPut_(key, obj, ttl) {
  var s = JSON.stringify(obj), c = cache_();
  if (s.length < CHUNK) { c.put(key, JSON.stringify({ v: obj }), ttl); return; }
  var m = {}, n = Math.ceil(s.length / CHUNK);
  for (var i = 0; i < n; i++) m[key + ':' + i] = s.slice(i * CHUNK, (i + 1) * CHUNK);
  c.putAll(m, ttl);
  c.put(key, JSON.stringify({ n: n }), ttl);
}
function cDel_(key) { cache_().remove(key); }

function byId_(list, key) { var m = {}; list.forEach(function (x) { m[x[key]] = x; }); return m; }
function uniq_(a) { var s = {}; return a.filter(function (x) { return s[x] ? false : (s[x] = true); }); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
