# WarBias Swipe

A phone-first annotation app for the [WarBias](https://huggingface.co/datasets/FairForget/WarBias) dataset.
Volunteers swipe through cards, fix Ukrainian sentences in place, flag broken ones word by word,
answer the QA items and rate how dangerous each stereotype is. Costs nothing to run.

- **Front end**: static files in `docs/`, served by GitHub Pages.
- **Back end**: a Google Apps Script web app (`apps-script/`) that keeps everything in one Google Sheet.

Without a backend URL in `docs/config.js` the app runs in **demo mode** on a sample of real cards
(`docs/sample-data.js`), with answers kept in the browser.

## What the back end does

| Rule | Default (tab `config`) |
|---|---|
| Independent reviews per item | 2 (triplets, QA, severity) |
| Extra opinion when someone found a problem, or QA answers differ | up to 3 in total (not for severity) |
| A person never sees the same item twice | always |
| Order | random per person, so nobody walks the data in the same order |
| Disputed items first, then half-done, then untouched | always |
| Hidden check items | about 1 in `gold_every` cards; mark rows in `items.gold` as `ok` or `bad` |
| Minimum time per card | `dwell_ms` |
| Break suggestion | every `break_every` cards |

Each review row stores the outcome, the A/B/C answer or the severity position (0–1), the edited text,
flagged fragments with reasons, the card's position in the session and the time spent on it,
so position and fatigue effects can be measured.

## Sheet tabs

- `config` — settings above.
- `annotators` — one row per volunteer. Type a name, run `makeLinks()`, send each person their link.
  Set `active` to `FALSE` to switch someone off.
- `items` — `item_id`, `type` (`tri` | `qa` | `sev`), `gold`, `group`, `payload` (JSON).
  `importWarBias()` fills it from Hugging Face; any other data works if the payload has the same fields.
- `reviews` — one row per answer. `undone = TRUE` rows were taken back with ↩ and should be ignored.

## Deploy

1. `clasp login -u ucu` with the UCU Google account.
2. `clasp create-script --type standalone --title "WarBias annotation" --rootDir apps-script -u ucu`, then `clasp push -u ucu`.
3. In the Apps Script editor run `setup`, then `importWarBias` (approve the permissions once).
4. Deploy → New deployment → Web app, execute as *me*, access *Anyone*. Put the `/exec` URL in `docs/config.js`.
5. Add names to `annotators`, run `makeLinks`, share the links.

## Develop

```bash
node --test tests/logic.test.js       # assignment / scoring rules
python3 tests/e2e_demo.py             # front end in Chromium, demo mode (needs playwright)
python3 scripts/build_sample.py       # refresh the demo cards from Hugging Face
scripts/sync-logic.sh                 # copy apps-script/Logic.js to docs/logic.js after editing it
```
