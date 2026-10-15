const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { makeEnv } = require('./gas_shim');

function boot(names = ['Анна', 'Богдан', 'Віра']) {
  const env = makeEnv(path.join(__dirname, 'fixtures'));
  const g = env.ctx;
  g.setup();
  g.importWarBias();
  const sh = g.ss_().getSheetByName('annotators');
  names.forEach((n, i) => sh.getRange(i + 2, 2).setValue(n));
  g.makeLinks();
  const tokens = g.rows_('annotators').map(a => a.token);
  const call = (token, action, extra = {}) => g.handle_({ action, token, ...extra });
  return { env, g, tokens, call };
}
const review = (card, outcome = 'yes', extra = {}) => ({
  review_id: 'r-' + Math.random().toString(36).slice(2), item_id: card.item_id, type: card.type, outcome,
  answer: card.type === 'qa' ? 0 : null, raw: card.type === 'sev' ? 0.5 : null, result: {}, ...extra
});

test('import builds triplets, QA and one severity card per case family', () => {
  const { g } = boot();
  const types = g.itemIndex_().list.reduce((m, it) => (m[it.type] = (m[it.type] || 0) + 1, m), {});
  assert.deepStrictEqual(types, { tri: 50, qa: 12, sev: 6 });
});

test('unknown token is rejected, known token says hello', () => {
  const { tokens, call } = boot();
  assert.strictEqual(call('nope', 'hello').error, 'unknown_token');
  const r = call(tokens[0], 'hello');
  assert.ok(r.ok); assert.strictEqual(r.me.name, 'Анна'); assert.strictEqual(r.stats.done, 0);
});

test('a full session: next → submit → nothing repeats, counts add up', () => {
  const { tokens, call } = boot();
  const seen = new Set();
  for (let k = 0; k < 10; k++) {
    const r = call(tokens[0], 'next', { mode: 'all', exclude: [] });
    assert.ok(r.ok, r.error);
    r.cards.forEach(c => assert.ok(!seen.has(c.item_id), 'repeated ' + c.item_id));
    const s = call(tokens[0], 'submit', { reviews: r.cards.map(c => review(c)) });
    r.cards.forEach(c => seen.add(c.item_id));
    assert.strictEqual(s.stats.done, seen.size);
  }
});

test('third opinion: a negative review sends the item to a third person first', () => {
  const { tokens, call } = boot();
  const [a, b, c] = tokens;
  const card = call(a, 'next', { mode: 'tri', count: 1 }).cards[0];
  call(a, 'submit', { reviews: [review(card, 'no')] });
  // B gets it next (half-done items come first), answers yes
  const forB = call(b, 'next', { mode: 'tri', count: 1 }).cards[0];
  assert.strictEqual(forB.item_id, card.item_id);
  call(b, 'submit', { reviews: [review(forB, 'yes')] });
  // disputed → C sees it first
  const forC = call(c, 'next', { mode: 'tri', count: 1 }).cards[0];
  assert.strictEqual(forC.item_id, card.item_id);
});

test('submit is idempotent on review_id (offline queue retries)', () => {
  const { tokens, call, g } = boot();
  const card = call(tokens[0], 'next', { count: 1 }).cards[0];
  const rv = review(card);
  call(tokens[0], 'submit', { reviews: [rv] });
  call(tokens[0], 'submit', { reviews: [rv] });
  assert.strictEqual(g.rows_('reviews').length, 1);
});

test('undo marks the row and frees the item for others', () => {
  const { tokens, call, g } = boot();
  const card = call(tokens[0], 'next', { mode: 'sev', count: 1 }).cards[0];
  const rv = review(card);
  call(tokens[0], 'submit', { reviews: [rv] });
  assert.strictEqual(call(tokens[0], 'hello').stats.done, 1);
  const u = call(tokens[0], 'undo', { review_id: rv.review_id });
  assert.ok(u.found); assert.strictEqual(u.stats.done, 0);
  assert.strictEqual(g.rows_('reviews')[0].undone, true);
  assert.strictEqual(call(tokens[1], 'undo', { review_id: rv.review_id }).error, 'not_yours');
});

test('cache stays consistent with the sheet through submit and undo', () => {
  const { tokens, call, g } = boot();
  for (let k = 0; k < 4; k++) {
    const r = call(tokens[k % 3], 'next', { count: 3 });
    call(tokens[k % 3], 'submit', { reviews: r.cards.map(c => review(c, k % 2 ? 'no' : 'yes')) });
  }
  const last = g.rows_('reviews').slice(-1)[0];
  call(last.annotator === 'a01' ? tokens[0] : last.annotator === 'a02' ? tokens[1] : tokens[2], 'undo', { review_id: last.review_id });
  const cached = g.reviewIndex_();
  g.cache_().remove('rv2');                     // force a rebuild from the sheet
  const fresh = g.reviewIndex_();
  // compare as JSON: objects created inside the vm context have a different prototype chain
  assert.strictEqual(JSON.stringify(cached), JSON.stringify(fresh));
  assert.ok(cached.some(r => r.undone), 'the undo is visible in the cached index');
});

test('caching: repeat calls do not re-read the whole sheet', () => {
  const { tokens, call, env } = boot();
  call(tokens[0], 'hello'); call(tokens[0], 'next', {}); call(tokens[0], 'board');
  const before = env.stats.reads;
  for (let k = 0; k < 5; k++) { call(tokens[0], 'hello'); call(tokens[0], 'next', {}); call(tokens[0], 'board'); }
  const per = (env.stats.reads - before) / 5;
  assert.ok(per <= 1, `expected ≈0 sheet reads per warm round, got ${per}`);
});

test('board and onboarding', () => {
  const { tokens, call, g } = boot();
  const r = call(tokens[0], 'next', { count: 3 });
  call(tokens[0], 'submit', { reviews: r.cards.map(c => review(c)) });
  const b = call(tokens[0], 'board');
  assert.ok(b.ok); assert.strictEqual(b.board.length, 3);
  assert.strictEqual(b.board.find(p => p.id === b.me).cards, 3);
  assert.strictEqual(call(tokens[0], 'hello').me.onboarded, false);
  call(tokens[0], 'onboarded', { results: { skipped: false } });
  assert.strictEqual(call(tokens[0], 'hello').me.onboarded, true);
  assert.ok(g.rows_('annotators')[0].practice.includes('skipped'));
});

test('edits and flags are also written as readable columns; old rows can be backfilled', () => {
  const { tokens, call, g } = boot();
  const card = call(tokens[0], 'next', { mode: 'tri', count: 1 }).cards[0];
  call(tokens[0], 'submit', { reviews: [review(card, 'no', { result: {
    status: { S: 'edit', C: 'redo', U: '' },
    text: { S: 'Нове речення.', C: 'Виправлено, а потім ✕.' },
    why: { C: [{ frag: 'потім', range: [2, 2], reason: 'Звучить неприродно' }, { frag: null, range: null, reason: 'Не заперечує стереотип' }] }
  } })] });
  const row = g.rows_('reviews')[0];
  assert.strictEqual(row.edits, 'S: Нове речення.\nC: Виправлено, а потім ✕.');
  assert.strictEqual(row.flags, 'C ✕ «потім» — Звучить неприродно\nC ✕ Не заперечує стереотип');
  const sh = g.ss_().getSheetByName('reviews');
  sh.getRange(2, g.TABS.reviews.indexOf('edits') + 1, 1, 2).setValues([['', '']]);
  g.fillReadable();
  assert.strictEqual(g.rows_('reviews')[0].edits, row.edits);
});

test('rows saved before the readable columns existed are filled on the first new submit', () => {
  const { tokens, call, g } = boot();
  const sh = g.ss_().getSheetByName('reviews');
  const old = ['old-1', new Date(), '2026-10-14', 'a01', 'WB-0354', 'tri', 'no', '', '', 10, 's', 1,
    JSON.stringify({ status: { C: 'edit' }, text: { C: 'Стара правка.' } }), false];
  sh.getRange(2, 1, 1, old.length).setValues([old]);
  g.cache_().remove('rv2');
  const card = call(tokens[1], 'next', { count: 1 }).cards[0];
  call(tokens[1], 'submit', { reviews: [review(card)] });
  assert.strictEqual(g.rows_('reviews')[0].edits, 'C: Стара правка.');
});

test('dashboard: team numbers for everyone, details only for admins', () => {
  const { tokens, call, g } = boot();
  for (let k = 0; k < 3; k++) {
    const r = call(tokens[k], 'next', { count: 3 });
    call(tokens[k], 'submit', { reviews: r.cards.map(c => review(c, k ? 'yes' : 'no', { position: 1, result: k ? {} : { text: { S: 'нове' } } })) });
  }
  const d = call(tokens[1], 'dashboard');
  assert.ok(d.ok, d.error); assert.strictEqual(d.isAdmin, false); assert.strictEqual(d.admin, undefined);
  assert.strictEqual(d.totals.reviews, 9);
  const sh = g.ss_().getSheetByName('annotators');
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  assert.ok(head.includes('admin'), 'admin column added to an old sheet');
  sh.getRange(2, head.indexOf('admin') + 1).setValue(true); g.cache_().remove('ann');
  const a = call(tokens[0], 'dashboard');
  assert.strictEqual(a.isAdmin, true);
  assert.strictEqual(a.admin.people.find(p => p.id === 'a01').edits, 3);
  assert.strictEqual(a.admin.recent.length, 3);
});

test('round 1 import: statuses, edits, remarks, QA letters by choice text; not counted by default', () => {
  const { tokens, call, g } = boot(['Анна', 'Богдан']);
  const items = g.rows_('items'), tri = items.find(r => r.type === 'tri'), qa = items.find(r => r.type === 'qa');
  const tp = JSON.parse(tri.payload), qp = JSON.parse(qa.payload);
  const src = g.SpreadsheetApp.create('round1');
  const put = (name, rows) => { const sh = src.insertSheet(name); sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows); };
  put('волонтери', [['Номер', 'Волонтер'], [1, 'Анна'], [2, 'Хтось Інший']]);
  put('WB_01', [['ID', 'S', 'Статус S', 'C', 'Статус C', 'U', 'Статус U', 'Коментар'],
    [tri.item_id, tp.S, 'Прийнято', tp.C + ' ще', 'Виправлено вручну', 'Краще інакше', 'Переробити повністю', 'U не нейтральне'],
    ['WB-9999', 'x', 'Прийнято', 'y', 'Прийнято', 'z', 'Прийнято', '']]);
  // round 1 showed the choices in another order: map the letter through the choice text
  const shown = [qp.ch[2], qp.ch[0], qp.ch[1]];
  put('WB_EVAL_02', [['ID', 'Приклад UK', 'Відповідь A/B/C', 'Статус', 'Коментар'],
    [qa.item_id, `${qp.ctx}\n\n${qp.q}\n\nA. ${shown[0]}\nB. ${shown[1]}\nC. ${shown[2]}`, 'A', 'Прийнято', '']]);
  g.addConfig_([['round1_sheet', src.getUrl ? 'https://docs.google.com/spreadsheets/d/' + src.getId() + '/edit' : src.getId(), '']]);
  const cfg = g.ss_().getSheetByName('config'), keys = g.rows_('config').map(r => r.key);
  cfg.getRange(keys.indexOf('round1_sheet') + 2, 2).setValue('https://docs.google.com/spreadsheets/d/' + src.getId() + '/edit');
  g.cache_().remove('cfg');
  const msg = g.importRound1();
  assert.match(msg, /додано 2 оцінок/); assert.match(msg, /WB-9999/);
  g.importRound1();                                                     // idempotent
  const rv = g.rows_('reviews');
  assert.strictEqual(rv.length, 2);
  const t = rv.find(r => r.type === 'tri'), res = JSON.parse(t.result);
  assert.strictEqual(t.annotator, 'a01', 'same name → existing annotator');
  assert.deepStrictEqual(res.status, { S: 'ok', C: 'edit', U: 'redo' });
  assert.strictEqual(res.text.C, tp.C + ' ще');
  assert.strictEqual(res.why.U[0].reason, 'U не нейтральне');
  assert.match(res.comment, /U: Краще інакше/, 'a remark typed into the sentence cell is kept as a comment');
  assert.strictEqual(t.outcome, 'no'); assert.strictEqual(t.source, 'round1'); assert.strictEqual(t.position, 1);
  assert.strictEqual(rv.find(r => r.type === 'qa').answer, 2, 'letter A → the choice text → index 2');
  assert.strictEqual(rv.find(r => r.type === 'qa').annotator, 'r1-02');
  assert.ok(g.rows_('annotators').some(a => a.id === 'r1-02' && a.active === false && !a.token));
  // not counted: the item is still untouched for everyone else, but a01 does not get it again
  const d = call(tokens[1], 'dashboard');
  assert.strictEqual(d.totals.reviews, 0); assert.strictEqual(d.round1.reviews, 2);
  const seenByA = call(tokens[0], 'next', { mode: 'tri', count: 5 }).cards.map(c => c.item_id);
  assert.ok(!seenByA.includes(tri.item_id));
  assert.ok(!call(tokens[0], 'board').board.some(p => p.id.startsWith('r1-')));
});

test('planted check cards: generated, served, scored by sentence; gold candidates from round 1', () => {
  const { tokens, call, g } = boot(['Анна', 'Богдан']);
  assert.strictEqual(g.makePlantedGold(8), 8);
  const golds = g.rows_('items').filter(r => String(r.item_id).startsWith('GOLD-'));
  assert.strictEqual(golds.length, 8);
  assert.ok(golds.every(r => /^bad:[SCU]$/.test(r.gold) && JSON.parse(r.payload).chk));
  const chk = JSON.parse(Buffer.from(JSON.parse(golds[0].payload).chk, 'base64').toString('utf8'));
  assert.strictEqual('bad:' + chk.k, golds[0].gold);
  // planted cards survive a re-import of the dataset
  g.importWarBias();
  assert.strictEqual(g.rows_('items').filter(r => String(r.item_id).startsWith('GOLD-')).length, 8);
  // someone works through enough cards to be shown check cards
  let goldSeen = [];
  for (let k = 0; k < 12 && goldSeen.length < 2; k++) {
    const r = call(tokens[0], 'next', { mode: 'tri', count: 3 });
    const golds = r.cards.filter(c => c.item_id.startsWith('GOLD-'));
    goldSeen = goldSeen.concat(golds);
    call(tokens[0], 'submit', { reviews: r.cards.map(c => {
      if (!c.item_id.startsWith('GOLD-')) return review(c);
      const key = JSON.parse(Buffer.from(c.payload.chk, 'base64').toString('utf8')).k;
      const hit = goldSeen.length === 1;                       // catch the first, miss the second
      return review(c, 'no', { result: { status: { S: '', C: '', U: '', [hit ? key : (key === 'S' ? 'U' : 'S')]: 'redo' } } });
    }) });
  }
  assert.ok(goldSeen.length >= 2, 'check cards are served');
  const me = call(tokens[0], 'board').board.find(p => p.id === 'a01');
  assert.strictEqual(me.accuracy, 0.5, 'flagging the wrong sentence is a miss');
  // candidates: unanimous round-1 problem → bad
  const items = g.rows_('items').filter(r => r.type === 'tri' && !r.gold);
  const sh = g.ss_().getSheetByName('reviews');
  const r1 = (id, a, outcome, n) => [`r1:x:${n}`, '', '', a, id, 'tri', outcome, '', '', n, 'round1:x', '', '{}', false, '', '', 'round1'];
  sh.getRange(sh.getLastRow() + 1, 1, 2, 17).setValues([r1(items[0].item_id, 'r1-01', 'no', 1), r1(items[0].item_id, 'r1-02', 'no', 2)]);
  g.cache_().remove('rv2');
  assert.strictEqual(g.suggestGold(), 1);
  const cand = g.ss_().getSheetByName('gold_candidates');
  cand.getRange(2, 7).setValue(true);
  assert.strictEqual(g.applyGold(), 1);
  assert.strictEqual(g.rows_('items').find(r => r.item_id === items[0].item_id).gold, 'bad');
});

test('reviews carry the reviewer name next to the id; old rows get it on the next submit', () => {
  const { tokens, call, g } = boot();
  const c1 = call(tokens[0], 'next', { count: 1 }).cards[0];
  call(tokens[0], 'submit', { reviews: [review(c1)] });
  assert.strictEqual(g.rows_('reviews')[0].name, 'Анна');
  // an older sheet without the column: drop it, forget it was added, submit again
  const sh = g.ss_().getSheetByName('reviews');
  sh.rows.forEach(r => { r.length = 17; });           // a sheet from before the column existed
  g.PropertiesService.getScriptProperties().setProperty('RV_COLS', '17');
  const c2 = call(tokens[1], 'next', { count: 1 }).cards[0];
  call(tokens[1], 'submit', { reviews: [review(c2)] });
  const rows = g.rows_('reviews');
  assert.deepStrictEqual(rows.map(r => [r.annotator, r.name]), [['a01', 'Анна'], ['a02', 'Богдан']]);
});
