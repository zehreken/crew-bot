# apps-script

The browser version of crew-bot: Google pulls the Spond data, the coach
assigns crews in a web page, and the result goes back to the sheet. No computer
of ours involved and no database — the sheet stays the database, as it always
was.

This is the version in use. The Python CLI and the C++ crew app in the rest of
the repo are what it was ported from — superseded now, still runnable, and
still the clearest statement of the rules when something here is unclear.

## Why it is built this way

`api.spond.com` sends CORS headers only for `https://spond.com`, so a page
hosted on GitHub Pages — or opened from disk, or from localhost — can never
call the Spond API from the browser. Verified:

```
OPTIONS api.spond.com/core/v1/auth2/login
  Origin: https://example.github.io  ->  no access-control-allow-origin
  Origin: http://localhost:8000      ->  no access-control-allow-origin
  Origin: https://spond.com          ->  access-control-allow-origin: https://spond.com
```

CORS is a rule browsers impose on pages; it means nothing to a server making an
HTTP request. `UrlFetchApp` runs on Google's servers, so it reaches Spond the
same way the Python does from a laptop.

That single fact decides the whole architecture.

## Layout

Server side (`.gs`) — runs on Google's servers:

| file | what it is |
|---|---|
| `Config.gs` | the `config.toml` values, and Script Property access |
| `Models.gs` | the C/B/A/AA scale and the small shared helpers |
| `Spond.gs` | login, group lookup, event fetch, title filter |
| `Boats.gs` | reads the Boats tab |
| `Levels.gs` | works out each rower's level from the groups they are in |
| `Groups.gs` | writes the Groups tab: each Spond subgroup and its members |
| `Attendance.gs` | writes the Attendance tab |
| `Export.gs` | assembles the payload the page reads |
| `Ui.gs` | serves the page; loads the payload, saves crews and groups |

Client side (`.html`) — runs in the coach's browser:

| file | what it is |
|---|---|
| `Index.html` | the page |
| `Styles.html` | the CSS |
| `CrewsJs.html` | the assignment and every seat edit — no DOM in it |
| `AppJs.html` | pointer events, rendering, the calls back to the server |
| `SelfTest.html` | the crew logic's own checks, as a page |

File order does not matter — the `.gs` files share one global scope and nothing
runs at load time.

**Why the crew logic is client-side.** Server code is not reachable from the
page, and a `google.script.run` round trip is several hundred milliseconds. One
in the middle of a drag would feel broken, so the page owns the assignment and
the server is only called on load and on save.

The cost is that the C/B/A/AA vocabulary now exists twice — `Models.gs` for the
sheet readers, `CrewsJs.html` for the page — and the two must be kept in step.
That is the same arrangement `crews.h` had with its `kLevels` mirroring
`LEVELS` in `models.py`.

## Setup

### 1. Create the script

At [script.google.com](https://script.google.com) → **New project**.

Make it **standalone**, not bound to the spreadsheet. A bound script inherits
the sheet's sharing, so anyone with edit access to the sheet could open
Extensions → Apps Script and read the Spond password out of Script Properties.

Create one file per file in this folder. To edit the manifest, turn on
**Project Settings → Show "appsscript.json"** and paste that too.

### 2. Script Properties

**Project Settings → Script Properties**, add three:

| key | value |
|---|---|
| `SPOND_USERNAME` | the Spond login email |
| `SPOND_PASSWORD` | its password |
| `SPREADSHEET_ID` | the long id in the sheet's URL, between `/d/` and `/edit` |

These are part of the deployment, not the source, which is what keeps this
folder safe to commit. **Nothing may ever be logged** — Apps Script logs persist
to Cloud Logging and stay visible indefinitely, so a single `console.log` of a
payload turns a transient password into a permanent record of one.

A dedicated Spond account is better than a personal login: member-level read
access is all it needs, and it removes the password prompt from the flow
entirely. Mute its notifications, and leave it out of every **Grupp** in Spond
— it will still show up in the Groups tab, but under a group that grants no
boat it can never be put in one.

### 3. Check it from the editor

In the function dropdown, in order:

1. **`listGroups`** — proves the login works and Google can reach Spond,
   without touching the spreadsheet. A failure here is unambiguously Spond's
   end. The first run asks for authorisation; because the script is unverified
   you will get a *"Google hasn't verified this app"* warning and need
   **Advanced → Go to … (unsafe)**. One time, per account.
2. **`listEventTitles`** — every upcoming event, `*` marking those that match
   `eventTitleMatches`. A filter matching nothing produces an empty tab rather
   than an error, so this is how you see what the events are called.
3. **`listBoats`** — the inventory. Unclassed hulls print as `-`.
4. **`selfTestLevels`** — checks the group-to-class rule against the cases
   that decided its shape, including the leaders who are in every group. Needs
   no login and touches nothing; it is here because the rule lives server-side
   where `?page=selftest` cannot reach it.
5. **`pullGroups`** — writes the Groups tab: each of the club's groups
   (Grupp 0 to Grupp 4, Magelungen, Hammarby Herråtta) with its members under
   it. Named `pullGroups` and not `listGroups` because that one is taken by
   step 1 — Spond's *group* is the club itself, and what a coach calls a group
   is a Spond *subgroup*. Cheaper than `pullAttendance`: subgroups arrive
   inside the group payload, so it is one login and one GET. The deployed page
   writes the same tab from its Groups pane, so this one is really for
   checking the setup before there is a deployment to check it from.
6. **`pullAttendance`** — writes the Attendance tab.
7. **`logPayload`** — the whole data layer in one call, as JSON.

### 4. Deploy the web app

**Deploy → New deployment → ⚙️ → Web app.**

- **Execute as: Me** — coaches then grant nothing at all; they just open a URL.
- **Who has access** — on a personal Google account the choices are *Only
  myself*, *Anyone with a Google Account*, and *Anyone*. Restricting to a named
  list needs Google Workspace.

The deployment URL ends in `/exec`. Add `?page=selftest` to it for the test
page.

## Tests

Open the deployed app with `?page=selftest`. It runs the crew logic's checks in
the browser against the same `CrewsJs.html` the UI drives — the real path, not
a parallel copy — and prints PASS/FAIL. **Also run against the real data**
fetches the club's live payload and checks the solver's output on it.

The property it defends is the one every hand edit can break: after any
sequence of drags, each rower who accepted is in exactly one seat or in the
pool — never lost, never duplicated. It is re-checked after each kind of edit,
along with every stray-drop case.

## Checking against the Python

`isoUtc_` formats timestamps the way `datetime.isoformat` does (`+00:00`, not
`Z`), the columns match `HEADER` in `sheets.py`, and `compareNames_` sorts by
code point the way Python's `sorted()` does rather than by locale. So point
`SPREADSHEET_ID` at a copy of the sheet, run `pullAttendance` and `crew_bot
fetch`, and diff the tabs.

`pullGroups` and `crew_bot groups-tab` write the same tab from the same data,
down to the sort: both order groups and members by lower-cased name, which is
why `compareNamesIgnoringCase_` exists rather than a bare `localeCompare`. The
tab is an output — replaced wholesale every run — so running either against one
sheet gives the same result, in either order.

`logPayload` prints the same JSON `crew_bot export` writes — snake_case keys
and all, kept that way purely so it can be diffed against a real
`data/attendance.json` during the port. That was their whole purpose, and with
the Python superseded there is nothing left to diff against: renaming them to
camelCase is now free whenever it is convenient.

## The crew logic

`CrewsJs.html` is a port of `crew-assign/src/crews.h`
(`git show 174cac8:crew-assign/src/crews.h`), kept free of DOM for the same
reason the C++ was kept free of ImGui: every drag a coach makes is one function
in there, so the UI layer only turns a pointer event into a call.

| gesture | function |
|---|---|
| seat → pool | `unseat_` |
| pool → seat (returns whoever was displaced) | `seatFromPool_` |
| seat → seat, swap or move | `moveBetweenSeats_` |
| a different hull for a crew | `setBoat_` |
| `+` `-` `assign` `clear` | `addCrew_` `removeCrew_` `fillCrew_` `clearCrew_` |
| the red "below class" marking | `mayRow_` / `underClassed_` |

Two deliberate differences from the C++: an empty seat is `null` rather than a
Rower with a blank id, and the edits return `null` instead of an empty Rower
when nothing moved.

Dragging is never refused on level grounds. A coach can put anyone in any boat —
they have reasons Spond does not know about — but the seat turns red, the
boat's header counts how many are below class, and the status line spells out
what was overridden. Marked, not undone. That holds for a Grupp 0 rower too:
the solver will never seat one, and a coach who drags one in gets a red seat
rather than a refusal.

## The message

Under the crews, a plain-text box holding the same crews as a message a coach
can paste into Spond. It is rewritten on every change — every drag, every
Assign crews, every boat swapped — so it always matches the boats above it,
which is why it sits below them rather than at the top of the pane. **Copy** it
last.

It says only what a rower needs: the session, which boat, which seat, and
whether they are in one at all. No levels and no boat classes — those are the
coach's working notes, and "no boat" beside somebody's name is not a thing to
broadcast to the club. Anyone who accepted and did not get a seat *is* listed,
on a **Not in a boat** line: that is something they need to hear rather than
infer from an absence.

```
Thursday rowing  2026-08-20

Bajen  8+
1. Anna Andersson
2. Bo Berg
...

Kaza  4x/4-  (3 of 4 seats)
1. Ivar Isak
2. Josefin Ju
3. Karl Krok

Not in a boat: Lisa Lund, Mats Mo
```

The seat count only appears on a boat that is not full, so a normal crew reads
clean and a short one stands out before it is sent. Occupied seats are
renumbered from 1, the same as the sheet tab — a rower reading both sees one
answer, and the pair "3 of 4" plus three names says everything about the gap.

**Copy** uses `execCommand` rather than the async clipboard API, which
Google's sandboxed iframe blocks often enough not to rely on. If it fails the
text is left selected, so Ctrl+C still works; the status line says which
happened. The box is read-only: it is regenerated constantly, so an edit made
in it would not survive the next drag. Edit in Spond after pasting.

## How a rower's level is decided

**A rower's level is the best class among the groups they are in.** The mapping
is `groupLevels` in `Config.gs`; the rule and its edge cases are `Levels.gs`.

| group | level | may row |
|---|---|---|
| Grupp 0 | — | nothing at all |
| Grupp 1, Grupp 1a | C | C |
| Grupp 2 | B | C, B |
| Grupp 3 | A | C, B, A |
| Grupp 4 | AA | anything |
| Magelungen, Hammarby Herråtta | — | (contributes nothing) |

There used to be a **Rowers** tab holding a hand-typed letter per rower. It is
gone, along with `Rowers.gs`, `syncRowers`, `uiSaveLevels` and the level picker
in the page. The club already sorts its rowers into groups in Spond and already
keeps that current, because it is how sessions get invited; the letters were a
second copy of the same judgement, kept worse. Grading someone now means moving
them a group in the Spond app and pressing **Reload from Spond**.

Three cases the table above cannot state on its own:

- **Best, not only.** Three rowers — the leaders — are in every group. Taking
  the maximum is the only reading under which they come out AA instead of being
  demoted by their Grupp 0 membership.
- **Grupp 0 is off the scale, not the bottom of it.** No water experience means
  no boat, *including an unclassed one*. That needs saying because an unclassed
  hull otherwise constrains nobody: its rank is 0 as well, and `0 >= 0` would
  quietly pass. `mayRow_` in `CrewsJs.html` has an explicit early return for it.
  The boat's zero is a missing answer; the rower's zero is the answer.
- **A rower in no mapped group counts as C.** Only Magelungen, say, or in a
  subgroup this login cannot see. Nobody should be stuck on the dock over a gap
  in Spond bookkeeping, and C is the stable trainer. Grupp 0 is treated
  differently because it is not a gap — somebody put them there. Watch the
  level breakdown `logPayload` prints: a C count much larger than Grupp 1 and
  1a together is the sign of members nobody has grouped.

Renaming a group in Spond — "Hammarby Herråtta 2027" — silently drops it out of
the mapping, which for that one is harmless and for a **Grupp** would demote
everybody in it to C. Run `pullGroups` to see the names exactly as Spond has
them, and keep `groupLevels` in step. Spelling is matched ignoring case and
extra spaces, so only a real rename matters.

Pressing **Assign crews** again re-solves from scratch and throws away every
hand edit. That is the undo.

## The Groups pane

Which of the club's groups — Grupp 0 to Grupp 4, Magelungen, Hammarby
Herråtta — each rower is in, straight from Spond, with their level beside them.
One block per group, members underneath, then anyone in no group at all.

Since the Rowers pane was dropped this is also the only list of the whole club
in the page, which is what it was kept for: the same 160 people, sorted into
the groups a coach actually thinks in rather than one flat alphabet.

**Read-only, deliberately.** Spond owns which group a rower is in and there is
no call here that changes that, so a wrong group is fixed in the Spond app and
picked up by the next **Reload from Spond**. Nothing in this pane is editable,
which is why the member rows are plain rows and not buttons.

Two things follow from a rower being allowed in several groups at once, which
this club uses heavily:

- the counts add up to more than the roster, and a name appears in more than
  one block — the blocks are not a partition, and the pane says so;
- **Not in any group** at the bottom is the one block that is a to-do rather
  than a fact. It is empty today: all 160 members are placed.

The level beside each name is this pane's own content read back: it *is* the
best group that rower is in. Everyone in the Grupp 4 block reads AA, everyone
in Grupp 0 reads "no boat", and the leaders read AA in every block they appear
in. Nothing here sets a level, because moving somebody between the blocks is
what setting one means — and that happens in the Spond app.

**Write to sheet** writes the Groups tab, next to Boats. It writes what is on
screen rather than re-fetching, the same rule **Save crews** follows; Reload
from Spond is how you get newer data, and it is one button up. The tab is
replaced wholesale every run, so nothing typed into it survives — it is an
output, unlike the Boats tab beside it. It is worth writing after a grouping
change anyway: it is the sheet's record of why anyone got the boat they got.

## Keeping it in git

Once it runs, [`clasp`](https://github.com/google/clasp) syncs this folder with
the project so the code lives here rather than in Google's editor:

```powershell
npm install -g @google/clasp
clasp login
clasp clone <script id>   # from Project Settings -> Script ID
```

With fifteen files, hand-copying is the most likely source of a bug —
`clasp push` is worth the ten minutes.
