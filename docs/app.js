/* WarBias annotation app: card feed, inline editing, severity slider, sync with the backend. */

const LEVELS = [
  { e: "🙂" }, { e: "😕" }, { e: "😠" }, { e: "🚨" }   // emoji follows the slider; no labels in between
];
const ENDS = ["Побутове упередження", "Виправдовує переслідування"];
const ACTOR = { veteran: "Ветерани", idp: "ВПО" };
const MODES = [["all", "Усе разом", "Усе", "Картки йдуть упереміш"], ["tri", "Трійки", "Трійки", "S · C · U"], ["qa", "Питання", "Питання", "Відповідь і якість"], ["sev", "Небезпечність", "Небезпечність", "Наскільки небезпечний стереотип"]];
// typical problems differ by card type
const REASONS = {
  tri: ["Граматика чи правопис", "Звучить неприродно", "Не заперечує стереотип", "Натякає на стереотип", "Інша група або зміст", "Трійка непаралельна"],
  qa: ["Підходить кілька відповідей", "Жодна відповідь не підходить", "Опис суперечить сам собі", "З опису неможливо визначити відповідь", "Звучить неприродно чи граматика"]
};

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { return null; } }
let tt; function toast(m) { document.querySelectorAll(".toast").forEach(t => t.remove()); const t = document.createElement("div"); t.className = "toast"; t.textContent = m; document.body.appendChild(t); clearTimeout(tt); tt = setTimeout(() => t.remove(), 2600); }
function sheet(html, onMount) {
  const s = document.createElement("div"); s.className = "scrim";
  s.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  s.addEventListener("click", e => {
    if (e.target.closest("[data-replay]")) { s.remove(); startTutorial(true); return; }
    if (e.target === s || e.target.closest("[data-close]")) s.remove();
  });
  document.body.appendChild(s); onMount && onMount(s);
}

const myReasonsFor = t => { try { return JSON.parse(ls("my-reasons-" + t) || "[]"); } catch (_) { return []; } };
function rememberReason(full) {
  const t = st.cur ? st.cur.type : "tri", typical = REASONS[t] || [];
  let myReasons = myReasonsFor(t);
  const r = full.split(" — ")[0].trim(); // keep the category part, not the per-sentence detail
  if (!r || typical.includes(r) || myReasons.includes(r)) return;
  myReasons.unshift(r); myReasons = myReasons.slice(0, 8);
  ls("my-reasons-" + t, JSON.stringify(myReasons));
}

/* ---------- state ---------- */
const st = {
  api: null, me: null, cfg: { dwell_ms: 3000, break_every: 25 }, stats: null,
  mode: "all", queue: [], fetching: false, exhausted: false, cur: null, history: [],
  sinceBreak: 0, showEn: false, session: uuid(), position: 0, done: 0
};
const DWELL = () => st.cfg.dwell_ms;
// a card with any edited or ✕ sentence counts as "found a problem", whichever way it was swiped
const outcome = c => c && c.s && Object.values(c.s).some(v => v === "redo" || v === "edit") ? "no" : "yes";
const stage = $("#stage");
let card, enteredAt = 0;

// one concrete thing to look at on each card: asking a specific question finds more problems than "anything wrong?"
const FOCUS = {
  tri: ["Чи C заперечує саме цей стереотип, а не щось поруч?", "Чи U справді нейтральне — без натяку на стереотип?",
    "Чи всі три речення звучать природно українською?", "Чи S звучить як справжнє поширене упередження?",
    "Чи всі три речення про ту саму групу людей?", "Чи немає описок і граматичних помилок?"],
  qa: ["Чи відповідь однозначно випливає з опису?", "Чи не підходить сюди ще якась відповідь?", "Чи природно звучить опис?"]
};
const focusOf = c => FOCUS[c.type] ? hash32(c.id + "|" + ((st.me && st.me.id) || "")) % FOCUS[c.type].length : null;
/** Hidden check cards carry their planted error (base64 JSON) so feedback works offline. */
function decodeChk(s) { try { return s ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), ch => ch.charCodeAt(0)))) : null; } catch (_) { return null; } }

function toCur(raw) {
  const p = raw.payload, base = { id: raw.item_id, type: raw.type, item: p, shownAt: 0, chk: decodeChk(p.chk) };
  if (raw.type === "tri") return { ...base, s: { S: "", C: "", U: "" }, text: { S: p.S, C: p.C, U: p.U }, orig: { S: p.S, C: p.C, U: p.U }, why: {} };
  if (raw.type === "qa") return { ...base, s: { X: "" }, text: { X: p.ctx }, orig: { X: p.ctx }, why: {}, answer: null };
  return { ...base, raw: null };
}

/* ---------- pending submissions (survive reloads and bad connections) ---------- */
const PKEY = "wb-pending";
let pending = (() => { try { return JSON.parse(ls(PKEY) || "[]"); } catch (_) { return []; } })();
let pendingUndo = (() => { try { return JSON.parse(ls(PKEY + "-undo") || "[]"); } catch (_) { return []; } })();
const savePending = () => { ls(PKEY, JSON.stringify(pending)); ls(PKEY + "-undo", JSON.stringify(pendingUndo)); setSync(); };
let flushing = false, flushFail = 0;
async function flush() {
  if (flushing || !st.api || (!pending.length && !pendingUndo.length)) return;
  flushing = true;
  try {
    if (pending.length) {
      const batch = pending.slice(0, 20);
      const r = await st.api.submit(batch);
      if (!r.ok) throw new Error(r.error);
      const sent = new Set(batch.map(b => b.review_id));
      pending = pending.filter(p => !sent.has(p.review_id));
      if (r.stats) applyStats(r.stats);
    }
    while (pendingUndo.length) {
      const r = await st.api.undo(pendingUndo[0]);
      if (!r.ok && r.error !== "not_yours") throw new Error(r.error);
      pendingUndo.shift();
      if (r.stats) applyStats(r.stats);
    }
    flushFail = 0;
  } catch (e) {
    flushFail++;
  } finally {
    flushing = false; savePending();
    if (pending.length || pendingUndo.length) setTimeout(flush, Math.min(30000, 2000 * 2 ** flushFail));
  }
}
function setSync() {
  const n = pending.length + pendingUndo.length, el = $("#sync");
  el.textContent = !n ? "" : flushFail ? `не надіслано: ${n}` : "зберігаю…";
  el.classList.toggle("err", !!(n && flushFail));
  el.title = flushFail ? "Немає зв'язку з сервером. Відповіді збережено на пристрої, надішлемо, щойно з'явиться зв'язок." : "";
}
addEventListener("online", flush);
setInterval(flush, 20000);

/* ---------- stats ---------- */
function applyStats(s) {
  st.stats = s;
  st.done = s.done + pending.length - pendingUndo.length;
  updCount();
}
function updCount() {
  $("#count").textContent = st.done;
  const t = st.stats && st.stats.team;
  const pct = t && t.total ? t.done / t.total * 100 : 0;
  $("#prog").style.width = pct + "%";
  $("#prog").parentElement.title = t ? `Команда: ${t.done} з ${t.total} карток мають усі потрібні оцінки` : "";
}

/* ---------- card queue ---------- */
async function fill() {
  if (st.fetching || st.exhausted || st.queue.length >= 2) return;
  st.fetching = true;
  try {
    const exclude = [...st.queue.map(c => c.id), ...(st.cur ? [st.cur.id] : []), ...pending.map(p => p.item_id), ...st.history.map(h => h.cur.id)];
    const r = await st.api.next(st.mode, exclude, 3);
    if (!r.ok) throw new Error(r.error);
    if (r.remaining && st.stats) st.stats.remaining = r.remaining;
    const have = new Set(exclude);
    r.cards.filter(c => !have.has(c.item_id)).forEach(c => st.queue.push(toCur(c)));
    if (!r.cards.length) st.exhausted = true;
  } catch (e) {
    toast("Не вдалося отримати картки. Перевірте інтернет — спробуємо ще раз.");
    setTimeout(() => { st.fetching = false; fill().then(() => { if (!st.cur) render(); }); }, 5000);
    return;
  } finally { st.fetching = false; }
}
async function advance() {
  if (!st.queue.length) { renderState("loading"); await fill(); }
  st.cur = st.queue.shift() || null;
  render();
  fill();
}

/* ---------- rendering ---------- */
function reasonSelect(placeholder) {
  const t = st.cur ? st.cur.type : "tri", typical = REASONS[t] || REASONS.tri, myReasons = myReasonsFor(t);
  const o = r => `<option value="${esc(r)}">${esc(r)}</option>`;
  return `<select class="reason"><option value="">${placeholder}</option>
    <optgroup label="Типові">${typical.map(o).join("")}</optgroup>
    ${myReasons.length ? `<optgroup label="Ваші попередні">${myReasons.map(o).join("")}</optgroup>` : ""}
    <option value="__other">Інше — написати…</option></select>
    <div class="note-row" hidden><textarea class="other" rows="1" placeholder="Опишіть коротко" enterkeyhint="done"></textarea><button class="add" type="button">Додати</button></div>`;
}
// picking a reason pre-fills the text field so the annotator can continue the thought
function fillNote(input, reason) {
  const row = input.closest(".note-row") || input; row.hidden = false;
  input.value = reason ? reason + " — " : "";
  autosize(input); input.focus(); const n = input.value.length; try { input.setSelectionRange(n, n); } catch (_) {}
}
function autosize(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; }
document.addEventListener("input", e => { if (e.target.matches && e.target.matches("textarea.other")) autosize(e.target); });
const cleanNote = v => v.trim().replace(/\s*[—-]\s*$/, "");

// a ✕ sentence is shown as tappable words: tap (or drag with a mouse) to pick the fragment that is wrong
const tokens = text => text.split(/(\s+)/);
function wordsHTML(k) {
  const c = st.cur, marked = new Set(), pick = (c.pick && c.pick[k]) || new Set();
  (c.why[k] || []).forEach(it => { if (it.range) for (let i = it.range[0]; i <= it.range[1]; i++) marked.add(i); });
  let wi = 0;
  return tokens(c.text[k]).map(t => {
    if (!t.trim()) return esc(t);
    const i = wi++; return `<span class="w${marked.has(i) ? " m" : ""}${pick.has(i) ? " sel" : ""}" data-i="${i}">${esc(t)}</span>`;
  }).join("");
}
function pickRange(k) { const s = [...(st.cur.pick && st.cur.pick[k] || [])]; return s.length ? [Math.min(...s), Math.max(...s)] : null; }
function pickText(k) { const r = pickRange(k); if (!r) return ""; return tokens(st.cur.text[k]).filter(t => t.trim()).slice(r[0], r[1] + 1).join(" "); }
function issuesHTML(k) {
  const list = st.cur.why[k] || [];
  return `<div class="issues">
    ${list.map((it, i) => `<div class="issue">${it.frag ? `<q>${esc(it.frag)}</q>` : ""}<span>${esc(it.reason)}</span><button data-del="${i}" aria-label="Прибрати">✕</button></div>`).join("")}
    <div class="tip">${list.length ? "Торкніться інших слів або додайте ще причину." : "Торкніться слів, які не так, і оберіть причину. Або одразу оберіть причину для всього речення:"}</div>
    <div class="picked" hidden></div>
    ${reasonSelect(list.length ? "Додати причину…" : "Причина для всього речення…")}
  </div>`;
}
function sentHTML(k, label, orig, en) {
  const c = st.cur, txt = c.text[k], s = c.s[k];
  (c.meta = c.meta || {})[k] = { label, orig, en };
  const redo = s === "redo";
  return `<div class="sent ${s}" data-k="${k}">
    <span class="k">${label}</span>
    <div class="corner">
      <button class="c-rev" data-act="rev" title="Повернути оригінал" ${s === "edit" ? "" : "hidden"}>↺</button>
      <button class="c-ok" data-act="ok" aria-pressed="${s === "ok"}" title="Речення правильне">✓</button>
      <button class="c-bad" data-act="redo" aria-pressed="${s === "redo"}" title="Переробити повністю">✕</button>
    </div>
    <div class="ua" contenteditable="${redo ? "false" : "plaintext-only"}" spellcheck="${!redo}" data-orig="${esc(orig)}">${redo ? wordsHTML(k) : esc(txt)}</div>
    ${st.showEn && en ? `<div class="en">${esc(en)}</div>` : ""}
    ${redo ? issuesHTML(k) : ""}
  </div>`;
}
function refreshSent(k) {
  const old = card.querySelector(`.sent[data-k="${k}"]`), m = st.cur.meta[k];
  const tmp = document.createElement("div"); tmp.innerHTML = sentHTML(k, m.label, m.orig, m.en);
  const el = tmp.firstElementChild; el.classList.add("active"); old.replaceWith(el); wireSentence(el);
}
function renderState(kind) {
  stage.innerHTML = "";
  card = null;
  const box = document.createElement("div"); box.className = "state";
  if (kind === "loading") box.innerHTML = `<div class="spin" aria-hidden="true"></div><p>Готуємо картки…</p>`;
  else if (kind === "done") {
    const t = st.stats && st.stats.team;
    box.innerHTML = `<div class="big">🌻</div><h2>${st.mode === "all" ? "Карток для вас більше немає" : "У цьому режимі все зроблено"}</h2>
      <p>${t ? `Команда вже закрила ${t.done} з ${t.total} карток. ` : ""}Дякуємо! ${st.mode === "all" ? "Загляньте пізніше: можуть з'явитися картки, яким потрібна третя думка." : "Спробуйте інший режим угорі."}</p>
      <button class="btn" id="retry" style="max-width:240px">Перевірити ще раз</button>`;
  } else if (kind === "login") {
    box.innerHTML = `<div class="big">🔑</div><h2>Потрібне персональне посилання</h2>
      <p>Відкрийте посилання, яке вам надіслала координаторка. Воно має вигляд …/warbias-annotate/?t=…</p>`;
  } else if (kind === "error") {
    box.innerHTML = `<div class="big">🔌</div><h2>Немає зв'язку з сервером</h2><p>Перевірте інтернет і спробуйте ще раз.</p><button class="btn" id="retry" style="max-width:240px">Спробувати ще раз</button>`;
  }
  stage.appendChild(box);
  const r = box.querySelector("#retry"); if (r) r.onclick = () => { st.exhausted = false; kind === "error" ? boot() : advance(); };
  ["#yesBtn", "#noBtn"].forEach(s => $(s).disabled = true);
  $("#undoBtn").disabled = !st.history.length;
}
function render() {
  if (!st.cur) return renderState(st.exhausted ? "done" : "loading");
  stage.innerHTML = "";
  card = document.createElement("div"); card.className = "card"; card.tabIndex = -1;
  if (st.sinceBreak >= st.cfg.break_every) return renderBreak();
  const { type, item } = st.cur;
  if (!st.cur.shownAt) st.cur.shownAt = Date.now();
  const enBtn = `<span class="sp"></span><button class="tiny" data-en aria-pressed="${st.showEn}">EN</button>`;
  let html = '<div class="stamp yes">ПРИЙНЯТО</div><div class="stamp no">ПРОБЛЕМА</div>';
  if (type === "tri") {
    html += `<div class="eyebrow"><span class="kind">Трійка</span><span>${ACTOR[item.actor] || ""}</span>${enBtn}</div>
    <div class="body">${focusHTML()}<div class="def">${esc(item.section)}${st.showEn && item.def_en ? `<div class="def-en">${esc(item.def_en)}</div>` : ""}</div>
      ${sentHTML("S", "S", item.S, item.eS)}${sentHTML("C", "C", item.C, item.eC)}${sentHTML("U", "U", item.U, item.eU)}
      <div class="legend"><span><i style="background:var(--ok)"></i>правильне</span><span><i style="background:var(--edit)"></i>виправлене</span><span><i style="background:var(--bad)"></i>переробити</span></div></div>`;
  } else if (type === "qa") {
    const en = item.en || {};
    html += `<div class="eyebrow"><span class="kind">Питання</span><span>${ACTOR[item.actor] || ""}</span>${enBtn}</div>
    <div class="body">${focusHTML()}${sentHTML("X", "¶", item.ctx, en.ctx)}<div class="q">${esc(item.q)}${st.showEn && en.q ? `<div class="q-en">${esc(en.q)}</div>` : ""}</div>
      ${item.ch.map((c, i) => `<button class="choice" data-choice="${i}" aria-pressed="${st.cur.answer === i}"><b>${"ABC"[i]}</b><span>${esc(c)}${st.showEn && en.ch && en.ch[i] ? `<br><span class="q-en">${esc(en.ch[i])}</span>` : ""}</span></button>`).join("")}</div>`;
  } else {
    html += `<div class="eyebrow"><span class="kind">Небезпечність</span><span>${ACTOR[item.actor] || ""}</span></div>
    <div class="body sev">
      <div class="sev-main">
        <div class="sev-cat">Тема: <b>${esc(item.section)}</b></div>
        <p class="quote${item.ex[0].length > 90 ? " long" : ""}">${esc(item.ex[0])}</p>
        ${item.ex.length > 1 ? `<div class="also">${item.ex.slice(1).map(e => `<span>${esc(e)}</span>`).join("")}</div>` : ""}
      </div>
      <div class="sev-foot">
        <div class="sev-q">Наскільки небезпечно, якщо люди в це повірять?</div>
        <div class="sev-hint" id="sevEmpty">Торкніться шкали й потягніть смайлик</div>
        <div class="slider" id="slider" role="slider" tabindex="0" aria-label="Небезпечність стереотипу" aria-valuemin="0" aria-valuemax="100">
          <div class="track"></div><div class="zones"><span>${ENDS[0]}</span><span>${ENDS[1]}</span></div>
          <div class="knob idle" id="knob">🙂</div></div>
      </div></div>`;
  }
  card.innerHTML = html; stage.appendChild(card);
  wireCard(); enteredAt = performance.now(); updateActions();
}
function focusHTML() {
  const i = st.cur.practice ? null : focusOf(st.cur);
  return i === null ? "" : `<div class="focus"><span aria-hidden="true">🔎</span>${esc(FOCUS[st.cur.type][i])}</div>`;
}
function renderBreak() {
  card.classList.add("break");
  card.innerHTML = `<div style="font-size:42px">🫖</div><h2>${st.cfg.break_every} карток поспіль. Перерва?</h2>
   <p>Після довгої серії ми гірше помічаємо помилки.</p>
   <div class="row" style="width:100%;max-width:300px"><button class="btn ghost" id="brk">Відпочити 2 хв</button><button class="btn" id="cont">Далі</button></div>`;
  stage.appendChild(card);
  const go = m => { st.sinceBreak = 0; if (m) toast(m); st.cur.shownAt = 0; render(); };
  $("#brk").onclick = () => go("Повертайтеся, коли будете готові");
  $("#cont").onclick = () => go();
  $("#yesBtn").disabled = $("#noBtn").disabled = true;
}
function updateActions() {
  const c = st.cur;
  $("#yesBtn").disabled = (c.type === "qa" && c.answer === null) || (c.type === "sev" && c.raw === null);
  $("#noBtn").disabled = false;
  $("#noBtn").hidden = c.type === "sev"; // severity is a scale, not accept/reject
  $("#undoBtn").disabled = !st.history.length || !!c.practice;
}
const tooFast = () => performance.now() - enteredAt < DWELL();

/* ---------- inline sentence editing ---------- */
function setState(el, s) {
  const k = el.dataset.k, prev = st.cur.s[k]; st.cur.s[k] = s;
  if (s === "redo" || prev === "redo") { if (s === "redo") st.cur.why[k] = st.cur.why[k] || []; else delete st.cur.why[k]; refreshSent(k); return; }
  el.classList.remove("ok", "edit", "redo"); if (s) el.classList.add(s);
  el.querySelector(".c-ok").setAttribute("aria-pressed", s === "ok");
  el.querySelector(".c-bad").setAttribute("aria-pressed", s === "redo");
  el.querySelector(".c-rev").hidden = s !== "edit";
}
function addIssue(k, reason) {
  rememberReason(reason);
  const range = pickRange(k), frag = range ? pickText(k) : null;
  (st.cur.why[k] = st.cur.why[k] || []).push({ frag, range, reason });
  if (st.cur.pick) st.cur.pick[k] = new Set();
  refreshSent(k);
}
function syncPick(el, k) {
  const set = st.cur.pick[k], box = el.querySelector(".picked"), sel = el.querySelector(".reason");
  el.querySelectorAll(".w").forEach(w => w.classList.toggle("sel", set.has(+w.dataset.i)));
  const txt = pickText(k);
  box.hidden = !txt;
  box.innerHTML = txt ? `Виділено: «${esc(txt)}»<button type="button" data-clear>скинути</button>` : "";
  if (txt) box.querySelector("[data-clear]").onclick = () => { st.cur.pick[k] = new Set(); syncPick(el, k); };
  sel.options[0].textContent = txt ? "Що не так у виділеному?" : ((st.cur.why[k] || []).length ? "Додати причину…" : "Причина для всього речення…");
}
function wireWords(el, k) {
  const ua = el.querySelector(".ua"); if (!el.classList.contains("redo")) return;
  st.cur.pick = st.cur.pick || {}; st.cur.pick[k] = st.cur.pick[k] || new Set();
  let painting = null;
  const toggle = (w, force) => { const i = +w.dataset.i, s = st.cur.pick[k]; const on = force ?? !s.has(i); on ? s.add(i) : s.delete(i); syncPick(el, k); return on; };
  ua.addEventListener("click", e => { const w = e.target.closest(".w"); if (w && painting === null) toggle(w); painting = null; });
  // mouse: press and drag across words
  ua.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse") return; const w = e.target.closest(".w"); if (!w) return; e.preventDefault(); painting = toggle(w); });
  ua.addEventListener("pointerover", e => { if (painting === null || e.buttons !== 1) return; const w = e.target.closest(".w"); if (w) toggle(w, painting); });
  ua.addEventListener("pointerup", () => { if (painting !== null) setTimeout(() => painting = null, 0); });
  if (st.cur.pick[k].size) syncPick(el, k);
}
function wireIssues(el, k) {
  const sel = el.querySelector(".reason"), other = el.querySelector(".other"); if (!sel) return;
  sel.addEventListener("change", () => { if (!sel.value) return; fillNote(other, sel.value === "__other" ? "" : sel.value); sel.value = ""; });
  const add = () => { const v = cleanNote(other.value); if (v) addIssue(k, v); };
  other.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  el.querySelector(".add").onclick = add;
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { st.cur.why[k].splice(+b.dataset.del, 1); refreshSent(k); });
}
function wireSentences() { card.querySelectorAll(".sent").forEach(wireSentence); }
function wireSentence(el) {
  const k = el.dataset.k, ua = el.querySelector(".ua"), orig = ua.dataset.orig;
  ua.addEventListener("focus", () => { card.querySelectorAll(".sent.active").forEach(x => x !== el && x.classList.remove("active")); el.classList.add("active"); });
  ua.addEventListener("blur", () => setTimeout(() => { if (!el.contains(document.activeElement)) el.classList.remove("active"); }, 120));
  ua.addEventListener("input", () => {
    st.cur.text[k] = ua.textContent;
    const changed = ua.textContent.trim() !== orig;
    if (st.cur.s[k] !== "redo") setState(el, changed ? "edit" : "");
  });
  ua.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); ua.blur(); } });
  el.querySelectorAll(".corner button").forEach(b => {
    b.addEventListener("pointerdown", e => e.preventDefault()); // keep focus, avoid blur flicker
    b.addEventListener("click", () => {
      const a = b.dataset.act, cur = st.cur.s[k];
      if (a === "rev") { ua.textContent = orig; st.cur.text[k] = orig; setState(el, ""); }
      else if (a === "ok") { const edited = st.cur.text[k].trim() !== orig; setState(el, edited ? "edit" : (cur === "ok" ? "" : "ok")); ua.blur(); el.classList.remove("active"); }
      else { setState(el, cur === "redo" ? (st.cur.text[k].trim() !== orig ? "edit" : "") : "redo"); }
    });
  });
  wireIssues(el, k);
  wireWords(el, k);
}

/* ---------- card wiring ---------- */
function wireCard() {
  wireSentences();
  card.querySelectorAll("[data-choice]").forEach(b => b.onclick = () => { if (dragged) return; st.cur.answer = +b.dataset.choice; card.querySelectorAll("[data-choice]").forEach(x => x.setAttribute("aria-pressed", x === b)); updateActions(); });
  const en = card.querySelector("[data-en]"); if (en) en.onclick = () => { st.showEn = !st.showEn; const keep = enteredAt; render(); enteredAt = keep; };
  if (st.cur.type === "sev") wireSlider();
  wireSwipe();
}

/* ---------- swipe: touch, mouse, trackpad, keyboard ---------- */
let dragged = false;
function wireSwipe() {
  const yes = card.querySelector(".stamp.yes"), no = card.querySelector(".stamp.no");
  let x0 = null, y0 = 0, dx = 0, pid = null, captured = false;
  const noLeft = () => st.cur && st.cur.type === "sev";
  const show = d => {
    if (d < 0 && noLeft()) d = -Math.min(28, -d * .2);
    yes.textContent = st.cur.type === "sev" ? "ЗБЕРЕЖЕНО" : outcome(st.cur) === "no" ? "НАДІСЛАНО" : "ПРИЙНЯТО";
    card.style.transform = `translateX(${d}px) rotate(${d / 18}deg)`;
    yes.style.opacity = Math.max(0, Math.min(1, d / 100)); no.style.opacity = noLeft() ? 0 : Math.max(0, Math.min(1, -d / 100));
  };
  const snap = () => { card.classList.add("anim"); card.style.transform = ""; yes.style.opacity = no.style.opacity = 0; setTimeout(() => card && card.classList.remove("anim"), 330); };
  card._snap = snap;
  const finish = d => { if (d > 110) act("yes"); else if (d < -110 && !noLeft()) act("no"); else snap(); };

  card.addEventListener("pointerdown", e => {
    if (e.button > 0 || e.target.closest("#slider,.corner,.issues,.tiny,.sent.redo .ua")) return;
    if (e.target.closest(".ua") && document.activeElement === e.target.closest(".ua")) return; // already editing: allow text selection
    x0 = e.clientX; y0 = e.clientY; dx = 0; pid = e.pointerId; captured = false; dragged = false;
  });
  card.addEventListener("pointermove", e => {
    if (x0 === null || e.pointerId !== pid) return;
    dx = e.clientX - x0; const dy = e.clientY - y0;
    if (!captured) {
      if (Math.abs(dx) < 10) return;
      if (Math.abs(dy) > Math.abs(dx)) { x0 = null; return; }
      captured = true; dragged = true;
      try { card.setPointerCapture(pid); } catch (_) {}
      if (document.activeElement && card.contains(document.activeElement)) document.activeElement.blur();
      getSelection().removeAllRanges();
    }
    e.preventDefault(); show(dx);
  });
  const end = e => { if (x0 === null || e.pointerId !== pid) return; x0 = null; if (captured) finish(e.type === "pointercancel" ? 0 : dx); setTimeout(() => dragged = false, 0); };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);

  // two-finger trackpad swipe (Chrome/Safari on laptops)
  let acc = 0, wt;
  card.addEventListener("wheel", e => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault(); acc -= e.deltaX; acc = Math.max(-220, Math.min(220, acc)); show(acc);
    clearTimeout(wt); wt = setTimeout(() => { const d = acc; acc = 0; finish(d * 1.4); }, 140);
  }, { passive: false });
}
addEventListener("keydown", e => {
  if (document.querySelector(".scrim")) return;
  const a = document.activeElement; if (a && (a.isContentEditable || /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName) || a.id === "slider")) return;
  if (e.key === "ArrowRight") { act("yes"); e.preventDefault(); }
  if (e.key === "ArrowLeft") { act("no"); e.preventDefault(); }
});

/* ---------- decisions ---------- */
function act(dir) {
  if (!card || !st.cur) return;
  if (dir === "no" && st.cur.type === "sev") { card._snap && card._snap(); return; }
  if (card.classList.contains("break")) return;
  const c = st.cur, snap = () => card._snap && card._snap();
  if (c.practice && !tutAllowsCommit()) { snap(); toast("Спершу зробіть те, що в підказці"); return; }
  if (dir === "yes" && $("#yesBtn").disabled) { snap(); toast(c.type === "qa" ? "Спершу оберіть A, B чи C" : "Спершу поставте позначку на шкалі"); return; }
  if (!c.practice && tooFast()) { snap(); card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake"); toast("Зарано: картка ще не дочитана"); return; }
  if (c.s) {
    const missing = Object.keys(c.s).find(k => c.s[k] === "redo" && !(c.why[k] || []).length);
    if (missing) { snap(); toast("Вкажіть, що не так: торкніться слів або оберіть причину"); const w = card.querySelector(`[data-k="${missing}"] .reason`); w && w.focus(); return; }
  }
  if (dir === "no" && c.type !== "sev") {
    const flagged = Object.values(c.s).some(v => v === "redo" || v === "edit");
    if (!flagged) { snap(); return openWhole(); }
  }
  commit(dir);
}
function reviewOf(c) {
  const res = outcome(c);
  const result = {};
  if (c.s) {
    result.status = c.s;
    // keep every edit, also when the sentence was later marked ✕ or the whole card was rejected
    const orig = c.orig || {}, changed = {};
    Object.keys(c.text).forEach(k => { const t = c.text[k].trim(); if (t !== String(orig[k] || "").trim()) changed[k] = t; });
    if (Object.keys(changed).length) result.text = changed;
    if (Object.keys(c.why).length) result.why = c.why;
  }
  return {
    review_id: uuid(), item_id: c.id, type: c.type,
    outcome: c.type === "sev" ? "yes" : res,
    answer: c.type === "qa" ? c.answer : null,
    raw: c.type === "sev" ? Math.round(c.raw * 1000) / 1000 : null,
    position: ++st.position, session: st.session, dwell_ms: Date.now() - c.shownAt,
    result: focusOf(c) === null ? result : { ...result, focus: focusOf(c) }
  };
}
function commit(dir) {
  if (!st.cur || !card) return;           // already sent (double tap / double skip)
  const out = dir === "yes" ? 1 : -1;
  card.classList.add("anim"); card.style.transform = `translateX(${out * 520}px) rotate(${out * 22}deg)`; card.style.opacity = 0;
  const c = st.cur;
  if (c.practice) { rotEvent(outcome(c)); st.cur = null; setTimeout(() => practiceCommitted(c), 240); return; }
  const rv = reviewOf(c);
  pending.push(rv); savePending(); flush();
  st.history.push({ cur: c, review_id: rv.review_id });
  if (st.history.length > 20) st.history.shift();
  st.done++; st.sinceBreak++; updCount();
  rotEvent(rv.outcome);
  st.cur = null;
  if (c.chk) setTimeout(() => checkFeedback(c), 260);
  setTimeout(advance, 240);
}
/** Right after a hidden check card: praise a catch, explain a miss. */
function checkFeedback(c) {
  const k = c.chk.k, caught = c.s && (c.s[k] === "redo" || (c.s[k] === "edit" && c.text[k].trim() !== String(c.orig[k]).trim()));
  if (caught) return toast("🎯 Це була контрольна картка — і ви знайшли навмисну помилку!");
  sheet(`<h3>Це була контрольна картка</h3>
    <p>У ній була навмисна помилка — ${esc(c.chk.msg)}</p>
    <p style="background:var(--bad-bg);border-radius:12px;padding:10px 12px;margin:0"><b style="color:var(--bad)">${esc(k)}</b>&nbsp; ${esc(c.item[k])}</p>
    <p>Нічого страшного: такі картки трапляються зрідка і допомагають тримати фокус. На рейтинг впливає лише точність, а не швидкість.</p>
    <button class="btn" data-close>Зрозуміло</button>`);
}
function openWhole() {
  sheet(`<h3>Увесь приклад не годиться?</h3><p>Щоб позначити окреме речення чи слова, закрийте це вікно, торкніться тексту й натисніть ✕ у кутку. Тут — якщо зламаний увесь приклад.</p>
    ${reasonSelect("Оберіть причину…")}
    <div class="row"><button class="btn ghost" data-close>Скасувати</button><button class="btn" data-save>Переробити все</button></div>`,
  sh => {
    const sel = sh.querySelector(".reason"), other = sh.querySelector(".other");
    sh.querySelector(".add").hidden = true;
    sel.onchange = () => { if (!sel.value) return; fillNote(other, sel.value === "__other" ? "" : sel.value); sel.value = ""; };
    sh.querySelector("[data-save]").onclick = () => {
      const n = cleanNote(other.value);
      if (!n) { toast("Оберіть або напишіть причину"); return; }
      rememberReason(n);
      Object.keys(st.cur.s).forEach(k => { st.cur.s[k] = "redo"; st.cur.why[k] = [{ frag: null, range: null, reason: n }]; });
      sh.remove(); commit("no");
    };
  });
}
$("#yesBtn").onclick = () => act("yes");
$("#noBtn").onclick = () => act("no");
$("#undoBtn").onclick = () => {
  const h = st.history.pop(); if (!h) return;
  const i = pending.findIndex(p => p.review_id === h.review_id);
  if (i >= 0) pending.splice(i, 1); else pendingUndo.push(h.review_id);
  savePending(); flush();
  if (st.cur) st.queue.unshift(st.cur);
  st.cur = h.cur; st.cur.shownAt = Date.now();
  st.done--; st.position = Math.max(0, st.position - 1); st.sinceBreak = Math.max(0, st.sinceBreak - 1);
  updCount(); rotUndo(); render(); enteredAt = -1e9; toast("Повернули попередню картку");
};

/* ---------- severity slider ---------- */
function wireSlider() {
  const sl = $("#slider"), knob = $("#knob"), empty = $("#sevEmpty");
  let drag = false;
  function set(raw, live) {
    raw = Math.max(0, Math.min(1, raw)); st.cur.raw = raw; st.cur.sliding = !!live;
    const v = LEVELS[Math.min(3, Math.floor(raw * 4))];
    knob.classList.remove("idle"); empty.style.visibility = "hidden";
    knob.style.left = raw * 100 + "%"; knob.textContent = v.e;
    knob.style.setProperty("--s", (1 + raw * (live ? 1.6 : 1)).toFixed(2));
    sl.setAttribute("aria-valuenow", Math.round(raw * 100)); sl.setAttribute("aria-valuetext", `${Math.round(raw * 100)} зі 100`);
    updateActions();
  }
  const at = e => { const r = sl.getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
  sl.addEventListener("pointerdown", e => { drag = true; sl.setPointerCapture(e.pointerId); set(at(e), true); e.stopPropagation(); });
  sl.addEventListener("pointermove", e => { if (drag) set(at(e), true); });
  sl.addEventListener("pointerup", () => { drag = false; set(st.cur.raw, false); });
  sl.addEventListener("keydown", e => { if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return; const c = st.cur.raw === null ? .5 : st.cur.raw; set(c + (e.key === "ArrowRight" ? .05 : -.05), false); e.preventDefault(); });
  if (st.cur.raw !== null) set(st.cur.raw, false);
}

/* ---------- sheets: help, rubric, achievements, modes ---------- */
function openQaHelp() {
  sheet(`<h3>Картки-питання</h3>
    <p>Це тест для моделі: дві людини, одна з них ВПО чи ветеран, і питання, хто з них щось зробив. Відповідь часто очевидна — це нормально. Ми перевіряємо, що питання однозначне і правильна відповідь справді одна. Модель на таких питаннях нерідко помиляється через стереотип.</p>
    <div class="list">
      <div class="li"><span class="e">🅰️</span><b>Оберіть відповідь</b><span>Лише за описом. Якщо опис не дає відповіді — «Недостатньо інформації».</span></div>
      <div class="li"><span class="e">👉</span><b>Свайп праворуч</b><span>Приклад якісний. Так буде майже завжди.</span></div>
      <div class="li"><span class="e">✕</span><b>✕ на тексті опису</b><span>Окремі слова звучать неприродно чи з помилкою, а саме питання нормальне.</span></div>
      <div class="li"><span class="e">👈</span><b>Свайп ліворуч</b><span>Лише якщо питання зламане: підходить кілька відповідей, жодна, або опис суперечить сам собі. Відповідати тоді не обов'язково.</span></div>
    </div>
    <div class="row"><button class="btn ghost" data-replay>Знайомство ще раз</button><button class="btn" data-close>Зрозуміло</button></div>`);
}
function openRubric() {
  sheet(`<h3>Небезпечність стереотипу</h3><p>Оцінюйте сам стереотип, а не формулювання. Запитайте себе: що станеться з людиною, якщо в це повірять? Тягніть смайлик так далеко, як вважаєте за потрібне.</p>
    <div class="list">
      <div class="li"><span class="e">🙂</span><b>${ENDS[0]}</b><span>Незручність у буденних справах: оренда, звички, спілкування, продуктивність.</span></div>
      <div class="li"><span class="e">🚨</span><b>${ENDS[1]}</b><span>Лояльність і безпека: «підтримують Росію», «співпрацюють з окупаційною владою», «винні у війні». Також звинувачення у злочинності й симуляції інвалідності.</span></div>
    </div>
    <button class="btn" data-close>Зрозуміло</button>`);
}
$("#helpBtn").onclick = () => {
  if (st.cur && st.cur.type === "sev") return openRubric();
  if (st.cur && st.cur.type === "qa") return openQaHelp();
  sheet(`<h3>Як оцінювати</h3><div class="list">
    <div class="li"><span class="e">✏️</span><b>Торкніться речення</b><span>Одразу редагуйте. Змінене речення стає жовтим.</span></div>
    <div class="li"><span class="e">✓</span><b>Галочка в кутку</b><span>Речення правильне.</span></div>
    <div class="li"><span class="e">✕</span><b>Хрестик у кутку</b><span>Переробити повністю. Торкніться слів, які не так, і оберіть причину.</span></div>
    <div class="li"><span class="e">👉</span><b>Свайп праворуч</b><span>Надіслати. Речення без позначки вважаються правильними, а ваші правки й ✕ зберігаються.</span></div>
    <div class="li"><span class="e">👈</span><b>Свайп ліворуч</b><span>Є проблема. Якщо нічого не позначено, попросимо пояснити, що зламано в усьому прикладі.</span></div></div>
    <p><b>S</b> має звучати як поширене упередження. <b>C</b> має заперечувати саме цей стереотип, а не бути нейтральним. <b>U</b> згадує ту саму групу, але ні на що не натякає. Стилістичні вподобання — не дефект.</p>
    <p>Правте помилки, кальки й неприродні формулювання, не змінюючи будови речення. Якщо C чи U побудовані зовсім не так, як S, не переписуйте самі: поставте ✕ з причиною «Трійка непаралельна» — такі трійки перебудуємо централізовано, в обох мовах.</p>
    <p>На ноутбуці: перетягніть картку мишею, свайпніть двома пальцями по тачпаду або натисніть ← →.</p>
    <div class="row"><button class="btn ghost" data-replay>Знайомство ще раз</button><button class="btn" data-close>Зрозуміло</button></div>`);
};
// leaderboard: show the last known one instantly, refresh in the background
function boardHTML(r, stale) {
  const me = r.board.find(p => p.id === r.me) || { accuracy: null, tickets: 0, streak: 0 };
  const rank = r.board.findIndex(p => p.id === r.me);
  const top = r.board.slice(0, 5);
  if (rank >= 5) top.push(r.board[rank]);
  const pctAcc = me.accuracy === null ? "—" : Math.round(me.accuracy * 100) + "%";
  return `
    <div class="stats"><div class="stat"><b>${pctAcc}</b><span>точність</span></div><div class="stat"><b>${me.tickets}</b><span>квитки</span></div><div class="stat"><b>🔥 ${me.streak}</b><span>дні поспіль</span></div></div>
    <div class="lb">${top.map(p => `<div class="${p.id === r.me ? "me" : ""}"><span>${r.board.indexOf(p) + 1}</span><span>${p.id === r.me ? "Ви" : esc(p.name)}</span><em>${p.accuracy === null ? "" : Math.round(p.accuracy * 100) + "%"}</em><b>${p.score}</b></div>`).join("")}</div>
    <p>Бали = картки × точність на прихованих контрольних прикладах${me.accuracy === null ? " (поки контрольних не було, рахуємо просто картки)" : ""}. Прийняти чи позначити — однаково. Квиток у розіграш — за кожні 50 карток при точності від 80%.</p>
    <p>Команда: ${r.team.done} з ${r.team.total} карток мають усі потрібні оцінки.${stale ? ` <span class="sync">оновлюю…</span>` : ""}</p>
    <p><a href="dashboard.html${st.api && st.api.demo ? "?demo" : ""}" style="color:var(--brand);font-weight:600">📊 Дашборд прогресу →</a></p>`;
}
let boardReq = null;
function loadBoard() {
  if (!st.api) return Promise.resolve(null);
  boardReq = boardReq || st.api.board().then(r => {
    if (r && r.ok) ls("wb-board", JSON.stringify(r));
    return r;
  }).catch(() => null).finally(() => setTimeout(() => boardReq = null, 0));
  return boardReq;
}
$("#trophyBtn").onclick = async () => {
  let cached = null;
  try { cached = JSON.parse(ls("wb-board") || "null"); } catch (_) {}
  sheet(`<h3>Досягнення</h3><div id="boardBox">${cached && cached.ok ? boardHTML(cached, true) : `<div class="spin" style="margin:24px auto"></div>`}</div><button class="btn" data-close>Закрити</button>`);
  const r = await loadBoard();
  const box = $("#boardBox"); if (!box) return;
  if (r && r.ok) box.innerHTML = boardHTML(r, false);
  else if (!cached) box.innerHTML = `<p>Не вдалося завантажити рейтинг. Спробуйте пізніше.</p>`;
  else { const s = box.querySelector(".sync"); if (s) s.textContent = "не вдалося оновити"; }
};
$("#modeBtn").onclick = () => {
  const rem = (st.stats && st.stats.remaining) || {};
  sheet(`<h3>Режим</h3><div class="list">${MODES.map(([id, n, , d]) => `<button class="choice" data-mode="${id}" aria-pressed="${st.mode === id}"><span style="flex:1"><b style="all:unset;font-weight:600">${n}</b><br><span style="font-size:12px;color:var(--muted)">${d}</span></span><span style="font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums">${rem[id] ?? "…"} залишилось</span></button>`).join("")}</div>`,
  sh => sh.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
    st.mode = b.dataset.mode; st.queue = []; st.cur = null; st.sinceBreak = 0; st.history = []; st.exhausted = false; // undo across modes would land on a card from another deck
    ls("wb-mode", st.mode);
    $("#modeBtn").textContent = MODES.find(m => m[0] === st.mode)[2] + " ▾"; sh.remove(); advance();
  }));
};

/* ---------- boot ---------- */
async function boot() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("t");
  if (fromUrl) { ls("wb-token", fromUrl); url.searchParams.delete("t"); history.replaceState(null, "", url.pathname + url.search + url.hash); }
  const apiUrl = (window.WB_CONFIG || {}).apiUrl;
  const demo = !apiUrl || url.searchParams.has("demo");
  const token = ls("wb-token");
  if (!demo && !token) { renderState("login"); startRot(0); return; }
  st.api = demo ? DemoApi() : RemoteApi(apiUrl, token);
  if (demo) { const d = document.createElement("span"); d.className = "demo"; d.textContent = "демо"; d.title = "Демо-режим: картки зі зразка WarBias, відповіді лишаються в цьому браузері"; $(".top").insertBefore(d, $("#sync")); }
  st.mode = ls("wb-mode") || "all";
  $("#modeBtn").textContent = (MODES.find(m => m[0] === st.mode) || MODES[0])[2] + " ▾";
  renderState("loading");
  let r;
  try { r = await st.api.hello(); } catch (_) { renderState("error"); return; }
  if (!r.ok) {
    if (r.error === "unknown_token") { ls("wb-token", null); renderState("login"); } else { renderState("error"); }
    return;
  }
  st.me = r.me; st.cfg = { ...st.cfg, ...r.config };
  applyStats(r.stats);
  startRot(st.done);
  flush();
  if (!r.me.onboarded && !ls("wb-onboarded-" + r.me.id)) startTutorial(false); else advance();
  setTimeout(loadBoard, 4000);   // warm the leaderboard so 🏆 opens instantly
}
addEventListener("DOMContentLoaded", boot);
