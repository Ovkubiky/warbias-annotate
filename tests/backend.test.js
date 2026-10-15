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
  g.cache_().remove('rv');                     // force a rebuild from the sheet
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
  g.cache_().remove('rv');
  const card = call(tokens[1], 'next', { count: 1 }).cards[0];
  call(tokens[1], 'submit', { reviews: [review(card)] });
  assert.strictEqual(g.rows_('reviews')[0].edits, 'C: Стара правка.');
});
