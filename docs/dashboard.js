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
    <p class="note">Трійки — чи знайшли проблему, питання — обрана відповідь, небезпечність — позиція на шкалі. Від 0.8 — надійно, від 0.667 — прийнятно для висновків. У першому раунді було ≈0.06.</p></section>`;
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

function round1Card(d) {
  const r = d.round1;
  if (!r) return "";
  const a = k => r.alpha[k] && r.alpha[k].value !== null ? r.alpha[k].value.toFixed(2) : "—";
  return `<section class="card"><h2>Раунд 1 (Google Sheets) — для порівняння</h2>
    <div class="alpha" style="grid-template-columns:repeat(4,1fr)">
      <div><span>Оцінок</span><b>${r.reviews}</b><span>${r.items} прикладів</span></div>
      <div><span>α трійки</span><b>${a("tri")}</b><span>${r.alpha.tri.items} прикл.</span></div>
      <div><span>α питання</span><b>${a("qa")}</b><span>${r.alpha.qa.items} прикл.</span></div>
      <div><span>Правки · ✕</span><b>${r.edits} · ${r.flags}</b><span>рядків з правками · позначок</span></div>
    </div>
    <h2 style="margin-top:16px">Позначки й номер рядка в аркуші</h2>
    ${r.position.filter(b => b.n).map(b => `<div class="hrow"><span>рядки ${b.from}–${b.to ?? "…"}</span>${bar([[b.flagged / b.n, "var(--bad)"]], 1)}<em>${pct(b.flagged, b.n)}%</em></div>`).join("")}
    <p class="note">Ці оцінки збережено в таблиці (source = round1), але до потрібних 2–3 оцінок вони не зараховуються — кожен приклад отримує свіжі незалежні оцінки. Змінити можна в config.count_round1.</p></section>`;
}

function render(d) {
  const when = d.generated ? new Date(d.generated).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "";
  $("#sub").textContent = `${demo ? "Демо-дані · " : ""}оновлено о ${when}${d.isAdmin ? " · повний доступ" : ""}`;
  $("#main").innerHTML = kpis(d) + typesCard(d) + dailyCard(d) + alphaCard(d) + positionCard(d) + reasonsCard(d) + sevCard(d) + round1Card(d)
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
