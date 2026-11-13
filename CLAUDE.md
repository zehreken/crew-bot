# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`apps-script/` is the whole repository. It is an Apps Script project — a web
app deployed on Google that pulls the club's rowing sessions from Spond, lets a
coach assign crews on a phone, and writes the result to a Google Sheet.

`apps-script/README.md` is the detailed document: setup, Script Properties,
deployment, the self-test page, and every rule below stated at length.

## Commands

There is no build, no test runner, no linter, and nothing to install. The code
runs on Google's servers; a local checkout is only ever edited and pushed.

```powershell
npm install -g @google/clasp
clasp login
clasp push                  # from apps-script/, after `clasp clone <script id>`
```

Everything is run from the Apps Script editor's function dropdown, or from the
deployed URL. The entry points — the functions with no trailing underscore —
are `listGroups`, `listEventTitles`, `listBoats`, `checkIncludes`,
`logPayload`, `pullGroups`, `pullAttendance`, `selfTestLevels`,
`selfTestAttendance`, `selfTestBoats`, and `doGet`.

**Tests**: `selfTestLevels`, `selfTestAttendance` and `selfTestBoats` from the editor (pure, no
login, no sheet); `?page=selftest` on the deployed URL for the crew logic,
which also offers a run against the club's live data.

Nothing here can be executed from a terminal. When changing a pure function —
the counting, the sorting, the level rule, the assignment — extend the matching
self-test rather than reasoning about it in prose; those suites are the only
feedback loop this repo has.

## Architecture

One fact decides the whole shape: `api.spond.com` sends CORS headers only for
`https://spond.com`, so no page anywhere can call Spond from a browser.
`UrlFetchApp` runs on Google's servers, where CORS does not apply. Hence Apps
Script rather than a static site.

```
Spond  --UrlFetchApp-->  .gs on Google's servers  -->  Google Sheet
                                  |
                              Export.gs
                                  v
                       the page in the coach's browser
                       (CrewsJs.html does the assigning)
                                  v
                          save  -->  dated crew tab
```

Server side (`.gs`), one shared global scope, nothing runs at load time:

| file | what it is |
|---|---|
| `Config.gs` | every setting, and Script Property access |
| `Models.gs` | the C/B/A/AA scale and small shared helpers |
| `Spond.gs` | login, group lookup, event fetch both directions, title filter |
| `Boats.gs` | reads the Boats tab |
| `Levels.gs` | a rower's level, from the groups they are in |
| `Groups.gs` | writes the Groups tab |
| `Attendance.gs` | counts a year of sign-ups into the Attendance tab |
| `Export.gs` | assembles the payload the page reads |
| `Ui.gs` | serves the page; loads the payload, saves crews and groups |

Client side (`.html`): `Index.html`, `Styles.html`, `CrewsJs.html` (assignment
logic, no DOM in it), `AppJs.html` (pointer events and rendering),
`SelfTest.html`.

The pane is used on a phone at the boathouse. A touch that starts on ordinary
content belongs to the browser, which pans with it and fires `pointercancel`,
so **each draggable row carries a `.grip` and only the grip has
`touch-action: none`** — grip to drag, anywhere else to scroll, because the
pool is mostly rows and putting `touch-action: none` on the row would leave
nothing to scroll the list by. `onPointerDown` requires the grip for
`pointerType` touch or pen and allows the whole row for a mouse. A drag against
a screen edge scrolls the page on its own frame loop (a parked finger sends no
move events), and `pointercancel` aborts rather than dropping. The two columns
stack below 760px.

The page has three tabs — Assignment, Groups, Attendance. The first two are
drawn from the single `uiLoadPayload` call made on load; **Attendance is not**,
and must not be. `uiLoadAttendance` reads a year out of Spond and takes tens of
seconds, so the pane has its own button and stays empty until pressed.

**The crew logic is client-side on purpose.** A `google.script.run` round trip
is several hundred milliseconds and one in the middle of a drag would feel
broken. The cost is that the C/B/A/AA vocabulary exists twice — `Models.gs` for
the sheet readers, `CrewsJs.html` for the page — and the two must be kept in
step.

The sheet has four kinds of tab. **Boats** is the only input, typed by hand.
**Groups**, **Attendance** and the dated crew tabs are outputs, and every
writer *replaces* rather than appends, so re-running anything is safe.

### The C/B/A/AA scale

Rower **levels** and boat **classes** share one vocabulary on purpose, so
eligibility is the comparison `level >= class` rather than a lookup table. The
letters are defined once, in `BOAT_CLASSES` in `Models.gs`, and ranked C=1 …
AA=4 so nothing downstream parses letters.

- Every rower in a boat must meet the boat's class, not just the stroke.
- An unclassed hull constrains nobody — that is an unanswered question about
  the boat, not permission.
- The solver and per-boat `assign` obey the rule; hand-dragging does not — it
  marks the seat red instead of refusing.
- A blank weight means *unrated*, never zero. Unrated is not a light boat.

### Levels come from groups

A rower's level is **the best class among the Spond groups they are in**,
mapped by `groupLevels` in `Config.gs` and computed by `Levels.gs`. There is no
hand-kept column of letters anywhere.

| group | level |
|---|---|
| Grupp 0 | none — no boat at all |
| Grupp 1, Grupp 1a | C |
| Grupp 2 | B |
| Grupp 3 | A |
| Grupp 4 | AA |
| Magelungen, Hammarby Herråtta | not mapped, contributes nothing |

Three consequences, all encoded in `selfTestLevels`:

- **Best, not only.** Three rowers — the leaders — are in every group, and the
  maximum is the only reading that leaves them AA rather than demoted by their
  Grupp 0 membership.
- **No level means no boat, including an unclassed one.** The bottom of the
  rower scale is 0, not C. An unclassed hull also ranks 0, so `0 >= 0` would
  pass; `mayRow_` in `CrewsJs.html` has an explicit early return so it does
  not. The boat's zero is a missing answer, the rower's zero is the answer.
- **A rower in no mapped group still counts as C**, so a gap in Spond
  bookkeeping strands nobody. Grupp 0 differs because somebody put them there.

### The Attendance tab

Statistics, not part of getting anyone on the water: it exists so the cleaning
crews can be picked from the people who turn up. `pullHistory_` in `Spond.gs`
reads Spond *backwards* — the only thing here that does — and `Attendance.gs`
counts and lays out.

- **It counts sign-ups, not check-ins**, because that is all the Spond API has.
  Somebody who accepts and stays home is counted; somebody who rows without
  answering is not. The tab says so on itself and the coach adjusts. Do not
  quietly reword this away.
- **`sponds/` has a `max` and no paging.** A window holding more events than
  `max` comes back truncated with a 200 and no error, so `spondEventsBetween_`
  walks the year in chunks and merges by event id. Do not replace it with one
  wide request.
- The window is a rolling 365 days, deliberately, so nothing needs editing each
  spring.
- The sheet tab and the page's pane both come from `buildAttendanceReport_`,
  which returns a flat report — a preformatted window string, a count, the
  threshold, the entries — rather than a snapshot. That is what survives
  `google.script.run`, and it is why the pane can hand the same object back to
  `uiSaveAttendance` instead of paying for a second year-long fetch.

## Conventions

- **Join on the Spond id, never on a name.** Two members really can share one.
- **Sort order is load-bearing.** `compareNames_` sorts by code point and
  `compareNamesIgnoringCase_` folds case first. Reaching for `localeCompare`
  changes tabs without failing anything. The one deliberate exception is
  `compareAttendance_`, which ranks by count because that tab is a ranking.
- **Bad input in a sheet is an error naming the boat and the row**, not a
  silently dropped entry. The exception is a title filter matching nothing,
  which produces an empty tab; `listEventTitles` exists to diagnose that.
- **Nothing may be logged from `Spond.gs`.** Apps Script logs persist to Cloud
  Logging indefinitely, so one `console.log` of a payload turns a transient
  password into a permanent record of one. Errors report the HTTP status only.
- Secrets live in Script Properties, never in a file. `Config.gs` is committed
  and holds no secret.
- Prose comments explain *why* a decision was made, at length, including the
  alternatives rejected. Match that when touching this code — the audience is
  another coach, not only a programmer.
- The payload `Export.gs` builds still uses **snake_case keys**. They exist
  only so it could be diffed against the Python's JSON during the port. That is
  over; renaming them is free.

## History

This was ported from a Python CLI (`src/crew_bot/`) and a C++/ImGui desktop app
(`crew-assign/`). Both were deleted once this was deployed and the coaches were
using it — they had stopped being a reference and started being a second,
drifting statement of the same rules.

They are in the history up to `3c6cb75` if the older phrasing of a rule is ever
wanted, e.g. `git show 174cac8:crew-assign/src/crews.h`. Nothing in the working
tree depends on them, and comments that still mention "the Python" are pointing
there. One rule genuinely differed and the live one is the one above: the
Python had a hand-kept **Rowers** tab where blank meant *ungraded*, which
counted as C. There is no Rowers tab here, and no level means no boat.
