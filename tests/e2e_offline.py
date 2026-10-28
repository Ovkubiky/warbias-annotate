"""Browser test of the offline pack against a fake backend: take cards along, lose the connection,
reload, keep swiping, then check the answers arrive in one batch when the connection is back.

Usage: python3 tests/e2e_offline.py   (needs `pip install playwright` and its Chromium)
"""
import asyncio
import json
import pathlib
from playwright.async_api import async_playwright

PAGE = (pathlib.Path(__file__).resolve().parent.parent / "docs" / "index.html").as_uri()
ok, bad = 0, []


def check(name, cond):
    global ok
    if cond:
        ok += 1
    else:
        bad.append(name)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await (await b.new_context(viewport={"width": 390, "height": 844})).new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        state = {"online": True, "sample": [], "submitted": [], "next_counts": []}

        async def backend(route):
            if not state["online"]:
                return await route.abort()
            req = json.loads(route.request.post_data or "{}")
            a, body = req.get("action"), {"ok": True}
            stats = {"done": 0, "remaining": {"all": 99, "tri": 99, "qa": 99, "sev": 99}, "team": {"done": 0, "total": 100}}
            if a == "hello":
                body.update(me={"id": "a99", "name": "Тест", "onboarded": True}, config={"dwell_ms": 0, "break_every": 999}, stats=stats)
            elif a == "next":
                state["next_counts"].append((req.get("count"), bool(req.get("offline"))))
                skip = set(req.get("exclude") or [])
                cards = [c for c in state["sample"] if c["item_id"] not in skip][: req.get("count") or 3]
                body.update(cards=[{"item_id": c["item_id"], "type": c["type"], "payload": c["payload"]} for c in cards], remaining=stats["remaining"])
            elif a == "submit":
                state["submitted"].append([r["item_id"] for r in req["reviews"]])
                body.update(saved=len(req["reviews"]), stats=stats)
            elif a == "board":
                body.update(board=[], me={}, team=stats["team"])
            await route.fulfill(status=200, content_type="application/json", body=json.dumps(body, ensure_ascii=False))

        await pg.route("https://script.google.com/**", backend)
        await pg.goto(PAGE + "?t=testtoken")
        state["sample"] = [c for c in await pg.evaluate("WB_SAMPLE") if c["type"] == "tri"]
        await pg.evaluate("ls('wb-mode','tri')")
        await pg.reload()
        await pg.wait_for_function("st.cur !== null", timeout=10000)

        # take a pack
        await pg.click("#modeBtn")
        await pg.click("#packBtn")
        await pg.wait_for_function("!document.querySelector('#packBtn')", timeout=10000)
        pack = await pg.evaluate("loadPack()")
        check("pack stored", pack and len(pack["cards"]) >= 10 and pack["mode"] == "tri")
        check("pack asked with offline flag", (40, True) in state["next_counts"])

        # lose the connection and reload: the page should start from the cached greeting and the pack
        state["online"] = False
        await pg.reload()
        await pg.wait_for_function("st.cur !== null", timeout=10000)
        check("offline boot shows a card", await pg.evaluate("st.cur && st.cur.type") == "tri")
        before = len((await pg.evaluate("loadPack()"))["cards"])
        swiped = []
        for _ in range(5):
            await pg.wait_for_function("st.cur !== null", timeout=5000)
            swiped.append(await pg.evaluate("st.cur.id"))
            await pg.evaluate("enteredAt=-1e9")
            await pg.click("#yesBtn")
            await pg.wait_for_timeout(450)
        check("five answers queued offline", await pg.evaluate("pending.length") == 5)
        check("cards came from the pack", len((await pg.evaluate("loadPack()"))["cards"]) <= before - 5)
        check("no network submits while offline", not state["submitted"])

        # connection is back
        state["online"] = True
        await pg.evaluate("flush()")
        await pg.wait_for_function("pending.length === 0", timeout=10000)
        sent = [i for batch in state["submitted"] for i in batch]
        check("all offline answers sent", set(swiped) <= set(sent))
        check("sent as a batch", any(len(x) >= 5 for x in state["submitted"]))
        check("no page errors", not errors)
        await b.close()
    print(f"passed {ok}, failed {len(bad)}: {bad}")
    print("errors:", errors)


asyncio.run(main())
