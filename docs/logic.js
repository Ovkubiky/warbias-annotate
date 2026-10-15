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
  batch: 3,                              // cards sent per request (client keeps a small queue)
  countRound1: false                     // do imported round-1 reviews count towards the targets above?
};

/** Imported round-1 reviews (src 'r1') count only when opts.countRound1; they always mark an item as seen. */
function counted(r, opts) { return !r.undone && (r.src !== 'r1' || !!(opts && opts.countRound1)); }

function hash32(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Aggregate live (not undone) reviews per item. */
function itemStats(reviews, opts) {
  var m = {};
  reviews.forEach(function (r) {
    if (!counted(r, opts)) return;
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
  var stats = itemStats(reviews, opts);
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
  var mine = reviews.filter(function (r) { return r.annotator === o.annotator && !r.undone && r.src !== 'r1'; }).length;
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
  var stats = itemStats(reviews, opts), seen = {}, out = { tri: 0, qa: 0, sev: 0, all: 0 };
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
  var stats = itemStats(reviews, opts), done = 0, total = 0;
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
    var p = by[r.annotator]; if (!p || r.undone || r.src === 'r1') return;   // round 1 earns no points
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

/**
 * Krippendorff's alpha. units: arrays of values given to the same item by different people
 * (units with fewer than 2 values are ignored). metric: 'nominal' or 'interval'.
 */
function krippAlpha(units, metric) {
  var pool = [], doSum = 0;
  var spread = function (vals) {            // sum of δ over ordered pairs i ≠ j
    var m = vals.length;
    if (metric === 'interval') {
      var s = 0, s2 = 0;
      vals.forEach(function (v) { s += v; s2 += v * v; });
      return 2 * m * s2 - 2 * s * s;
    }
    var c = {}, sq = 0;
    vals.forEach(function (v) { c[v] = (c[v] || 0) + 1; });
    Object.keys(c).forEach(function (k) { sq += c[k] * c[k]; });
    return m * m - sq;
  };
  units.forEach(function (u) {
    if (u.length < 2) return;
    doSum += spread(u) / (u.length - 1);
    pool = pool.concat(u);
  });
  var n = pool.length;
  if (n < 2) return null;
  var de = spread(pool) / (n - 1);
  return de === 0 ? null : 1 - doSum / de;
}

var POSITION_BUCKETS = [[1, 10], [11, 25], [26, 50], [51, 100], [101, Infinity]];

/** Agreement, flag rate by position in the session, reasons and edits for one set of live reviews. */
function qualityStats(live, typeOf, gold) {
  var reasons = {}, edits = 0, flags = 0, byItem = {};
  var pos = POSITION_BUCKETS.map(function (b) { return { from: b[0], to: b[1] === Infinity ? null : b[1], n: 0, flagged: 0 }; });
  live.forEach(function (r) {
    if (gold[r.item_id]) return;
    var res = r.result || {};
    if (res.text && Object.keys(res.text).length) edits++;
    Object.keys(res.why || {}).forEach(function (k) {
      (res.why[k] || []).forEach(function (it) { flags++; reasons[it.reason] = (reasons[it.reason] || 0) + 1; });
    });
    if (r.type !== 'sev' && +r.position > 0) {
      var b = pos.filter(function (x) { return +r.position >= x.from && (x.to === null || +r.position <= x.to); })[0];
      if (b) { b.n++; if (r.outcome === 'no') b.flagged++; }
    }
    (byItem[r.item_id] = byItem[r.item_id] || []).push(r);
  });
  var units = { tri: [], qa: [], sev: [] }, sevSplits = [];
  Object.keys(byItem).forEach(function (id) {
    var rs = byItem[id], t = typeOf[id];
    if (rs.length < 2) return;
    if (t === 'tri') units.tri.push(rs.map(function (r) { return r.outcome; }));
    if (t === 'qa') units.qa.push(rs.filter(function (r) { return r.answer !== '' && r.answer !== null && r.answer !== undefined; }).map(function (r) { return String(r.answer); }));
    if (t === 'sev') {
      var v = rs.map(function (r) { return +r.raw; });
      units.sev.push(v);
      var gap = Math.max.apply(null, v) - Math.min.apply(null, v);
      if (gap >= 0.4) sevSplits.push({ item_id: id, raws: v, gap: Math.round(gap * 100) / 100 });
    }
  });
  var alpha = {};
  Object.keys(units).forEach(function (t) {
    var a = krippAlpha(units[t], t === 'sev' ? 'interval' : 'nominal');
    alpha[t] = { value: a === null ? null : Math.round(a * 1000) / 1000, items: units[t].filter(function (u) { return u.length > 1; }).length };
  });
  return {
    reviews: live.filter(function (r) { return !gold[r.item_id]; }).length, edits: edits, flags: flags, alpha: alpha, position: pos,
    reasons: Object.keys(reasons).map(function (k) { return { reason: k, n: reasons[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 12),
    sevSplits: sevSplits.sort(function (a, b) { return b.gap - a.gap; }).slice(0, 30)
  };
}

/**
 * Everything the progress dashboard shows, from the same inputs as the rest of the logic.
 * reviews also carry: type, raw, position, dwell_ms, day, ts (ms), src ('r1' = imported round 1),
 * result ({status, text, why}). people: [{id, name, onboarded}]. Per-person details are under `admin`.
 * Round-1 reviews are summarised separately under `round1` unless opts.countRound1.
 */
function dashboardStats(items, reviews, people, opts) {
  opts = opts || LOGIC_DEFAULTS;
  var typeOf = {}, gold = {};
  items.forEach(function (it) { typeOf[it.item_id] = it.type; if (it.gold) gold[it.item_id] = it.gold; });
  reviews.forEach(function (r) { r.type = r.type || typeOf[r.item_id]; });
  var live = reviews.filter(function (r) { return counted(r, opts); });
  var r1 = reviews.filter(function (r) { return !r.undone && r.src === 'r1'; });
  var stats = itemStats(live, opts);

  var types = {};
  items.forEach(function (it) {
    if (it.gold) return;
    var t = types[it.type] || (types[it.type] = { total: 0, done: 0, third: 0, partial: 0, untouched: 0 });
    var s = stats[it.item_id], n = s ? s.n : 0, min = opts.minReviews[it.type] || 2;
    t.total++;
    if (!n) t.untouched++;
    else if (n >= targetReviews(it, s, opts)) t.done++;
    else if (n >= min) t.third++;
    else t.partial++;
  });

  var daily = {}, sevHist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  live.forEach(function (r) {
    if (gold[r.item_id]) return;
    if (r.day) { var d = daily[r.day] || (daily[r.day] = { day: r.day, tri: 0, qa: 0, sev: 0 }); d[r.type] = (d[r.type] || 0) + 1; }
    if (r.type === 'sev' && r.raw !== '' && r.raw !== null && r.raw !== undefined) sevHist[Math.min(9, Math.floor(+r.raw * 10))]++;
  });
  var q = qualityStats(live, typeOf, gold);

  var board = leaderboard(items, live, people), per = {};
  board.forEach(function (b) { per[b.id] = b; });
  var persons = people.map(function (p) {
    var mine = live.filter(function (r) { return r.annotator === p.id && !gold[r.item_id] && r.src !== 'r1'; });
    var judged = mine.filter(function (r) { return r.type !== 'sev'; });
    var dw = mine.map(function (r) { return +r.dwell_ms || 0; }).filter(Boolean).sort(function (a, b) { return a - b; });
    var days = mine.map(function (r) { return r.day; }).filter(Boolean).sort();
    return {
      id: p.id, name: p.name, onboarded: !!p.onboarded, cards: mine.length,
      days: Object.keys(days.reduce(function (m, d) { m[d] = 1; return m; }, {})).length,
      last: days.length ? days[days.length - 1] : null,
      flagRate: judged.length ? Math.round(judged.filter(function (r) { return r.outcome === 'no'; }).length / judged.length * 100) / 100 : null,
      edits: mine.filter(function (r) { return r.result && r.result.text && Object.keys(r.result.text).length; }).length,
      medianDwell: dw.length ? dw[Math.floor(dw.length / 2)] : null,
      accuracy: per[p.id] ? per[p.id].accuracy : null
    };
  }).filter(function (p) { return p.cards || String(p.id).indexOf('r1-') !== 0; }).sort(function (a, b) { return b.cards - a.cards; });

  var recent = live.filter(function (r) {
    var res = r.result || {};
    return r.src !== 'r1' && ((res.text && Object.keys(res.text).length) || (res.why && Object.keys(res.why).length));
  }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).slice(0, 40).map(function (r) {
    var res = r.result, fl = [];
    Object.keys(res.why || {}).forEach(function (k) {
      (res.why[k] || []).forEach(function (it) { fl.push({ k: k, frag: it.frag || null, reason: it.reason }); });
    });
    return { day: r.day, ts: r.ts || null, annotator: r.annotator, item_id: r.item_id, type: r.type, text: res.text || {}, flags: fl };
  });

  var out = {
    totals: { reviews: q.reviews, edits: q.edits, flags: q.flags,
      people: persons.filter(function (p) { return p.cards; }).length, team: teamProgress(items, live, opts) },
    types: types,
    daily: Object.keys(daily).sort().map(function (k) { return daily[k]; }),
    alpha: q.alpha, position: q.position, reasons: q.reasons, sevHist: sevHist,
    admin: { people: persons, recent: recent, sevSplits: q.sevSplits }
  };
  if (r1.length && !opts.countRound1) {
    var q1 = qualityStats(r1, typeOf, gold);
    out.round1 = { reviews: q1.reviews, edits: q1.edits, flags: q1.flags, alpha: q1.alpha, position: q1.position, reasons: q1.reasons,
      items: Object.keys(r1.reduce(function (m, r) { m[r.item_id] = 1; return m; }, {})).length };
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { LOGIC_DEFAULTS: LOGIC_DEFAULTS, hash32: hash32, itemStats: itemStats, targetReviews: targetReviews, pickNext: pickNext, remainingFor: remainingFor, teamProgress: teamProgress, leaderboard: leaderboard, streak: streak, krippAlpha: krippAlpha, dashboardStats: dashboardStats, counted: counted };
