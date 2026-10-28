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

## Progress dashboard

`dashboard.html` (also linked from 🏆) opens with the same personal link. Everyone sees team progress,
reviews per day, Krippendorff's α per card type, flag rate by card position in the session (fatigue check),
flag reasons and the severity distribution. People with `admin` = `TRUE` in the `annotators` tab also see
per-person numbers, the latest edits and flags, and severity items where ratings are 40+ points apart.
Numbers are cached on the server for 2 minutes. `dashboard.html?demo` shows sample data.

## Round 1 (the Google Sheets annotation)

`importRound1()` copies the first annotation round into `reviews` with `source = round1`: per-sentence
statuses, hand edits (a changed sentence becomes an edit, a remark typed into a sentence cell becomes a comment),
the row comment as the reason for ✕, QA answers (the letter is mapped through the choice text, since the old
sheets showed choices in their own order) and the row number as `position`. Paste the old spreadsheet's link
into `config.round1_sheet` and run it from the editor; re-running skips rows already imported.
Volunteers with the same name as a current annotator are filed under that person (so they are not shown the
same cards again); the rest become inactive `r1-NN` rows without links. The tab `round1_proposals` lists every
round-1 edit, ✕ and comment for the dataset authors.

`config.round1_mode`:
- `vote` (default): a triplet that 2+ people accepted unanimously in round 1 counts as one review, so it needs one
  fresh review; a triplet someone flagged goes first and gets two fresh, blind reviews; QA answers count in full.
  People who accepted everything (50+ triplets, no flags) are not trusted. The dashboard shows how often fresh
  reviews find a problem on those "accepted" triplets — above 5% after ~150 reviews, switch to `off`.
- `full`: every round-1 review counts. `off`: round 1 is only a baseline on the dashboard.

## Check cards and focus questions

- `makePlantedGold(n)` adds `n` triplets with one planted error each (`GOLD-001…`, `items.gold = bad:<sentence>`):
  C replaced by the neutral U, C taken from another stereotype, U replaced by a stereotype, or a typo. They are
  shown about once per `gold_every` cards; a miss is explained right away, a catch is praised. Flagging the wrong
  sentence counts as a miss. Planted cards survive `importWarBias()`.
- `suggestGold()` writes `gold_candidates` (round-1 unanimous problems → `bad`, round-1 unanimous accepts that fresh
  reviews confirm → `ok`); tick `approve` and run `applyGold()` to copy them into `items.gold`.
- Each triplet and QA card shows one focus question ("Does C contradict this exact stereotype?" …), chosen per
  person and card; its index is stored in `result.focus`, so recall can be compared by question.

## Offline work

Mode menu → «📦 Взяти 40 карток з собою» downloads a pack (`next` with `offline: true`: up to 40 cards, reserved for 6 hours instead of 20 minutes) into `localStorage`. The queue draws from the pack first, answers wait in `wb-pending` and go up in batches of 20 once the connection is back. `sw.js` keeps the page itself available offline, and a start without a connection reuses the last greeting. Packs older than 24 hours are dropped. With `offline` = TRUE in the annotators tab the app keeps the pack topped up by itself (refills below 10 cards while online); it is per person on purpose, since packs reserve cards for 6 hours. Test: `tests/e2e_offline.py`.

## Deploy

1. `clasp login -u ucu` with the UCU Google account.
2. `clasp create-script --type standalone --title "WarBias annotation" --rootDir apps-script -u ucu`, then `clasp push -u ucu`.
3. In the Apps Script editor run `setup`, then `importWarBias` (approve the permissions once).
4. Deploy → New deployment → Web app, execute as *me*, access *Anyone*. Put the `/exec` URL in `docs/config.js`.
5. Add names to `annotators`, run `makeLinks`, share the links.

## Develop

```bash
node --test tests/logic.test.js       # assignment / scoring rules
node --test tests/backend.test.js     # Code.js against an in-memory Google stand-in (tests/gas_shim.js)
python3 tests/e2e_demo.py             # front end in Chromium, demo mode (needs playwright)
python3 tests/e2e_onboarding.py       # first-run walkthrough, incl. skip-step and exit
python3 scripts/build_sample.py       # refresh the demo cards from Hugging Face
scripts/sync-logic.sh                 # copy apps-script/Logic.js to docs/logic.js after editing it
```
