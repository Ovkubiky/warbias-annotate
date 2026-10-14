"""Browser test of the front end in demo mode (no backend needed).

Usage: python3 tests/e2e_demo.py   (needs `pip install playwright` and its Chromium)
"""
import asyncio
import pathlib
from playwright.async_api import async_playwright

PAGE = (pathlib.Path(__file__).resolve().parent.parent / "docs" / "index.html").as_uri() + "?demo"
ok, bad = 0, []


def check(name, cond):
    global ok
    if cond:
        ok += 1
    else:
        bad.append(name)


async def to_type(pg, t):
    """Swipe through cards until one of type t is shown."""
    for _ in range(40):
        try:
            await pg.wait_for_function("st.cur !== null || st.exhausted", timeout=5000)
        except Exception:
            return False
        if await pg.evaluate("st.cur && st.cur.type") == t:
            return True
        await pg.evaluate("enteredAt=-1e9; st.sinceBreak=0")
        typ = await pg.evaluate("st.cur && st.cur.type")
        if typ == "qa":
            await pg.click('[data-choice="0"]')
        if typ == "sev":
            sb = await pg.locator("#slider").bounding_box()
            await pg.mouse.click(sb["x"] + sb["width"] * .5, sb["y"] + 22)
        await pg.click("#yesBtn")
        await pg.wait_for_timeout(450)
    return False


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 390, "height": 844})
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(PAGE)
        await pg.wait_for_function("st.cur !== null", timeout=5000)
        ev = pg.evaluate
        check("demo badge shown", await pg.locator(".demo").count() == 1)
        check("meadow open on first visit", await pg.is_visible("#rot") and await pg.inner_text("#rotName") == "Луг")

        await to_type(pg, "tri")
        done0 = await ev("st.done")
        await pg.click("#yesBtn")
        check("too fast rejected", await ev("st.done") == done0)

        # inline edit kept by corner ✓
        await pg.click('[data-k="S"] .ua'); await pg.keyboard.press("End"); await pg.keyboard.type(" (правка)")
        await pg.click('[data-k="S"] .c-ok')
        check("✓ keeps edit", "edit" in await pg.get_attribute('[data-k="S"]', "class"))
        # ✕ + tapped words + reason
        await pg.click('[data-k="C"] .ua'); await pg.click('[data-k="C"] .c-bad')
        await ev("enteredAt=-1e9"); await pg.click("#yesBtn")
        check("✕ needs a reason", await ev("st.done") == done0)
        await pg.click('[data-k="C"] .w[data-i="0"]'); await pg.click('[data-k="C"] .w[data-i="1"]')
        await pg.select_option('[data-k="C"] .reason', "Звучить неприродно")
        await pg.keyboard.type("тест"); await pg.keyboard.press("Enter")
        check("fragment recorded", await ev("st.cur.why.C[0].range[1]") == 1)
        item = await ev("st.cur.id")
        await pg.click("#yesBtn"); await pg.wait_for_timeout(700)
        check("submitted", await ev("st.done") == done0 + 1)
        saved = await ev(f"JSON.parse(localStorage.getItem('wb-demo-reviews')).find(r=>r.item_id==='{item}')")
        check("review saved with outcome 'no'", saved and saved["outcome"] == "no")
        check("edit text saved", saved and "(правка)" in saved["result"]["text"]["S"])
        check("dwell + position logged", saved and saved["dwell_ms"] > 0 and saved["position"] >= 1)

        # undo marks the server review undone and restores the card
        await pg.click("#undoBtn"); await pg.wait_for_timeout(700)
        check("undo restores card", await ev("st.cur.id") == item and await ev("st.cur.s.C") == "redo")
        rv = await ev(f"JSON.parse(localStorage.getItem('wb-demo-reviews')).filter(r=>r.item_id==='{item}')")
        check("undo marks review undone", rv and all(r["undone"] for r in rv))
        await pg.click("#yesBtn"); await pg.wait_for_timeout(700)
        check("resubmit right after undo", await ev("st.done") == done0 + 1)

        # QA needs an answer; severity hides ✕
        check("reach QA", await to_type(pg, "qa"))
        await ev("enteredAt=-1e9"); d = await ev("st.done")
        await pg.click("#yesBtn", force=True)
        check("QA needs answer", await ev("st.done") == d)
        await pg.click("#noBtn")
        opts = await pg.locator(".scrim .reason option").all_inner_texts()
        check("QA has its own reasons", "Підходить кілька відповідей" in opts and "Не заперечує стереотип" not in opts)
        await pg.click(".scrim [data-close]")
        await pg.click("#helpBtn")
        check("QA help explains obvious answers", "очевидна" in await pg.inner_text(".scrim"))
        await pg.click(".scrim [data-close]")
        check("reach severity", await to_type(pg, "sev"))
        check("no ✕ on severity", not await pg.is_visible("#noBtn"))
        await ev("enteredAt=-1e9"); d = await ev("st.done")
        await pg.keyboard.press("ArrowLeft")
        check("left ignored on severity", await ev("st.done") == d)

        # no card is ever shown twice
        await ev("enteredAt=-1e9")
        reviewed = await ev("JSON.parse(localStorage.getItem('wb-demo-reviews')).filter(r=>!r.undone).map(r=>r.item_id)")
        check("no duplicates", len(reviewed) == len(set(reviewed)))

        # mode switch
        await pg.click("#modeBtn")
        await pg.click('[data-mode="sev"]'); await pg.wait_for_timeout(600)
        check("mode filter", await ev("st.cur ? st.cur.type : 'none'") in ("sev", "none"))
        check("mode clears undo", await pg.is_disabled("#undoBtn"))

        # leaderboard
        await pg.click("#trophyBtn"); await pg.wait_for_timeout(600)
        check("leaderboard rendered", await pg.locator(".lb div").count() >= 2)
        await pg.click(".scrim [data-close]")

        # run out of cards -> done screen
        await pg.click("#modeBtn"); await pg.click('[data-mode="sev"]'); await pg.wait_for_timeout(500)
        for _ in range(10):
            if await ev("!st.cur"):
                break
            await ev("enteredAt=-1e9; st.sinceBreak=0")
            sb = await pg.locator("#slider").bounding_box()
            await pg.mouse.click(sb["x"] + sb["width"] * .3, sb["y"] + 22)
            await pg.click("#yesBtn"); await pg.wait_for_timeout(500)
        await pg.wait_for_timeout(600)
        check("done screen when nothing left", await pg.locator(".state h2").count() == 1)
        await pg.screenshot(path="/tmp/wb_done.png") if False else None

        print(f"passed {ok}, failed {len(bad)}: {bad}\nerrors: {errs}")
        await b.close()


asyncio.run(main())
