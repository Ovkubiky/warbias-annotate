"""Walk the first-run onboarding like a person would, in demo mode on a phone viewport.

Usage: python3 tests/e2e_onboarding.py [--shots DIR]
"""
import asyncio
import json
import pathlib
import sys
from playwright.async_api import async_playwright

PAGE = (pathlib.Path(__file__).resolve().parent.parent / "docs" / "index.html").as_uri() + "?demo"
SHOTS = pathlib.Path(sys.argv[sys.argv.index("--shots") + 1]) if "--shots" in sys.argv else None
ok, bad = 0, []


def check(name, cond):
    global ok
    if cond:
        ok += 1
    else:
        bad.append(name)


async def step_no(pg):
    return await pg.evaluate("tut.on ? tut.i : -1")


async def wait_step(pg, n, timeout=4000):
    await pg.wait_for_function(f"!tut.on || tut.i >= {n}", timeout=timeout)


async def shot(pg, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        await pg.screenshot(path=str(SHOTS / f"{name}.png"))


async def full_walk(b):
    ctx = await b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(PAGE)
    await pg.wait_for_selector(".onb-modal [data-pri]")
    await shot(pg, "01-welcome")
    await pg.tap(".onb-modal [data-pri]")
    await wait_step(pg, 1)
    check("intro coach shown", await pg.is_visible(".coach"))
    await shot(pg, "02-triplet-intro")
    await pg.tap(".coach-next"); await wait_step(pg, 2)

    # replace the calque in S right in the text
    await pg.tap('[data-k="S"] .ua'); await pg.keyboard.press("End")
    await pg.keyboard.type("x"); await pg.wait_for_timeout(500)
    check("unrelated edit is not the fix", await step_no(pg) == 2)
    check("hint asks for the exact word", "зауваження" in await pg.inner_text(".coach"))
    await pg.keyboard.press("Backspace")
    await pg.evaluate("""(() => { const u = document.querySelector('[data-k="S"] .ua'), t = u.firstChild,
        i = t.textContent.indexOf('відгуки'), r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 7);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()""")
    await pg.keyboard.type("зауваження")
    await wait_step(pg, 3)
    check("calque fixed", "на зауваження про свою роботу." in await pg.evaluate("st.cur.text.S"))
    await shot(pg, "03-flag-c")

    await pg.tap('[data-k="C"] .ua'); await pg.tap('[data-k="C"] .c-bad'); await wait_step(pg, 4)
    await pg.tap('[data-k="C"] .w[data-i="6"]'); await pg.tap('[data-k="C"] .w[data-i="9"]'); await wait_step(pg, 5)
    await shot(pg, "04-reason")
    await pg.select_option('[data-k="C"] .reason', "Звучить неприродно")
    await pg.tap('[data-k="C"] .add'); await wait_step(pg, 6)
    check("fragment picked", await pg.evaluate("st.cur.why.C[0].frag") == "на відгуки про роботу")
    await shot(pg, "05-swipe")
    await pg.tap("#yesBtn"); await wait_step(pg, 7)
    check("practice triplet not saved as a review", await pg.evaluate("!localStorage.getItem('wb-demo-reviews')"))
    await pg.wait_for_selector(".onb-modal .diff")
    check("colleague's fix shown as a diff", await pg.locator(".onb-modal .diff ins").count() >= 5
          and "зауваження" in await pg.inner_text(".onb-modal .diff"))
    await shot(pg, "05b-colleague")
    await pg.tap(".onb-modal [data-pri]"); await wait_step(pg, 8)

    # QA: wrong answer first, then the right one
    await pg.wait_for_selector('[data-choice="2"]')
    await pg.tap('[data-choice="2"]'); await wait_step(pg, 9)
    await pg.wait_for_timeout(200)
    await pg.tap("#yesBtn"); await pg.wait_for_timeout(500)
    check("✓ on a wrong answer does not throw the card away", await pg.evaluate("st.cur && st.cur.practice && st.cur.type") == "qa" and await step_no(pg) == 9)
    check("wrong answer gets a hint", "Перечитайте" in await pg.inner_text(".coach"))
    check("no Next until right", await pg.locator(".coach-next").count() == 0)
    await pg.tap('[data-choice="1"]'); await pg.wait_for_timeout(200)
    check("right answer praised", "Правильно" in await pg.inner_text(".coach"))
    await shot(pg, "06-qa-right")
    await pg.tap(".coach-next"); await wait_step(pg, 10)
    await pg.tap("#yesBtn"); await wait_step(pg, 11)

    # severity: drag, see the anchor
    sb = await pg.locator("#slider").bounding_box()
    await pg.mouse.click(sb["x"] + sb["width"] * .4, sb["y"] + 22)
    await wait_step(pg, 12)
    check("anchor shown", await pg.locator(".anchor").count() == 1)
    check("low rating nudged", "правіше" in await pg.inner_text(".coach"))
    await shot(pg, "07-severity-anchor")
    await pg.tap(".coach-next"); await wait_step(pg, 13)
    await pg.tap("#yesBtn"); await wait_step(pg, 14)

    for name in ("08-undo", "09-meadow", "10-trophy"):
        await shot(pg, name)
        await pg.tap(".coach-next"); await pg.wait_for_timeout(250)
    await pg.wait_for_selector(".onb-modal [data-pri]")
    await shot(pg, "11-done")
    await pg.tap(".onb-modal [data-pri]")
    await pg.wait_for_function("st.cur && !st.cur.practice", timeout=5000)
    check("real card after onboarding", not await pg.evaluate("st.cur.practice"))
    res = json.loads(await pg.evaluate("localStorage.getItem('wb-demo-onboarded')"))
    check("results: not skipped", res["skipped"] is False)
    check("results: C flagged with reason", res["tri"]["status"]["C"] == "redo" and res["tri"]["why"]["C"][0]["reason"] == "Звучить неприродно")
    check("results: S fixed", res["tri"]["status"]["S"] == "edit" and "зауваження" in res["tri"]["text"]["S"])
    check("results: QA correct", res["qa"]["correct"] is True)
    check("results: severity raw", 0.3 < res["sev"]["raw"] < 0.5)
    check("no coach left on screen", await pg.locator(".coach, .coach-ring").count() == 0)
    await pg.reload(); await pg.wait_for_function("st.cur !== null", timeout=5000)
    check("not shown again after reload", await pg.locator(".onb-modal").count() == 0)
    await ctx.close()
    return errs


async def skip_walk(b):
    ctx = await b.new_context(viewport={"width": 390, "height": 844})
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(PAGE)
    await pg.wait_for_selector(".onb-modal [data-sec]")
    await pg.click(".onb-modal [data-sec]")
    await pg.wait_for_function("st.cur && !st.cur.practice", timeout=5000)
    res = json.loads(await pg.evaluate("localStorage.getItem('wb-demo-onboarded')"))
    check("skip on welcome", res["skipped"] is True)
    # replay from help, then skip mid-way
    await pg.click("#helpBtn")
    if await pg.locator(".scrim [data-replay]").count():
        await pg.click(".scrim [data-replay]")
    else:  # current card is severity: its help is the rubric; use the triplet help via a fresh replay call
        await pg.evaluate("document.querySelector('.scrim').remove(); startTutorial(true)")
    await pg.click(".onb-modal [data-pri]"); await wait_step(pg, 1)
    await pg.click(".coach-x")
    await pg.click(".onb-confirm [data-stay]")
    check("exit can be cancelled", await pg.is_visible(".coach"))
    await pg.click(".coach-x"); await pg.click(".onb-confirm [data-exit]")
    await pg.wait_for_function("st.cur && !st.cur.practice", timeout=5000)
    check("exit mid-way returns to real cards", await pg.locator(".coach").count() == 0)
    await ctx.close()
    return errs


async def skip_every_step(b):
    """Only press 'Skip step' / 'Next' / 'Start' — must reach the real cards with a consistent state."""
    ctx = await b.new_context(viewport={"width": 1280, "height": 800})   # desktop, like the bug report
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(PAGE)
    await pg.click(".onb-modal [data-pri]")
    for _ in range(40):
        if await pg.evaluate("!tut.on"):
            break
        if await pg.locator(".onb-modal [data-pri]").count():
            await pg.click(".onb-modal [data-pri]")
        elif await pg.locator(".coach-next").count():
            await pg.click(".coach-next")
        else:
            await pg.click(".coach-skip")
        await pg.wait_for_timeout(450)
    await pg.wait_for_function("st.cur && !st.cur.practice", timeout=5000)
    res = json.loads(await pg.evaluate("localStorage.getItem('wb-demo-onboarded')"))
    check("skip-all: finished, not exited", res["skipped"] is False)
    check("skip-all: steps recorded as skipped", len(res.get("skippedSteps", [])) >= 8)
    check("skip-all: auto actions left consistent results", res["tri"]["status"]["C"] == "redo" and res["qa"]["correct"] is True)
    await ctx.close()
    return errs


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        errs = await full_walk(b) + await skip_walk(b) + await skip_every_step(b)
        print(f"passed {ok}, failed {len(bad)}: {bad}\nerrors: {errs}")
        await b.close()


asyncio.run(main())
