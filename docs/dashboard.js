/* Progress dashboard: team progress for everyone with a personal link; per-person numbers and the
 * latest edits and flags for people marked `admin` in the annotators tab. Numbers come from
 * dashboardStats() in logic.js (server side), cached there for 2 minutes.
 */
const $ = s => document.querySelector(s);
const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) { return null; } }
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const TYPES = [["tri", "Трійки"], ["qa", "Питання"], ["sev", "Небезпечність"]];
const COL = { tri: "var(--c-tri)", qa: "var(--c-qa)", sev: "var(--c-sev)" };

const url = new URL(location.href);
const fromUrl = url.searchParams.get("t");
if (fromUrl) { ls("wb-token", fromUrl); url.searchParams.delete("t"); history.replaceState(null, "", url.pathname + url.search); }
const apiUrl = (window.WB_CONFIG || {}).apiUrl;
const demo = !apiUrl || url.searchParams.has("demo");
const api = demo ? DemoApi() : RemoteApi(apiUrl, ls("wb-token"));
if (demo) $("#back").href = "./?demo";

function bar(parts, total) {
  return `<div class="bar">${parts.map(([v, c]) => v ? `<i style="width:${v / total * 100}%;background:${c}"></i>` : "").join("")}</div>`;
}
const legend = items => `<div class="legend">${items.map(([t, c]) => `<span style="--c:${c}">${t}</span>`).join("")}</div>`;

function kpis(d) {
  const t = d.totals, today = new Date().toISOString().slice(0, 10);
  const td = d.daily.find(x => x.day === today) || {}, todayN = (td.tri || 0) + (td.qa || 0) + (td.sev || 0);
  return `
    <section class="card w3 kpi"><b>${pct(t.team.done, t.team.total)}%</b><span>готово: ${t.team.done} з ${t.team.total} прикладів</span>
      ${bar([[t.team.done, "var(--ok)"]], t.team.total || 1)}</section>
    <section class="card w3 kpi"><b>${t.reviews}</b><span>оцінок усього · ${todayN} сьогодні</span></section>
    <section class="card w3 kpi"><b>${t.people}</b><span>людей уже оцінювали</span></section>
    <section class="card w3 kpi"><b>${t.edits}</b><span>карток з правками · ${t.flags} позначок ✕</span></section>`;
}

function typesCard(d) {
  const L = [["готово", "var(--ok)"], ["чекає третьої думки", "var(--c-third)"], ["одна оцінка", "var(--c-partial)"], ["ще не бачили", "var(--surface-2)"]];
  return `<section class="card w6"><h2>Прогрес за типами</h2>
    ${TYPES.filter(([k]) => d.types[k]).map(([k, n]) => { const t = d.types[k]; return `
      <div class="type-row"><b>${n}</b>${bar([[t.done, L[0][1]], [t.third, L[1][1]], [t.partial, L[2][1]]], t.total || 1)}<em>${pct(t.done, t.total)}% · ${t.total}</em></div>`; }).join("")}
    ${legend(L.slice(0, 3))}
    <p class="note">Приклад готовий, коли має 2 незалежні оцінки, або 3 — якщо хтось знайшов проблему чи відповіді на питання різні.</p></section>`;
}

function dailyCard(d) {
  const days = [], end = new Date();
  for (let i = 20; i >= 0; i--) { const x = new Date(end); x.setDate(end.getDate() - i); days.push(x.toISOString().slice(0, 10)); }
  const by = Object.fromEntries(d.daily.map(x => [x.day, x]));
  const max = Math.max(1, ...days.map(k => { const x = by[k] || {}; return (x.tri || 0) + (x.qa || 0) + (x.sev || 0); }));
  return `<section class="card w6"><h2>Оцінки за днями</h2>
    <div class="cols">${days.map(k => { const x = by[k] || {}, sum = (x.tri || 0) + (x.qa || 0) + (x.sev || 0);
      return `<div class="col" data-tip="${k.slice(5)}: ${sum}">${TYPES.map(([t]) => x[t] ? `<i style="height:${x[t] / max * 100}%;background:${COL[t]}"></i>` : "").join("")}</div>`; }).join("")}</div>
    <div class="axis">${days.map((k, i) => `<span>${i % 5 === 0 || i === 20 ? k.slice(8) + "." + k.slice(5, 7) : ""}</span>`).join("")}</div>
    ${legend(TYPES.map(([k, n]) => [n, COL[k]]))}</section>`;
}

function alphaCard(d) {
  const tag = (a, n) => a === null ? "" : n < 10 ? `<span class="tag mid">мало даних</span>` : a >= .8 ? `<span class="tag good">надійно</span>` : a >= .667 ? `<span class="tag mid">прийнятно</span>` : `<span class="tag low">низька</span>`;
  return `<section class="card w6"><h2>Узгодженість (α Кріппендорфа)</h2>
    <div class="alpha">${TYPES.map(([k, n]) => { const a = d.alpha[k] || { value: null, items: 0 };
      return `<div><span>${n}</span><b>${a.value === null ? "—" : a.value.toFixed(2)}</b><span>${a.items} прикл. з 2+ оцінками</span><br>${tag(a.value, a.items)}</div>`; }).join("")}</div>
    <p class="note">Трійки — чи знайшли проблему, питання — обрана відповідь, небезпечність — позиція на шкалі. Від 0.8 — надійно, від 0.667 — прийнятно для висновків. У першому раунді для трійок було ≈0.04.${d.qaAccuracy && d.qaAccuracy.n ? ` Відповіді на питання збігаються з ключем датасету в ${pct(d.qaAccuracy.right, d.qaAccuracy.n)}% (${d.qaAccuracy.n}).` : ""}</p></section>`;
}

function positionCard(d) {
  const rows = d.position.filter(b => b.n);
  return `<section class="card w6"><h2>Позначки й номер картки в сесії</h2>
    ${rows.length ? rows.map(b => `<div class="hrow"><span>картки ${b.from}–${b.to ?? "…"}</span>${bar([[b.flagged / b.n, "var(--bad)"]], 1)}<em>${pct(b.flagged, b.n)}%</em></div>`).join("")
      : `<p class="empty">Ще немає даних.</p>`}
    <p class="note">Частка трійок і питань, де знайшли проблему. Якщо вона помітно падає з номером картки — це втома або звикання, а не кращі дані. Саме так зсунулися позначки в першому раунді.</p></section>`;
}

function reasonsCard(d) {
  const max = Math.max(1, ...d.reasons.map(r => r.n));
  return `<section class="card w6"><h2>Причини позначок</h2>
    ${d.reasons.length ? d.reasons.map(r => `<div class="hrow"><span>${esc(r.reason)}</span>${bar([[r.n, "var(--bad)"]], max)}<em>${r.n}</em></div>`).join("")
      : `<p class="empty">Ще ніхто нічого не позначив.</p>`}</section>`;
}

function sevCard(d) {
  const max = Math.max(1, ...d.sevHist);
  return `<section class="card w6"><h2>Розподіл небезпечності</h2>
    <div class="cols" style="height:120px">${d.sevHist.map((n, i) => `<div class="col" data-tip="${i * 10}–${i * 10 + 10}%: ${n}"><i style="height:${n / max * 100}%;background:linear-gradient(var(--c-sev),var(--c-qa));opacity:${.45 + i / 18}"></i></div>`).join("")}</div>
    <div class="axis"><span style="text-align:left">побутове</span><span style="text-align:right">небезпечне</span></div></section>`;
}

function peopleCard(d) {
  const P = d.admin.people, s = ms => ms === null ? "—" : Math.round(ms / 1000) + " с";
  return `<section class="card"><h2>Люди</h2><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Ім'я</th><th class="num">Оцінок</th><th class="num">Днів</th><th>Остання</th><th class="num">Знайшли проблему</th><th class="num">З правками</th><th class="num">Медіана часу</th><th class="num">Точність на контрольних</th><th>Знайомство</th></tr></thead>
    <tbody>${P.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.cards}</td><td class="num">${p.days}</td><td>${p.last || "—"}</td>
      <td class="num">${p.flagRate === null ? "—" : Math.round(p.flagRate * 100) + "%"}</td><td class="num">${p.edits}</td><td class="num">${s(p.medianDwell)}</td>
      <td class="num">${p.accuracy === null ? "—" : Math.round(p.accuracy * 100) + "%"}</td><td>${p.onboarded ? "✓" : "—"}</td></tr>`).join("")}</tbody></table></div>
    <p class="note">Дуже низька частка «знайшли проблему» разом із коротким часом на картку — привід поговорити з людиною. Точність з'явиться, коли в items.gold будуть контрольні приклади.</p></section>`;
}

function recentCard(d) {
  const R = d.admin.recent;
  return `<section class="card w8"><h2>Останні правки й позначки</h2><div class="feed">
    ${R.length ? R.map(r => `<div class="it"><div class="meta">${esc(r.item_id)} · ${esc(r.annotator)} · ${r.ts ? new Date(r.ts).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }) : esc(r.day)}</div>
      ${Object.keys(r.text).map(k => `<div class="ed"><b>${esc(k)} ✎</b> ${esc(r.text[k])}</div>`).join("")}
      ${r.flags.map(f => `<div class="fl"><b>${esc(f.k)} ✕</b> ${f.frag ? `<q>${esc(f.frag)}</q> — ` : ""}${esc(f.reason)}</div>`).join("")}</div>`).join("")
      : `<p class="empty">Поки порожньо.</p>`}</div></section>`;
}

function splitsCard(d) {
  const S = d.admin.sevSplits;
  return `<section class="card w4"><h2>Розбіжності в небезпечності</h2>
    ${S.length ? S.map(x => `<div class="hrow" style="grid-template-columns:1fr auto"><span class="chip">${esc(x.item_id)}</span><em>${x.raws.map(v => Math.round(v * 100)).join(" / ")}</em></div>`).join("")
      : `<p class="empty">Немає випадків, де оцінки розійшлися на 40+ пунктів.</p>`}
    <p class="note">Третьої оцінки тут немає — такі випадки варто обговорити разом.</p></section>`;
}

const ACTORS = { veteran: "Ветерани", idp: "ВПО" };
const fmtPct = (x, digits = 0) => x === null || x === undefined ? "—" : (x * 100).toFixed(digits) + "%";
let view = (location.hash === "#r1") ? "r1" : "now";

/* ---------- round 1 view ---------- */
function r1Kpis(r) {
  return `
    <section class="card w3 kpi"><b>${r.reviews}</b><span>оцінок від ${r.volunteers} волонтерів · ${r.triItems} трійок, ${r.qaItems} питань</span></section>
    <section class="card w3 kpi"><b>${fmtPct(r.rawAgree)}</b><span>пар оцінок трійок збігаються · α = ${r.alpha.tri.value ?? "—"}</span></section>
    <section class="card w3 kpi"><b>${fmtPct(r.qa.accuracy)}</b><span>відповідей на питання збігаються з ключем датасету · α = ${r.alpha.qa.value ?? "—"}</span></section>
    <section class="card w3 kpi"><b>${fmtPct(r.flagRate, 1)}</b><span>трійок позначено · перша половина аркуша ${fmtPct(r.halves.early, 1)} → друга ${fmtPct(r.halves.late, 1)}</span></section>
    <section class="card">
      <p class="note" style="margin:0">Чому α для трійок така низька, хоча люди погоджуються в ${fmtPct(r.rawAgree)} випадків: майже все приймали, тож випадковий збіг теж дуже високий, і α «з'їдає» згоду. Головне інше — позначки рідко збігаються: кожен бачить свої проблеми. Тому одна позначка раунду 1 — це гіпотеза, а не вирок.</p></section>`;
}
function r1Consensus(r) {
  const c = r.consensus, tot = c.accept + c.split + c.problem + c.single;
  const L = [["усі прийняли", c.accept, "var(--ok)"], ["думки розділилися", c.split, "var(--c-third)"], ["усі позначили", c.problem, "var(--bad)"], ["лише одна оцінка", c.single, "var(--c-partial)"]];
  return `<section class="card w6"><h2>Консенсус по трійках</h2>
    ${bar(L.map(x => [x[1], x[2]]), tot || 1)}
    <div style="margin-top:12px">${L.map(x => `<div class="hrow" style="grid-template-columns:14px 1fr auto"><i style="width:10px;height:10px;border-radius:3px;background:${x[2]}"></i><span>${x[0]}</span><em>${x[1]} · ${pct(x[1], tot)}%</em></div>`).join("")}</div>
    ${r.mode === "vote" ? `<p class="note">Зараз (режим vote): <b>${r.voted}</b> одностайно прийнятих трійок потребують лише однієї свіжої оцінки; <b>${r.flagged}</b> трійок, де хтось бачив проблему, йдуть першими й отримують дві свіжі сліпі оцінки.</p>` : ""}</section>`;
}
function r1Sentences(r) {
  const S = r.sentences, tot = ["S", "C", "U"].reduce((a, k) => a + S[k].redo + S[k].edit, 0), max = Math.max(1, ...["S", "C", "U"].map(k => S[k].redo + S[k].edit));
  const name = { S: "S · стереотип", C: "C · заперечення", U: "U · нейтральне" };
  return `<section class="card w6"><h2>Яке речення позначали</h2>
    ${["S", "C", "U"].map(k => `<div class="hrow"><span>${name[k]}</span>${bar([[S[k].redo, "var(--bad)"], [S[k].edit, "var(--edit)"]], max)}<em>${S[k].redo + S[k].edit}</em></div>`).join("")}
    ${legend([["переробити", "var(--bad)"], ["виправлено вручну", "var(--edit)"]])}
    <p class="note">${pct(S.C.redo + S.C.edit, tot)}% усіх позначок — на C. Головна слабкість датасету — заперечення стереотипу, а не переклад.</p></section>`;
}
function r1Themes(r) {
  const max = Math.max(1, ...r.themes.map(t => t.n));
  return `<section class="card w6"><h2>Про що коментарі (${r.comments})</h2>
    ${r.themes.map(t => `<div class="hrow"><span>${esc(t.theme)}</span>${bar([[t.n, t.theme === "Інше" ? "var(--muted)" : "var(--brand)"]], max)}<em>${t.n}</em></div>`).join("")}
    <p class="note">Розкладено автоматично за ключовими словами, тож приблизно; один коментар може бути в кількох темах. Усі коментарі й правки з оригіналом — у вкладці round1_proposals.</p></section>`;
}
function r1Position(r) {
  return `<section class="card w6"><h2>Позначки й номер рядка в аркуші</h2>
    ${r.position.filter(b => b.n).map(b => `<div class="hrow"><span>рядки ${b.from}–${b.to ?? "…"}</span>${bar([[b.flagged / b.n, "var(--bad)"]], .25)}<em>${pct(b.flagged, b.n)}%</em></div>`).join("")}
    <p class="note">Шкала до 25%. У середньому спад невеликий (${fmtPct(r.halves.early, 1)} → ${fmtPct(r.halves.late, 1)}), але в окремих людей він різкий — див. таблицю волонтерів.</p></section>`;
}
function r1Groups(r) {
  const row = g => `<div class="hrow"><span>${esc(ACTORS[g.name] || g.name)}</span>${bar([[g.flagged / g.n, "var(--bad)"]], .25)}<em>${pct(g.flagged, g.n)}%</em></div>`;
  return `<section class="card w6"><h2>Частка позначок за групою й темою</h2>
    ${r.byActor.map(row).join("")}
    <div style="height:8px"></div>
    ${r.bySection.map(row).join("")}
    <p class="note">Шкала до 25%. Теми — 12 найбільших розділів, відсоток від оцінок трійок у розділі.</p></section>`;
}
function r1Check(r) {
  if (r.mode !== "vote") return "";
  return `<section class="card w6"><h2>Чи довіряти одностайному «прийнято»?</h2>
    <div class="hrow"><span>свіжі оцінки на таких трійках, що знайшли проблему</span>${bar([[r.check.flagged / (r.check.n || 1), "var(--bad)"]], .25)}<em>${r.check.n ? pct(r.check.flagged, r.check.n) + "%" : "—"}</em></div>
    <p class="note">${r.check.n < 150 ? `Поки ${r.check.n} з ~150 свіжих оцінок, потрібних для висновку.` : r.check.flagged / r.check.n <= .05 ? "До 5% — довіру можна залишити." : "Понад 5% — краще перемкнути config.round1_mode на off: кожна трійка отримає дві свіжі оцінки."}</p></section>`;
}
function r1People(d) {
  const P = d.admin && d.admin.round1People;
  if (!P) return `<p class="lock">Таблиця по волонтерах раунду 1 доступна координаторам (стовпець admin у таблиці annotators).</p>`;
  const drop = p => p.early !== null && p.late !== null && p.early >= .08 && p.late <= p.early / 2;
  return `<section class="card"><h2>Волонтери раунду 1</h2><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Волонтер</th><th class="num">Трійок</th><th class="num">Позначено</th><th class="num">1-ша → 2-га половина</th><th class="num">Позначки підтвердили інші</th><th class="num">Коментарів</th><th class="num">Правок</th><th class="num">Питання: збіг з ключем</th><th></th></tr></thead>
    <tbody>${P.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.tri}</td><td class="num">${fmtPct(p.flagRate, 1)}</td>
      <td class="num">${fmtPct(p.early)} → ${fmtPct(p.late)}${drop(p) ? " ⚠" : ""}</td>
      <td class="num">${p.others ? `${p.confirmed} з ${p.others} (${pct(p.confirmed, p.others)}%)` : "—"}</td>
      <td class="num">${p.comments}</td><td class="num">${p.edits}</td><td class="num">${fmtPct(p.qaAcc)}</td>
      <td>${p.trusted ? "" : `<span class="tag low" style="white-space:nowrap">без голосу</span>`}</td></tr>`).join("")}</tbody></table></div>
    <p class="note">⚠ — частка позначок у другій половині аркуша впала вдвічі й більше: схоже на втому. «Підтвердили інші» — скільки разів інші люди на тій самій трійці теж бачили проблему; низьке число не означає помилку, а показує, що людина помічає те, чого не бачать інші. «Без голосу» — 50+ трійок без жодної позначки: їхнє «прийнято» не зараховується як голос.</p></section>`;
}
function renderRound1(d) {
  const r = d.round1;
  return r1Kpis(r) + r1Consensus(r) + r1Sentences(r) + r1Themes(r) + r1Position(r) + r1Groups(r) + r1Check(r) + r1People(d);
}

function tabs(d) {
  if (!d.round1) return "";
  return `<nav class="tabs" role="tablist">
    <button role="tab" data-view="now" aria-selected="${view === "now"}">Зараз</button>
    <button role="tab" data-view="r1" aria-selected="${view === "r1"}">Раунд 1</button></nav>`;
}

function render(d) {
  const when = d.generated ? new Date(d.generated).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "";
  $("#sub").textContent = `${demo ? "Демо-дані · " : ""}оновлено о ${when}${d.isAdmin ? " · повний доступ" : ""}`;
  if (!d.round1) view = "now";
  $("#main").innerHTML = tabs(d) + (view === "r1" ? renderRound1(d) : renderNow(d));
  $("#main").querySelectorAll("[data-view]").forEach(b => b.onclick = () => {
    view = b.dataset.view; history.replaceState(null, "", view === "r1" ? "#r1" : location.pathname + location.search); render(d);
  });
}
function renderNow(d) {
  return kpis(d) + typesCard(d) + dailyCard(d) + alphaCard(d) + positionCard(d) + reasonsCard(d) + sevCard(d)
    + (d.admin ? peopleCard(d) + recentCard(d) + splitsCard(d)
      : `<p class="lock">Таблиця по людях і стрічка правок доступні координаторам (стовпець admin у таблиці annotators).</p>`);
}

async function load() {
  const cached = ls("wb-dash");
  if (cached) { try { render(JSON.parse(cached)); $("#sub").textContent += " · оновлюю…"; } catch (_) {} }
  if (!demo && !ls("wb-token")) {
    $("#sub").textContent = "Потрібне персональне посилання";
    $("#main").innerHTML = `<div class="err">Відкрийте свій персональний лінк один раз — далі дашборд відкриватиметься сам.</div>`;
    return;
  }
  try {
    const d = await api.dashboard();
    if (!d.ok) throw new Error(d.error);
    if (!demo) ls("wb-dash", JSON.stringify(d));
    render(d);
  } catch (e) {
    if (!cached) $("#main").innerHTML = `<div class="err">Не вдалося завантажити дані${e && e.message ? ` (${esc(e.message)})` : ""}. Спробуйте «Оновити».</div>`;
    else $("#sub").textContent = $("#sub").textContent.replace(" · оновлюю…", " · не вдалося оновити");
  }
}
$("#refresh").onclick = load;
load();
