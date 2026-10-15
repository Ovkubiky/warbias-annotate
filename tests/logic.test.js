const test = require('node:test');
const assert = require('node:assert');
const L = require('../apps-script/Logic.js');

const items = [
  ...Array.from({ length: 6 }, (_, i) => ({ item_id: 'T' + i, type: 'tri', gold: '' })),
  { item_id: 'Q0', type: 'qa', gold: '' },
  { item_id: 'S0', type: 'sev', gold: '' },
];
const rv = (item_id, annotator, outcome = 'yes', answer = '') => ({ item_id, annotator, outcome, answer, undone: false });

test('never gives a card the person already reviewed', () => {
  const reviews = [rv('T0', 'a'), rv('T1', 'a')];
  const got = L.pickNext(items, reviews, {}, { annotator: 'a', mode: 'all', count: 10 });
  assert.ok(!got.some(i => i.item_id === 'T0' || i.item_id === 'T1'));
});

test('undone reviews still count as seen but not as reviews', () => {
  const reviews = [{ ...rv('T0', 'a'), undone: true }];
  const got = L.pickNext(items, reviews, {}, { annotator: 'a', mode: 'all', count: 10 });
  assert.ok(!got.some(i => i.item_id === 'T0'));
  assert.strictEqual(L.itemStats(reviews).T0, undefined);
});

test('item with 2 positive reviews is finished', () => {
  const reviews = [rv('T0', 'a'), rv('T0', 'b')];
  const got = L.pickNext(items, reviews, {}, { annotator: 'c', mode: 'tri', count: 10 });
  assert.ok(!got.some(i => i.item_id === 'T0'));
});

test('one negative review out of 2 asks for a third opinion, first in line', () => {
  const reviews = [rv('T3', 'a'), rv('T3', 'b', 'no')];
  const got = L.pickNext(items, reviews, {}, { annotator: 'c', mode: 'tri', count: 1 });
  assert.strictEqual(got[0].item_id, 'T3');
  const reviews3 = [...reviews, rv('T3', 'c')];
  const got3 = L.pickNext(items, reviews3, {}, { annotator: 'd', mode: 'tri', count: 10 });
  assert.ok(!got3.some(i => i.item_id === 'T3'), 'no 4th review');
});

test('QA answers that disagree also trigger a third opinion', () => {
  const reviews = [rv('Q0', 'a', 'yes', 0), rv('Q0', 'b', 'yes', 2)];
  const got = L.pickNext(items, reviews, {}, { annotator: 'c', mode: 'qa', count: 1 });
  assert.strictEqual(got[0].item_id, 'Q0');
});

test('severity never gets a third vote', () => {
  const reviews = [rv('S0', 'a'), rv('S0', 'b', 'no')];
  const got = L.pickNext(items, reviews, {}, { annotator: 'c', mode: 'sev', count: 10 });
  assert.strictEqual(got.length, 0);
});

test('half-done items come before untouched ones', () => {
  const reviews = [rv('T5', 'a')];
  const got = L.pickNext(items, reviews, {}, { annotator: 'b', mode: 'tri', count: 1 });
  assert.strictEqual(got[0].item_id, 'T5');
});

test('active leases stop over-assignment, expired ones do not', () => {
  const now = Date.now();
  const reviews = [rv('T0', 'a')];
  const leases = { T0: [{ a: 'b', exp: now + 60000 }] };
  const got = L.pickNext(items, reviews, leases, { annotator: 'c', mode: 'tri', count: 10, now });
  assert.ok(!got.some(i => i.item_id === 'T0'), 'T0 already has its 2nd reviewer in progress');
  const expired = { T0: [{ a: 'b', exp: now - 1 }] };
  const got2 = L.pickNext(items, reviews, expired, { annotator: 'c', mode: 'tri', count: 10, now });
  assert.ok(got2.some(i => i.item_id === 'T0'));
});

test('different people get different orders', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ item_id: 'X' + i, type: 'tri', gold: '' }));
  const a = L.pickNext(many, [], {}, { annotator: 'anna', mode: 'tri', count: 10 }).map(i => i.item_id);
  const b = L.pickNext(many, [], {}, { annotator: 'bohdan', mode: 'tri', count: 10 }).map(i => i.item_id);
  assert.notDeepStrictEqual(a, b);
});

test('mode filter', () => {
  const got = L.pickNext(items, [], {}, { annotator: 'a', mode: 'sev', count: 10 });
  assert.deepStrictEqual(got.map(i => i.type), ['sev']);
});

test('gold items are injected about once per goldEvery cards and never twice to the same person', () => {
  const its = [...items, { item_id: 'G0', type: 'tri', gold: 'bad' }];
  const opts = { ...L.LOGIC_DEFAULTS, goldEvery: 4 };
  let reviews = [], goldCount = 0;
  for (let k = 0; k < 7; k++) {
    const got = L.pickNext(its, reviews, {}, { annotator: 'a', mode: 'tri', count: 1 }, opts);
    if (!got.length) break;
    if (got[0].gold) goldCount++;
    reviews.push(rv(got[0].item_id, 'a'));
  }
  assert.strictEqual(goldCount, 1);
});

test('remaining and team progress add up', () => {
  const reviews = [rv('T0', 'a'), rv('T0', 'b'), rv('T1', 'a')];
  const rem = L.remainingFor(items, reviews, 'a');
  assert.strictEqual(rem.all, rem.tri + rem.qa + rem.sev);
  assert.strictEqual(rem.tri, 4);
  assert.deepStrictEqual(L.teamProgress(items, reviews), { done: 1, total: 8 });
});

test('leaderboard: score = cards × gold accuracy, tickets need 80%', () => {
  const its = [...items, { item_id: 'G0', type: 'tri', gold: 'bad' }, { item_id: 'G1', type: 'tri', gold: 'ok' }];
  const reviews = [
    ...Array.from({ length: 100 }, (_, i) => rv('Z' + i, 'a')),
    rv('G0', 'a', 'yes'), rv('G1', 'a', 'yes'), // 1 of 2 right
    ...Array.from({ length: 60 }, (_, i) => rv('Y' + i, 'b')),
  ];
  const lb = L.leaderboard(its, reviews, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const A = lb.find(p => p.id === 'a'), B = lb.find(p => p.id === 'b');
  assert.strictEqual(A.score, 50); assert.strictEqual(A.tickets, 0);
  assert.strictEqual(B.score, 60); assert.strictEqual(B.tickets, 1);
  assert.strictEqual(lb[0].id, 'b');
});

test('streak counts consecutive days ending at the last active day', () => {
  assert.strictEqual(L.streak(['2026-10-10', '2026-10-12', '2026-10-13', '2026-10-11']), 4);
  assert.strictEqual(L.streak(['2026-10-01', '2026-10-13']), 1);
});

test('Krippendorff alpha: hand-checked nominal and interval values', () => {
  const L = require('../apps-script/Logic.js');
  assert.strictEqual(L.krippAlpha([['a', 'a'], ['b', 'b']], 'nominal'), 1);
  // coincidences o11=2, o22=2, o12=o21=1 → α = 1 − 5·2/18
  assert.ok(Math.abs(L.krippAlpha([[1, 1], [2, 2], [1, 2]], 'nominal') - (1 - 10 / 18)) < 1e-9);
  assert.ok(L.krippAlpha([[0.1, 0.15], [0.8, 0.85], [0.5, 0.45]], 'interval') > 0.95);
  assert.strictEqual(L.krippAlpha([['a']], 'nominal'), null);
});

test('dashboard: progress bands, position buckets, reasons, edits', () => {
  const L = require('../apps-script/Logic.js');
  const items = [
    { item_id: 't1', type: 'tri' }, { item_id: 't2', type: 'tri' }, { item_id: 't3', type: 'tri' }, { item_id: 't4', type: 'tri' },
    { item_id: 's1', type: 'sev' }, { item_id: 'g1', type: 'tri', gold: 'ok' }
  ];
  const r = (a, id, outcome, extra = {}) => ({ annotator: a, item_id: id, outcome, answer: '', day: '2026-10-15', position: 1, ...extra });
  const reviews = [
    r('a', 't1', 'yes'), r('b', 't1', 'yes'),                                 // done
    r('a', 't2', 'no', { position: 30, result: { why: { C: [{ frag: 'x', reason: 'Трійка непаралельна' }] } } }),
    r('b', 't2', 'yes'),                                                      // waiting for a 3rd opinion
    r('a', 't3', 'no', { result: { text: { S: 'нове' } } }),                  // one review
    r('a', 's1', 'yes', { raw: 0.1 }), r('b', 's1', 'yes', { raw: 0.9 }),
    r('a', 'g1', 'yes'), r('b', 't4', 'yes', { undone: true })
  ];
  const d = L.dashboardStats(items, reviews, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  assert.deepStrictEqual(d.types.tri, { total: 4, done: 1, third: 1, partial: 1, untouched: 1 });
  assert.strictEqual(d.totals.reviews, 7);
  assert.strictEqual(d.totals.edits, 1);
  assert.deepStrictEqual(d.reasons, [{ reason: 'Трійка непаралельна', n: 1 }]);
  assert.deepStrictEqual(d.position.map(b => [b.n, b.flagged]).slice(0, 3), [[4, 1], [0, 0], [1, 1]]);
  assert.strictEqual(d.admin.sevSplits[0].item_id, 's1');
  assert.strictEqual(d.admin.people.find(p => p.id === 'a').cards, 4);
  assert.strictEqual(d.admin.recent.length, 2);
});

test('round 1 vote: unanimous trusted accepts = one review, any flag = first in line, accept-all people ignored', () => {
  const L = require('../apps-script/Logic.js');
  const items = ['A', 'B', 'C', 'D'].map(id => ({ item_id: id, type: 'tri', gold: '' }));
  const r1 = (id, a, outcome) => ({ item_id: id, annotator: a, outcome, answer: '', src: 'r1', type: 'tri', undone: false });
  const reviews = [r1('A', 'p', 'yes'), r1('A', 'q', 'yes'), r1('B', 'p', 'yes'), r1('B', 'q', 'no'), r1('C', 'p', 'yes'), r1('C', 'lazy', 'yes')];
  for (let i = 0; i < 60; i++) reviews.push(r1('X' + i, 'lazy', 'yes'));          // never flags anything
  reviews.push(r1('X0', 'q', 'no'));
  const s = L.itemStats(reviews, L.LOGIC_DEFAULTS);
  assert.strictEqual(s.A.n, 1); assert.ok(s.A.r1vote);
  assert.ok(s.B.r1flag); assert.strictEqual(s.B.n, 0);
  assert.ok(!s.C || !s.C.r1vote, 'a vote needs 2 trusted people');
  const order = L.pickNext(items, reviews, {}, { annotator: 'new', count: 4 }).map(i => i.item_id);
  assert.strictEqual(order[0], 'B', 'round-1 flag goes first');
  assert.ok(order.indexOf('A') < order.indexOf('D'), 'one review away before untouched');
  assert.strictEqual(L.itemStats(reviews, { ...L.LOGIC_DEFAULTS, round1Mode: 'off' }).A, undefined);
});

test('planted errors: scored by the sentence, generator changes exactly that sentence', () => {
  const L = require('../apps-script/Logic.js');
  assert.ok(L.goldRight('bad:C', { outcome: 'no', result: { status: { S: '', C: 'redo', U: '' } } }));
  assert.ok(!L.goldRight('bad:C', { outcome: 'no', result: { status: { S: 'redo', C: '', U: '' } } }), 'flagging another sentence is a miss');
  assert.ok(L.goldRight('bad:U', { outcome: 'no', fk: 'SU' }));
  assert.ok(L.goldRight('ok', { outcome: 'yes' }));
  const p = { S: 'Ветерани агресивно реагують на зауваження.', C: 'Ветерани по-різному реагують на зауваження.', U: 'Ветерани заварюють собі чай на кухні.' };
  const d = { S: 'Ветерани постійно скаржаться.', C: 'Ветерани скаржаться не частіше за інших.', U: 'Ветерани гуляють.' };
  for (const kind of L.PLANT_KINDS) {
    const g = L.plantGold(p, d, kind, 12345);
    const changed = ['S', 'C', 'U'].filter(k => g.payload[k] !== p[k]);
    assert.deepStrictEqual(changed, [g.key], kind);
    assert.ok(g.msg.length > 10);
  }
  assert.strictEqual(L.plantGold(p, d, 'neutral', 1).payload.C, p.U);
});
