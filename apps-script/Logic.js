/**
 * Pure assignment and scoring logic. No Google APIs here, so the same file
 * runs in Apps Script, in the browser (mock mode) and in Node tests.
 * scripts/sync-logic.sh copies it to docs/logic.js.
 */

var LOGIC_DEFAULTS = {
  minReviews: { tri: 2, qa: 2, sev: 2 }, // independent reviews every item gets
  maxReviews: 3,                         // a disputed item gets one extra opinion, no more
  goldEvery: 10,                         // roughly one hidden check item per this many cards
  leaseMinutes: 20,                      // how long a handed-out card is reserved for one person
  batch: 3                               // cards sent per request (client keeps a small queue)
};

function hash32(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Aggregate live (not undone) reviews per item. */
function itemStats(reviews) {
  var m = {};
  reviews.forEach(function (r) {
    if (r.undone) return;
    var s = m[r.item_id] || (m[r.item_id] = { n: 0, neg: 0, by: {}, answers: {} });
    s.n++;
    if (r.outcome === 'no') s.neg++;
    s.by[r.annotator] = true;
    if (r.answer !== '' && r.answer !== null && r.answer !== undefined) s.answers[String(r.answer)] = true;
  });
  return m;
}

/** How many reviews this item should end up with, given what it has so far. */
function targetReviews(item, s, opts) {
  var min = opts.minReviews[item.type] || 2;
  if (!s || s.n < min) return min;
  if (item.type === 'sev') return min;                 // severity disagreements go to discussion, not a 3rd vote
  var disputed = s.neg > 0 || Object.keys(s.answers).length > 1;
  return disputed ? Math.max(min, opts.maxReviews) : min;
}

/**
 * Choose the next cards for one annotator.
 * items:   [{item_id, type, gold}]   gold: '' | 'ok' | 'bad'
 * reviews: [{item_id, annotator, outcome, answer, undone}]
 * leases:  {item_id: [{a, exp}]}     cards currently handed to someone
 * o:       {annotator, mode, count, exclude: [ids], now}
 */
function pickNext(items, reviews, leases, o, opts) {
  opts = opts || LOGIC_DEFAULTS;
  var stats = itemStats(reviews);
  var seen = {};
  reviews.forEach(function (r) { if (r.annotator === o.annotator) seen[r.item_id] = true; });
  var excl = {};
  (o.exclude || []).forEach(function (id) { excl[id] = true; });
  var now = o.now || Date.now();
  var ok = function (it) {
    return (o.mode === 'all' || !o.mode || it.type === o.mode) && !seen[it.item_id] && !excl[it.item_id];
  };

  var pool = [];
  items.forEach(function (it) {
    if (it.gold || !ok(it)) return;
    var s = stats[it.item_id], n = s ? s.n : 0;
    var target = targetReviews(it, s, opts);
    var leased = (leases[it.item_id] || []).filter(function (l) { return l.exp > now && l.a !== o.annotator; }).length;
    if (n + leased >= target) return;
    var min = opts.minReviews[it.type] || 2;
    // 0: disputed item waiting for its tie-breaker, 1: one review away from done, 2: untouched
    var prio = n >= min ? 0 : (n === min - 1 ? 1 : 2);
    pool.push({ it: it, prio: prio, r: hash32(o.annotator + '|' + it.item_id) });
  });
  // personal random order inside each priority band: no two people walk the data in the same order
  pool.sort(function (a, b) { return a.prio - b.prio || a.r - b.r; });
  var out = pool.slice(0, o.count || opts.batch).map(function (p) { return p.it; });

  // hidden check items
  var mine = reviews.filter(function (r) { return r.annotator === o.annotator && !r.undone; }).length;
  var golds = items.filter(function (it) { return it.gold && ok(it); });
  if (golds.length && out.length && (mine % opts.goldEvery) >= opts.goldEvery - out.length) {
    var g = golds[hash32(o.annotator + '|gold|' + mine) % golds.length];
    // insert inside the returned window so trimming never drops it
    out.splice(hash32(o.annotator + '|pos|' + mine) % out.length, 0, g);
    out = out.slice(0, o.count || opts.batch);
  }
  return out;
}

/** Cards this annotator could still be given, per type (for the mode menu). */
function remainingFor(items, reviews, annotator, opts) {
  opts = opts || LOGIC_DEFAULTS;
  var stats = itemStats(reviews), seen = {}, out = { tri: 0, qa: 0, sev: 0, all: 0 };
  reviews.forEach(function (r) { if (r.annotator === annotator) seen[r.item_id] = true; });
  items.forEach(function (it) {
    if (it.gold || seen[it.item_id]) return;
    var s = stats[it.item_id];
    if ((s ? s.n : 0) >= targetReviews(it, s, opts)) return;
    out[it.type] = (out[it.type] || 0) + 1; out.all++;
  });
  return out;
}

/** Share of items that have all the reviews they need. */
function teamProgress(items, reviews, opts) {
  opts = opts || LOGIC_DEFAULTS;
  var stats = itemStats(reviews), done = 0, total = 0;
  items.forEach(function (it) {
    if (it.gold) return;
    total++;
    var s = stats[it.item_id];
    if (s && s.n >= targetReviews(it, s, opts)) done++;
  });
  return { done: done, total: total };
}

/** Per-annotator score: cards × accuracy on hidden check items. */
function leaderboard(items, reviews, annotators) {
  var gold = {};
  items.forEach(function (it) { if (it.gold) gold[it.item_id] = it.gold; });
  var by = {};
  annotators.forEach(function (a) { by[a.id] = { id: a.id, name: a.name, cards: 0, goldSeen: 0, goldRight: 0, days: {} }; });
  reviews.forEach(function (r) {
    var p = by[r.annotator]; if (!p || r.undone) return;
    if (gold[r.item_id]) {
      p.goldSeen++;
      if ((gold[r.item_id] === 'ok') === (r.outcome === 'yes')) p.goldRight++;
    } else p.cards++;
    if (r.day) p.days[r.day] = true;
  });
  return Object.keys(by).map(function (k) {
    var p = by[k];
    var acc = p.goldSeen ? p.goldRight / p.goldSeen : null;
    return {
      id: p.id, name: p.name, cards: p.cards, accuracy: acc,
      score: Math.round(p.cards * (acc === null ? 1 : acc)),
      tickets: (acc === null || acc >= 0.8) ? Math.floor(p.cards / 50) : 0,
      streak: streak(Object.keys(p.days))
    };
  }).sort(function (a, b) { return b.score - a.score; });
}

/** Consecutive days up to the latest active day. days: ['2026-10-13', ...] */
function streak(days) {
  if (!days.length) return 0;
  days.sort();
  var n = 1;
  for (var i = days.length - 1; i > 0; i--) {
    var a = Date.parse(days[i - 1] + 'T00:00:00Z'), b = Date.parse(days[i] + 'T00:00:00Z');
    if (b - a === 86400000) n++; else break;
  }
  return n;
}

if (typeof module !== 'undefined') module.exports = { LOGIC_DEFAULTS: LOGIC_DEFAULTS, hash32: hash32, itemStats: itemStats, targetReviews: targetReviews, pickNext: pickNext, remainingFor: remainingFor, teamProgress: teamProgress, leaderboard: leaderboard, streak: streak };
