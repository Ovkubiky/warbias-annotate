/* Two interchangeable backends with the same calls:
 *  - RemoteApi talks to the Apps Script web app;
 *  - DemoApi runs the same logic (logic.js) in the browser on sample cards, for previews.
 * Every call resolves to the server's JSON ({ok:true, ...}) or rejects on network failure.
 */

function RemoteApi(url, token) {
  async function call(action, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    try {
      // text/plain body keeps this a "simple" request: no CORS preflight, which Apps Script can't answer
      const res = await fetch(url, { method: "POST", body: JSON.stringify({ ...body, action, token }), signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }
  return {
    demo: false,
    hello: () => call("hello", {}),
    next: (mode, exclude, count) => call("next", { mode, exclude, count }),
    submit: (reviews) => call("submit", { reviews }),
    undo: (review_id) => call("undo", { review_id }),
    board: () => call("board", {}),
    onboarded: (results) => call("onboarded", { results }),
    dashboard: () => call("dashboard", {})
  };
}

function DemoApi() {
  const KEY = "wb-demo-reviews";
  const me = { id: "demo", name: "Демо" };
  const items = (window.WB_SAMPLE || []).map(it => ({ ...it }));
  // a few hidden check cards with planted errors, built the same way as makePlantedGold() on the server
  const tris = items.filter(it => it.type === "tri");
  tris.slice(0, 4).forEach((t, i) => {
    const g = plantGold(t.payload, tris[(i + 5) % tris.length].payload, PLANT_KINDS[i % PLANT_KINDS.length], hash32(t.item_id));
    const chk = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ k: g.key, msg: g.msg }))));
    items.push({ item_id: "GOLD-00" + (i + 1), type: "tri", gold: "bad:" + g.key, payload: { ...g.payload, chk } });
  });
  // a few made-up teammates so the third-opinion and leaderboard logic has something to show
  const others = [
    { id: "d1", name: "Волонтер 03" }, { id: "d2", name: "Волонтер 11" }, { id: "d3", name: "Волонтер 05" }
  ];
  const seed = [];
  items.forEach((it, i) => {
    if (i % 3 === 0) seed.push({ item_id: it.item_id, annotator: "d1", outcome: i % 6 === 0 ? "no" : "yes", answer: "", undone: false, day: today() });
    if (i % 4 === 0) seed.push({ item_id: it.item_id, annotator: "d2", outcome: "yes", answer: "", undone: false, day: today() });
  });
  function today() { return new Date().toISOString().slice(0, 10); }
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (_) { return []; } }
  function save(r) { try { localStorage.setItem(KEY, JSON.stringify(r)); } catch (_) {} }
  const all = () => seed.concat(load());
  const stats = () => {
    const rv = all(), mine = rv.filter(r => r.annotator === me.id && !r.undone);
    return { done: mine.length, remaining: remainingFor(items, rv, me.id), team: teamProgress(items, rv), streak: 1 };
  };
  const wait = (v) => new Promise(r => setTimeout(() => r(v), 250));
  return {
    demo: true,
    hello: () => wait({ ok: true, me: { ...me, onboarded: !!localStorage.getItem("wb-demo-onboarded") }, config: { dwell_ms: 3000, break_every: 25 }, stats: stats() }),
    onboarded: (results) => { try { localStorage.setItem("wb-demo-onboarded", JSON.stringify(results)); } catch (_) {} return wait({ ok: true }); },
    next: (mode, exclude, count) => {
      const picked = pickNext(items, all(), {}, { annotator: me.id, mode, exclude, count: count || 3 });
      return wait({ ok: true, cards: picked.map(p => ({ item_id: p.item_id, type: p.type, payload: p.payload })), remaining: stats().remaining });
    },
    submit: (reviews) => {
      const rv = load(), ids = new Set(rv.map(r => r.review_id));
      reviews.forEach(r => { if (!ids.has(r.review_id)) rv.push({ ...r, annotator: me.id, undone: false, day: today() }); });
      save(rv);
      return wait({ ok: true, saved: reviews.length, stats: stats() });
    },
    undo: (review_id) => {
      const rv = load(); rv.forEach(r => { if (r.review_id === review_id) r.undone = true; }); save(rv);
      return wait({ ok: true, found: true, stats: stats() });
    },
    board: () => wait({ ok: true, me: me.id, board: leaderboard(items, all(), [me, ...others]), team: teamProgress(items, all()) }),
    dashboard: () => {
      const typeOf = Object.fromEntries(items.map(it => [it.item_id, it.type]));
      const rv = all().map((r, i) => ({ position: (i % 40) + 1, dwell_ms: 9000, ...r, type: r.type || typeOf[r.item_id],
        raw: r.raw ?? (typeOf[r.item_id] === "sev" ? ((i * 37) % 100) / 100 : "") }));
      const d = dashboardStats(items, rv, [me, ...others]);
      return wait({ ok: true, isAdmin: true, me: me.id, generated: new Date().toISOString(), ...d });
    }
  };
}
