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
  // imported round-1 reviews (src 'r1'): 'vote' = a unanimous accept by 2+ trusted people counts as one
  // review of a triplet, round-1 flags only move the triplet up the queue, QA answers count in full;
  // 'full' = every round-1 review counts; 'off' = kept for the dashboard only. They always mark an item as seen.
  round1Mode: 'vote'
};

/** Does this review count towards an item's targets? (Round-1 triplets in 'vote' mode are handled in itemStats.) */
function counted(r, opts) {
  if (r.undone) return false;
  if (r.src !== 'r1') return true;
  var mode = (opts && opts.round1Mode) || 'vote';
  return mode === 'full' || (mode === 'vote' && r.type === 'qa');
}

/** Sentence keys a review marked as wrong or edited, e.g. 'C' or 'SU'. */
function flaggedKeys(r) {
  if (r.fk !== undefined && r.fk !== null) return String(r.fk);
  var st = (r.result && r.result.status) || {};
  return Object.keys(st).filter(function (k) { return st[k] === 'redo' || st[k] === 'edit'; }).sort().join('');
}

/** Was a hidden check item answered right? gold: 'ok' | 'bad' | 'bad:C' (a planted error in sentence C). */
function goldRight(gold, r) {
  var g = String(gold).split(':');
  if (g[0] === 'ok') return r.outcome === 'yes';
  if (g[1]) return flaggedKeys(r).indexOf(g[1]) >= 0;
  return r.outcome === 'no';
}

function hash32(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Aggregate live (not undone) reviews per item. */
function itemStats(reviews, opts) {
  var m = {}, get = function (id) { return m[id] || (m[id] = { n: 0, neg: 0, by: {}, answers: {} }); };
  reviews.forEach(function (r) {
    if (!counted(r, opts)) return;
    var s = get(r.item_id);
    s.n++;
    if (r.outcome === 'no') s.neg++;
    s.by[r.annotator] = true;
    if (r.answer !== '' && r.answer !== null && r.answer !== undefined) s.answers[String(r.answer)] = true;
  });
  if (((opts && opts.round1Mode) || 'vote') === 'vote') round1Votes(reviews, get);
  return m;
}

/**
 * Round-1 triplets in 'vote' mode. Someone who accepted everything (50+ triplets, no flags) is not trusted.
 * 2+ trusted, unanimous accepts → one virtual 'yes' review; any round-1 flag → r1flag (asked first, no vote).
 */
function round1Votes(reviews, get) {
  var per = {}, items = {};
  reviews.forEach(function (r) {
    if (r.src !== 'r1' || r.undone || r.type !== 'tri') return;
    var p = per[r.annotator] || (per[r.annotator] = { n: 0, flags: 0 });
    p.n++; if (r.outcome === 'no') p.flags++;
    (items[r.item_id] = items[r.item_id] || []).push(r);
  });
  var trusted = function (a) { return !(per[a].n >= 50 && per[a].flags === 0); };
  Object.keys(items).forEach(function (id) {
    var rs = items[id];
    if (rs.some(function (r) { return r.outcome === 'no'; })) { get(id).r1flag = true; return; }
    if (rs.filter(function (r) { return trusted(r.annotator); }).length >= 2) { var s = get(id); s.n++; s.r1vote = true; }
  });
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
    // 0: disputed item waiting for its tie-breaker; 1: one review away from done, or someone in round 1 saw a
    // problem — mixed in one band, so items get finished while flagged ones are not left waiting; 2: untouched
    var prio = n >= min ? 0 : ((s && s.r1flag) || n === min - 1 ? 1 : 2);
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
      if (goldRight(gold[r.item_id], r)) p.goldRight++;
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
 * Quality numbers use this round's reviews only; round 1 is summarised under `round1`.
 */
function dashboardStats(items, reviews, people, opts) {
  opts = opts || LOGIC_DEFAULTS;
  var typeOf = {}, gold = {};
  items.forEach(function (it) { typeOf[it.item_id] = it.type; if (it.gold) gold[it.item_id] = it.gold; });
  reviews.forEach(function (r) { r.type = r.type || typeOf[r.item_id]; });
  var live = reviews.filter(function (r) { return !r.undone && r.src !== 'r1'; });
  var r1 = reviews.filter(function (r) { return !r.undone && r.src === 'r1'; });
  var stats = itemStats(reviews, opts);

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
      people: persons.filter(function (p) { return p.cards; }).length, team: teamProgress(items, reviews, opts) },
    types: types,
    daily: Object.keys(daily).sort().map(function (k) { return daily[k]; }),
    alpha: q.alpha, position: q.position, reasons: q.reasons, sevHist: sevHist,
    admin: { people: persons, recent: recent, sevSplits: q.sevSplits }
  };
  var key = opts.qaKey || {}, qk = live.filter(function (r) { return r.type === 'qa' && key[r.item_id] !== undefined && r.answer !== '' && r.answer !== null && !gold[r.item_id]; });
  out.qaAccuracy = { n: qk.length, right: qk.filter(function (r) { return +r.answer === +key[r.item_id]; }).length };
  if (r1.length) {
    var q1 = qualityStats(r1, typeOf, gold);
    // is a round-1 unanimous accept worth one vote? fresh reviews on those triplets should rarely find a problem
    var onVoted = live.filter(function (r) { return r.type === 'tri' && stats[r.item_id] && stats[r.item_id].r1vote; });
    out.round1 = { mode: opts.round1Mode || 'vote', reviews: q1.reviews, edits: q1.edits, flags: q1.flags, alpha: q1.alpha,
      position: q1.position, reasons: q1.reasons,
      items: Object.keys(r1.reduce(function (m, r) { m[r.item_id] = 1; return m; }, {})).length,
      voted: Object.keys(stats).filter(function (k) { return stats[k].r1vote; }).length,
      flagged: Object.keys(stats).filter(function (k) { return stats[k].r1flag; }).length,
      check: { n: onVoted.length, flagged: onVoted.filter(function (r) { return r.outcome === 'no'; }).length } };
    var rep = round1Report(r1, items, opts.qaKey || {});
    Object.keys(rep).forEach(function (k) { if (k !== 'people') out.round1[k] = rep[k]; });
    out.admin.round1People = rep.people.map(function (v) {
      var p = people.filter(function (x) { return x.id === v.id; })[0];
      v.name = p ? p.name : v.id; return v;
    });
  }
  return out;
}

/**
 * What round 1 says about the data and the people: consensus per triplet, which sentence was flagged,
 * flag rate by group and topic, QA answers against the dataset key, and per volunteer: flag rate early vs
 * late in their sheet, how often others confirmed their flags, QA accuracy. items may carry actor/section.
 */
function round1Report(r1, items, qaKey) {
  var meta = {}, gold = {};
  items.forEach(function (it) { meta[it.item_id] = it; if (it.gold) gold[it.item_id] = 1; });
  var tri = r1.filter(function (r) { return r.type === 'tri' && !gold[r.item_id]; });
  var qa = r1.filter(function (r) { return r.type === 'qa'; });
  var byItem = {};
  tri.forEach(function (r) { (byItem[r.item_id] = byItem[r.item_id] || []).push(r); });

  var consensus = { accept: 0, split: 0, problem: 0, single: 0 }, pairs = 0, agree = 0;
  Object.keys(byItem).forEach(function (id) {
    var rs = byItem[id], bad = rs.filter(function (r) { return r.outcome === 'no'; }).length;
    if (rs.length < 2) consensus.single++;
    else if (!bad) consensus.accept++;
    else if (bad === rs.length) consensus.problem++;
    else consensus.split++;
    for (var i = 0; i < rs.length; i++) for (var j = i + 1; j < rs.length; j++) { pairs++; if (rs[i].outcome === rs[j].outcome) agree++; }
  });

  var sentences = { S: { redo: 0, edit: 0 }, C: { redo: 0, edit: 0 }, U: { redo: 0, edit: 0 } }, comments = 0;
  var group = function (key) {
    var m = {};
    tri.forEach(function (r) {
      var k = (meta[r.item_id] || {})[key] || '—', g = m[k] || (m[k] = { name: k, n: 0, flagged: 0 });
      g.n++; if (r.outcome === 'no') g.flagged++;
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.n - a.n; });
  };
  // round-1 remarks are free text: sort them into rough themes by keywords (a remark can hit several)
  var THEMES = [
    ['C — просто заперечення S', /(просто заперечення|як заперечення|пряме заперечення|пряму? й чітку|пряму заперечн)/i],
    ['C не заперечує S', /(не заперечу|не спростов|не стосується|не до кінця стосується|не збіга|не відповідає s|контр?с?т?ереоти)/i],
    ['Пропозиція переписати', /(краще написати|краще так|обійтися без|прибрати|забрати|натомість|перебудувати|змінено|підправив|додав)/i],
    ['Порядок слів', /(порядок слів|порядку слів|переставити|підрядн|неусталеному порядку)/i],
    ['Треба конкретизувати', /(конкретиз|коерктиз|уточнити|окреслити|про які саме|мається на увазі)/i],
    ['Неприродно, повтори', /(неприродн|звучить|формулюв|складно|тавтолог|громіздк|калька|стилістичн|повтор|зайв)/i],
    ['Вибір слова, терміни', /(замінити|слово|термін|війн|конфлікт)/i],
    ['Граматика, правопис', /(граматич|помилк|правопис|відмін|узгодж|описк)/i],
    ['Узагальнення, новий стереотип', /(узагальн|два стереотипи|новий стереотип|натяк|упередж|забарвлення|зневажлив)/i]
  ];
  var themes = {};
  THEMES.forEach(function (t) { themes[t[0]] = 0; }); themes['Інше'] = 0;
  tri.forEach(function (r) {
    var st = (r.result && r.result.status) || {};
    ['S', 'C', 'U'].forEach(function (k) { if (st[k] === 'redo' || st[k] === 'edit') sentences[k][st[k]]++; });
    var c = r.result && r.result.comment;
    if (!c) return;
    comments++;
    var hit = THEMES.filter(function (t) { return t[1].test(c); });
    hit.forEach(function (t) { themes[t[0]]++; });
    if (!hit.length) themes['Інше']++;
  });

  var qaItems = {}, qaRight = 0, qaKeyed = 0, qaPairs = 0, qaAgree = 0;
  qa.forEach(function (r) {
    (qaItems[r.item_id] = qaItems[r.item_id] || []).push(r);
    var k = qaKey[r.item_id];
    if (k !== undefined && r.answer !== '' && r.answer !== null) { qaKeyed++; if (+r.answer === +k) qaRight++; }
  });
  Object.keys(qaItems).forEach(function (id) {
    var rs = qaItems[id];
    for (var i = 0; i < rs.length; i++) for (var j = i + 1; j < rs.length; j++) { qaPairs++; if (String(rs[i].answer) === String(rs[j].answer)) qaAgree++; }
  });

  var per = {};
  r1.forEach(function (r) {
    var v = per[r.annotator] || (per[r.annotator] = { id: r.annotator, tri: 0, flags: 0, edits: 0, comments: 0, confirmed: 0, others: 0,
      early: [0, 0], late: [0, 0], qa: 0, qaRight: 0, qaKeyed: 0, positions: [] });
    if (r.type === 'qa') {
      v.qa++;
      var k = qaKey[r.item_id];
      if (k !== undefined && r.answer !== '' && r.answer !== null) { v.qaKeyed++; if (+r.answer === +k) v.qaRight++; }
      return;
    }
    if (gold[r.item_id]) return;
    v.tri++; v.positions.push([+r.position || 0, r.outcome === 'no']);
    if (r.result && r.result.text && Object.keys(r.result.text).length) v.edits++;
    if (r.result && r.result.comment) v.comments++;
    if (r.outcome === 'no') {
      v.flags++;
      (byItem[r.item_id] || []).forEach(function (o) { if (o !== r) { v.others++; if (o.outcome === 'no') v.confirmed++; } });
    }
  });
  var people = Object.keys(per).map(function (id) {
    var v = per[id], ps = v.positions.sort(function (a, b) { return a[0] - b[0]; }), half = Math.ceil(ps.length / 2);
    ps.forEach(function (x, i) { var h = i < half ? v.early : v.late; h[0]++; if (x[1]) h[1]++; });
    var rate = function (h) { return h[0] ? Math.round(h[1] / h[0] * 1000) / 1000 : null; };
    return { id: id, tri: v.tri, flagRate: v.tri ? Math.round(v.flags / v.tri * 1000) / 1000 : null, edits: v.edits, comments: v.comments,
      confirmed: v.confirmed, others: v.others, trusted: !(v.tri >= 50 && v.flags === 0),
      early: rate(v.early), late: rate(v.late), qa: v.qa, qaAcc: v.qaKeyed ? Math.round(v.qaRight / v.qaKeyed * 1000) / 1000 : null };
  }).sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });

  var early = [0, 0], late = [0, 0];
  people.forEach(function (p) { var v = per[p.id]; early[0] += v.early[0]; early[1] += v.early[1]; late[0] += v.late[0]; late[1] += v.late[1]; });
  return {
    volunteers: people.length, triItems: Object.keys(byItem).length, qaItems: Object.keys(qaItems).length,
    rawAgree: pairs ? Math.round(agree / pairs * 1000) / 1000 : null, flagRate: tri.length ? Math.round(tri.filter(function (r) { return r.outcome === 'no'; }).length / tri.length * 1000) / 1000 : null,
    consensus: consensus, sentences: sentences, comments: comments,
    themes: Object.keys(themes).map(function (k) { return { theme: k, n: themes[k] }; }).sort(function (a, b) { return b.n - a.n; }),
    halves: { early: early[0] ? early[1] / early[0] : null, late: late[0] ? late[1] / late[0] : null },
    byActor: group('actor'), bySection: group('section').slice(0, 12),
    qa: { reviews: qa.length, agree: qaPairs ? Math.round(qaAgree / qaPairs * 1000) / 1000 : null,
      accuracy: qaKeyed ? Math.round(qaRight / qaKeyed * 1000) / 1000 : null, keyed: qaKeyed },
    people: people
  };
}

/**
 * A triplet with one planted error, for hidden check cards. kind:
 *  'neutral'  C is replaced by the triplet's own neutral U — C no longer contradicts S;
 *  'other_c'  C is the counter-sentence of another stereotype;
 *  'stereo_u' U is replaced by another stereotype about the same group;
 *  'typo'     two letters swapped inside a long word.
 * Returns {payload, key, msg}; the hint travels with the card (lightly encoded) so feedback works offline.
 */
var PLANT_KINDS = ['neutral', 'other_c', 'stereo_u', 'typo'];
function plantGold(p, donor, kind, seed) {
  var q = {};
  Object.keys(p).forEach(function (k) { q[k] = p[k]; });
  var key, msg;
  if (kind === 'neutral') {
    key = 'C'; q.C = p.U; q.eC = p.eU || '';
    msg = 'C тут — нейтральний факт, а не заперечення стереотипу. Такий C треба позначати ✕.';
  } else if (kind === 'other_c') {
    key = 'C'; q.C = donor.C; q.eC = donor.eC || '';
    msg = 'C заперечує інший стереотип, а не той, що в S.';
  } else if (kind === 'stereo_u') {
    key = 'U'; q.U = donor.S; q.eU = donor.eS || '';
    msg = 'U тут — стереотип, а не нейтральне речення.';
  } else {
    var keys = ['S', 'C', 'U'];
    for (var t = 0; t < 3 && !msg; t++) {
      key = keys[(seed + t) % 3];
      var words = String(p[key]).split(' '), long = [];
      words.forEach(function (w, i) { if (/^[А-Яа-яІіЇїЄєҐґ'’]{7,}$/.test(w)) long.push(i); });
      if (!long.length) continue;
      var wi = long[seed % long.length], w = words[wi], j = 2 + seed % (w.length - 4);
      if (w[j] === w[j + 1]) j = (j + 1) % (w.length - 3) + 1;
      var bad = w.slice(0, j) + w[j + 1] + w[j] + w.slice(j + 2);
      if (bad === w) continue;
      words[wi] = bad; q[key] = words.join(' ');
      msg = 'У ' + key + ' навмисна описка: «' + bad + '» замість «' + w + '».';
    }
    if (!msg) return plantGold(p, donor, 'neutral', seed);
  }
  return { payload: q, key: key, msg: msg };
}

if (typeof module !== 'undefined') module.exports = { LOGIC_DEFAULTS: LOGIC_DEFAULTS, hash32: hash32, itemStats: itemStats, targetReviews: targetReviews, pickNext: pickNext, remainingFor: remainingFor, teamProgress: teamProgress, leaderboard: leaderboard, streak: streak, krippAlpha: krippAlpha, dashboardStats: dashboardStats, counted: counted, flaggedKeys: flaggedKeys, goldRight: goldRight, plantGold: plantGold, PLANT_KINDS: PLANT_KINDS, round1Report: round1Report };
