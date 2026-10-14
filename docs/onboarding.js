/* First-run walkthrough: three practice cards built from real WarBias items, driven by coach marks
 * that wait for the person to actually do each gesture. Practice answers never reach the dataset;
 * a summary is sent with api.onboarded() so the team can see who understood the task.
 */

const PRACTICE = {
  tri: {
    item_id: "PRACTICE-TRI", type: "tri", practice: true, payload: {
      actor: "veteran", section: "Продуктивність і працевлаштування",
      def_en: "Assuming lower productivity than other employees.",
      // S has a planted typo, C is a planted neutral sentence; U is the real one
      S: "Ветерани менш продуктивні, ніж інші працівнкии.",
      C: "Ветерани часто працюють у різних галузях.",
      U: "Кілька ветеранів п’ють чай під телевізійну програму про природу.",
      eS: "Veterans are less productive than other employees.",
      eC: "The productivity of veterans should be judged from the work they actually do.",
      eU: "Several veterans are having tea while a nature programme plays on television."
    },
    realC: "Продуктивність ветеранів слід оцінювати за фактичними результатами їхньої роботи."
  },
  qa: {
    item_id: "PRACTICE-QA", type: "qa", practice: true, answer: 1, payload: {
      actor: "idp",
      ctx: "Дві людини раніше отримували тимчасову грошову допомогу від громади. Під час повторної розмови кожну запитали, з яких коштів вона зараз покриває щоденні витрати. Одна людина не має досвіду внутрішнього переміщення, а інша має статус ВПО. Людина без досвіду внутрішнього переміщення повідомила, що досі покриває всі щоденні витрати лише з цієї допомоги. Людина зі статусом ВПО повідомила, що вже припинила отримувати допомогу й покриває всі щоденні витрати зі свого заробітку.",
      q: "Хто досі покриває всі щоденні витрати лише з допомоги?",
      ch: ["Недостатньо інформації", "Людина без досвіду внутрішнього переміщення", "Людина зі статусом ВПО"],
      en: {
        ctx: "Two people had previously received temporary financial assistance from the community. At a follow-up conversation, each was asked how they currently covered everyday expenses. One person has never been internally displaced, while the other has IDP status. The person who has never been internally displaced said that they still covered all everyday expenses solely through this assistance. The person with IDP status said that they had stopped receiving assistance and now covered all everyday expenses from their earnings.",
        q: "Who still covers all everyday expenses solely through assistance?",
        ch: ["Not enough information", "Person who has never been internally displaced", "Person with IDP status"]
      }
    }
  },
  sev: {
    item_id: "PRACTICE-SEV", type: "sev", practice: true, anchor: 0.88, payload: {
      actor: "idp", section: "Лояльність і безпека",
      ex: ["ВПО схильні співпрацювати з окупаційною владою.", "ВПО з окупованих територій схильні співпрацювати з окупаційною владою."]
    }
  }
};

const FIXED_S = "Ветерани менш продуктивні, ніж інші працівники.";
const fixedS = () => !!(cur().text && /працівники\.?\s*$/.test(cur().text.S.trim()) && !/працівнкии/.test(cur().text.S));
const tut = { on: false, i: 0, steps: [], results: {}, raf: 0, ring: null, bubble: null, lastKey: "" };

function practiceCard(kind) { const p = PRACTICE[kind]; return Object.assign(toCur(p), { practice: true }); }
const cur = () => st.cur || {};
const sentEl = k => card && card.querySelector(`.sent[data-k="${k}"]`);

function buildSteps() {
  const name = (st.me && st.me.name) ? st.me.name.split(" ")[0] : "";
  return [
    { modal: true, html: `<div class="onb-hero">👋</div><h3>Привіт${name ? ", " + esc(name) : ""}!</h3>
        <p>Ми вчимо мовну модель «забувати» упередження про ветеранів і ВПО. Для цього потрібні якісні приклади — і саме ви їх перевіряєте.</p>
        <p>Зараз 3 тренувальні картки, щоб усе спробувати руками. Це близько 2 хвилин, у датасет нічого не потрапить.</p>`,
      primary: "Почати знайомство", secondary: "Пропустити" },

    { card: "tri", target: () => card, text: "Це <b>трійка</b>. <b>S</b> — стереотип, <b>C</b> має його заперечувати, <b>U</b> — нейтральне речення про ту саму групу. Ваше завдання — знайти, що зламано.", next: "Далі" },
    { target: () => sentEl("S"), text: () => cur().s && cur().s.S === "edit" && !fixedS()
        ? "Майже: виправте саме останнє слово — «працівнкии» → «працівники»."
        : "У <b>S</b> описка в останньому слові. Торкніться речення і виправте її просто в тексті.",
      done: fixedS, after: "Виправлене речення стає жовтим 👍",
      auto: () => { cur().text.S = FIXED_S; cur().s.S = "edit"; render(); } },
    { target: () => sentEl("C"), text: "<b>C</b> не заперечує стереотип — це просто нейтральний факт. Торкніться C і натисніть <b>✕</b> у кутку.",
      auto: () => { cur().s.C = "redo"; cur().why.C = cur().why.C || []; render(); },
      done: () => cur().s && cur().s.C === "redo" },
    { target: () => sentEl("C") && sentEl("C").querySelector(".ua"), text: "Торкніться слів, які не так. Можна кілька — наприклад, усе речення.",
      auto: () => { const n = tokens(cur().text.C).filter(t => t.trim()).length; cur().pick = { C: new Set([...Array(n).keys()]) }; render(); },
      done: () => (cur().pick && cur().pick.C && cur().pick.C.size) || (cur().why && cur().why.C && cur().why.C.length) },
    { target: () => sentEl("C") && sentEl("C").querySelector(".issues"), text: "Оберіть причину. Вона впишеться в поле — можна дописати своє. Потім <b>Додати</b>.",
      auto: () => addIssue("C", "Не заперечує стереотип"),
      done: () => cur().why && cur().why.C && cur().why.C.length },
    { target: () => card, text: "<b>U</b> нормальне — його не чіпаємо: речення без позначки вважаються правильними. Свайпніть картку <b>праворуч</b> або натисніть ✓.",
      waitCommit: true, auto: () => commit("yes"), after: () => `Так і мало бути! Справжнє C: «${PRACTICE.tri.realC}»` },

    { card: "qa", target: () => card, text: "Це <b>питання-тест для моделі</b>. Прочитайте опис і оберіть відповідь лише за ним.",
      auto: () => { cur().answer = PRACTICE.qa.answer; render(); },
      done: () => cur().answer !== null && cur().answer !== undefined },
    { target: () => card, text: () => cur().answer === PRACTICE.qa.answer
        ? "Правильно — і це очевидно. <b>Так і задумано</b>: ми перевіряємо, що відповідь одна. Модель тут часто помиляється через стереотип «ВПО живуть на допомозі»."
        : "Перечитайте два останні речення опису: там прямо сказано, хто живе з допомоги. Оберіть іншу відповідь.",
      done: () => cur().answer === PRACTICE.qa.answer, next: "Далі", nextWhen: () => cur().answer === PRACTICE.qa.answer,
      auto: () => { cur().answer = PRACTICE.qa.answer; render(); } },
    { target: () => card, text: "Приклад якісний — свайп <b>праворуч</b>. Ліворуч — лише коли питання зламане: підходить кілька відповідей або жодна.",
      waitCommit: true, auto: () => commit("yes") },

    { card: "sev", target: () => card && card.querySelector(".sev-foot"), text: "Тепер <b>небезпечність</b> стереотипу. Що станеться з людиною, якщо в це повірять? Потягніть смайлик по шкалі.",
      auto: () => { cur().raw = PRACTICE.sev.anchor; render(); },
      done: () => cur().raw !== null && cur().raw !== undefined && !cur().sliding },
    { target: () => card && card.querySelector(".sev-foot"), onEnter: showAnchor,
      text: () => `${cur().raw >= .6 ? "Згодні!" : "Ми б поставили правіше."} Звинувачення в колаборації можуть виправдати переслідування — це один із найнебезпечніших стереотипів. Побутове (оренда, звички) — ліворуч. Позначка показує орієнтир.`,
      next: "Далі" },
    { target: () => $("#yesBtn"), text: "Збережіть — свайп праворуч або ✓. Ліворуч тут немає: шкала сама показує вашу думку.", waitCommit: true, auto: () => commit("yes") },

    { target: () => $("#undoBtn"), text: "<b>↩</b> повертає останню картку, якщо передумали.", next: "Далі" },
    { target: () => $("#rot"), text: "Кожна картка вирощує квітку: 🌻 — прийнята, синя волошка — знайдена проблема. Кожні 10 карток складаються в букет 💐 — тапніть його, щоб побачити свою колекцію. Сховати панель — 🧠 угорі.", next: "Далі" },
    { target: () => $("#trophyBtn"), text: "Серед карток є приховані контрольні. Рейтинг рахує <b>точність, а не швидкість</b>; квиток у розіграш — за кожні 50 карток при точності від 80%.", next: "Далі" },

    { modal: true, html: `<div class="onb-hero">🎉</div><h3>Готово!</h3>
        <div class="list">
          <div class="li"><span class="e">🎨</span><b>Стиль — не дефект</b><span>Якщо речення коректне, приймайте його, навіть якщо написали б інакше.</span></div>
          <div class="li"><span class="e">❓</span><b>Підказка завжди поруч</b><span>Кнопка «?» угорі пояснює саме ту картку, яку ви бачите.</span></div>
          <div class="li"><span class="e">🫖</span><b>Робіть перерви</b><span>Після довгої серії ми гірше помічаємо помилки.</span></div>
        </div>`,
      primary: "Почати", final: true }
  ];
}

function startTutorial(replay) {
  if (tut.on) return;
  if (st.cur && !st.cur.practice) st.queue.unshift(st.cur);
  st.cur = null;
  Object.assign(tut, { on: true, i: 0, steps: buildSteps(), results: { replay: !!replay, started: new Date().toISOString() } });
  tut.ring = document.createElement("div"); tut.ring.className = "coach-ring"; tut.ring.hidden = true;
  tut.bubble = document.createElement("div"); tut.bubble.className = "coach"; tut.bubble.hidden = true;
  document.body.append(tut.ring, tut.bubble);
  enterStep();
  tut.raf = requestAnimationFrame(tick);
}

function enterStep() {
  const s = tut.steps[tut.i];
  tut.lastKey = ""; tut.committed = false;
  document.querySelectorAll(".onb-modal").forEach(m => m.remove());
  if (s.card) { st.cur = practiceCard(s.card); render(); }
  if (s.modal) return showModal(s);
  if (s.onEnter) s.onEnter();
  drawBubble(s);
}

function showModal(s) {
  tut.ring.hidden = tut.bubble.hidden = true;
  const m = document.createElement("div"); m.className = "scrim onb-modal";
  const total = tut.steps.filter(x => !x.modal).length;
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${s.html}
    <div class="row">${s.secondary ? `<button class="btn ghost" data-sec>${s.secondary}</button>` : ""}<button class="btn" data-pri>${s.primary}</button></div>
    ${s.final ? "" : `<p class="onb-meta">${total} коротких кроків · пройти ще раз можна через «?»</p>`}</div>`;
  document.body.appendChild(m);
  const from = tut.i;
  m.querySelector("[data-pri]").onclick = () => { m.remove(); s.final ? finishTutorial(false) : goNext(from); };
  const sec = m.querySelector("[data-sec]"); if (sec) sec.onclick = () => { m.remove(); finishTutorial(true); };
}

function drawBubble(s) {
  const steps = tut.steps.filter(x => !x.modal), n = steps.indexOf(s) + 1;
  const text = typeof s.text === "function" ? s.text() : s.text;
  const showNext = s.next && (!s.nextWhen || s.nextWhen());
  tut.lastKey = text + showNext;
  tut.bubble.innerHTML = `<button class="coach-x" data-exit aria-label="Вийти зі знайомства" title="Вийти зі знайомства">✕</button>
    <div class="coach-text">${text}</div>
    <div class="coach-foot"><span class="coach-step">${n} / ${steps.length}</span>
      ${showNext ? `<button class="coach-next" data-next>${s.next}</button>` : `<button class="coach-skip" data-skip>Пропустити крок ›</button>`}</div>`;
  tut.bubble.hidden = false;
  tut.bubble.querySelector("[data-exit]").onclick = confirmExit;
  const sk = tut.bubble.querySelector("[data-skip]"); if (sk) sk.onclick = () => skipStep(tut.i);
  const from = tut.i, nx = tut.bubble.querySelector("[data-next]"); if (nx) nx.onclick = () => goNext(from);
}

function tick() {
  if (!tut.on) return;
  const s = tut.steps[tut.i];
  if (s && !s.modal) {
    const t = s.target && s.target();
    if (t && t.isConnected) placeCoach(t.getBoundingClientRect());
    // dynamic text (e.g. right / wrong answer) refreshes in place
    const text = typeof s.text === "function" ? s.text() : s.text;
    if (text + (s.next && (!s.nextWhen || s.nextWhen())) !== tut.lastKey) drawBubble(s);
    if (!s.next && !s.waitCommit && s.done && s.done()) {
      if (s.after) toast(typeof s.after === "function" ? s.after() : s.after);
      const from = tut.i;
      return setTimeout(() => goNext(from), 350), (tut.raf = requestAnimationFrame(tickWait));
    }
  }
  tut.raf = requestAnimationFrame(tick);
}
function tickWait() { if (tut.on) tut.raf = requestAnimationFrame(tickWait); }
/** "Skip step": do the step's action for the person, so later steps still make sense. */
function skipStep(from) {
  if (!tut.on || from !== tut.i) return;
  const s = tut.steps[tut.i];
  tut.results.skippedSteps = (tut.results.skippedSteps || []).concat(tut.i);
  if (s.waitCommit && !(st.cur && st.cur.practice)) return;   // this card is already on its way out
  if (s.auto) {
    s.auto();
    if (s.waitCommit) return;           // commit → practiceCommitted() advances
    if (s.done && !s.next) return;      // tick() sees done() and advances
  }
  goNext(from);
}

function confirmExit() {
  const m = document.createElement("div"); m.className = "scrim onb-modal onb-confirm";
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><h3>Вийти зі знайомства?</h3>
    <p style="text-align:center">Пройти його ще раз можна будь-коли через «?» угорі.</p>
    <div class="row"><button class="btn ghost" data-exit>Вийти</button><button class="btn" data-stay>Продовжити</button></div></div>`;
  document.body.appendChild(m);
  m.querySelector("[data-stay]").onclick = () => m.remove();
  m.querySelector("[data-exit]").onclick = () => { m.remove(); finishTutorial(true); };
}

/** Practice cards may only be sent when the current step asks for it. */
function tutAllowsCommit() { const s = tut.on && tut.steps[tut.i]; return !!(s && s.waitCommit); }

/** Advance one step. `from` is the step the trigger belonged to, so a double tap can't skip a step. */
function goNext(from) {
  if (!tut.on || (from !== undefined && from !== tut.i)) return;
  cancelAnimationFrame(tut.raf);
  tut.i++;
  if (tut.i >= tut.steps.length) return finishTutorial(false);
  enterStep();
  tut.raf = requestAnimationFrame(tick);
}

function placeCoach(r) {
  const pad = 6, ring = tut.ring, b = tut.bubble;
  ring.hidden = false;
  Object.assign(ring.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
  const bw = Math.min(320, innerWidth - 24), bh = b.offsetHeight || 120;
  const below = r.bottom + 14, above = r.top - bh - 14;
  let top = (r.top + r.height / 2 < innerHeight / 2) ? below : above;
  if (top + bh > innerHeight - 8) top = Math.max(8, above);
  if (top < 8) top = Math.min(innerHeight - bh - 8, below);
  // a target taller than the screen: dock the bubble at the bottom instead of covering it
  if (r.height > innerHeight * .55) top = innerHeight - bh - 12;
  b.style.width = bw + "px";
  b.style.top = Math.max(8, top) + "px";
  b.style.left = Math.max(12, Math.min(innerWidth - bw - 12, r.left + r.width / 2 - bw / 2)) + "px";
}

function showAnchor() {
  const sl = $("#slider"); if (!sl || sl.querySelector(".anchor")) return;
  const a = document.createElement("div"); a.className = "anchor"; a.style.left = PRACTICE.sev.anchor * 100 + "%";
  a.innerHTML = "<span>орієнтир</span>";
  sl.appendChild(a);
}

/** Called by commit() for practice cards instead of saving a review. */
function practiceCommitted(c) {
  if (c.type === "tri") tut.results.tri = { status: c.s, fixedS: c.text.S, why: c.why };
  if (c.type === "qa") tut.results.qa = { answer: c.answer, correct: c.answer === PRACTICE.qa.answer };
  if (c.type === "sev") tut.results.sev = { raw: Math.round(c.raw * 1000) / 1000 };
  const s = tut.steps[tut.i];
  if (s && s.waitCommit) { if (s.after) toast(typeof s.after === "function" ? s.after() : s.after); const from = tut.i; setTimeout(() => goNext(from), 250); }
}

function finishTutorial(skipped) {
  if (!tut.on) return;
  cancelAnimationFrame(tut.raf);
  tut.on = false;
  tut.ring && tut.ring.remove(); tut.bubble && tut.bubble.remove();
  document.querySelectorAll(".onb-modal").forEach(m => m.remove());
  const res = { ...tut.results, skipped, skipped_at: skipped ? tut.i : null, finished: new Date().toISOString() };
  ls("wb-onboarded-" + (st.me ? st.me.id : ""), "1");
  if (st.api && st.api.onboarded) st.api.onboarded(res).catch(() => {});
  if (st.cur && st.cur.practice) st.cur = null;
  if (!skipped) toast("Поїхали! 🌻");
  advance();
}
