# apps-script

The browser version of crew-bot: Google pulls the Spond data, the coach
assigns crews in a web page, and the result goes back to the sheet. No computer
of ours involved and no database — the sheet stays the database, as it always
was.

This is the whole thing. It was ported from a Python CLI and a C++/ImGui
desktop app, which are gone from the working tree — once this was deployed they
did nothing but drift out of step with it. They are still in the history up to
`3c6cb75`, and a few notes below point at them, because the Python said some of
these rules in fewer lines than the Apps Script does.

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
| `Config.gs` | every setting there is, and Script Property access |
| `Models.gs` | the C/B/A/AA scale and the small shared helpers |
| `Spond.gs` | login, group lookup, event fetch (both directions), title filter |
| `Boats.gs` | reads the Boats tab |
| `Levels.gs` | works out each rower's level from the groups they are in |
| `Groups.gs` | writes the Groups tab: each Spond subgroup and its members |
| `Attendance.gs` | counts a year of sign-ups into the Attendance tab |
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
That is the same arrangement the C++ had, where `crews.h` carried a `kLevels`
array mirroring the Python's — the duplication came with the shape of the
problem, not with the port.

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

**Choose the function in the dropdown before pressing Run.** It defaults to
the first function in whichever file is open, which for `Ui.gs` is `include` —
a helper the page calls with a filename. Run on its own it gets no argument and
fails as `Exception: Bad value`, a one-frame stack that looks exactly like a
missing HTML partial and is not one.

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
4. **`checkIncludes`** — that `Styles`, `CrewsJs` and `AppJs` all load, and
   how long each came back. Worth running whenever the project is filled in by
   hand rather than pushed with clasp, because `include` fails as
   `Exception: Bad value` for two different reasons and names neither: the file
   is not there under that name (created as a Script instead of HTML, or named
   `Styles.html` so the editor made it `Styles.html.html`), or it is there and
   will not parse, which for a pasted file means the paste was cut short and
   left a tag unclosed. The lengths catch the third case, where a truncated
   paste still parses and the page only half works.
5. **`selfTestLevels`** and **`selfTestAttendance`** — the two server-side
   rules that `?page=selftest` cannot reach, checked against made-up data.
   `selfTestLevels` covers the group-to-class rule, including the leaders who
   are in every group; `selfTestAttendance` covers who lands on the Attendance
   tab and in what order. Neither needs a login and neither touches the sheet.
6. **`pullGroups`** — writes the Groups tab: each of the club's groups
   (Grupp 0 to Grupp 4, Magelungen, Hammarby Herråtta) with its members under
   it. Named `pullGroups` and not `listGroups` because that one is taken by
   step 1 — Spond's *group* is the club itself, and what a coach calls a group
   is a Spond *subgroup*. Cheaper than `pullAttendance`: subgroups arrive
   inside the group payload, so it is one login and one GET. The deployed page
   writes the same tab from its Groups pane, so this one is really for
   checking the setup before there is a deployment to check it from.
7. **`pullAttendance`** — writes the Attendance tab: one row per rower, how
   many of the past year's sessions they signed up for. The expensive one. It
   walks the year a month at a time (`sponds/` has a `max` and no paging, so
   one request for a year would come back truncated with a 200) and then looks
   up anyone who rowed but has since left the group, which is a dozen or more
   requests where `pullGroups` is two. Run it when you want the numbers, not
   on a trigger.
8. **`logPayload`** — the whole data layer in one call, as JSON.

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

Two more suites live server-side, where that page cannot reach them, and are
run from the editor's function dropdown: **`selfTestLevels`** for the
group-to-class rule and **`selfTestAttendance`** for the Attendance tab's
counting and layout. Both are pure — made-up data, no login, no sheet — so
they are safe to run at any time and fail loudly with a count in the log.

## The Attendance tab, and its pane

There are two ways to the same numbers. **`pullAttendance`** in the editor
fetches and writes the sheet tab. **The Attendance tab in the page** — third
along, after Groups — fetches and draws them, with a "Write to sheet" button
that writes the very thing on screen. Both go through `buildAttendanceReport_`,
so they cannot drift into counting differently.

The pane has its own **"Load from Spond"** button and is empty until you press
it. That is deliberate and it is the one design decision here worth defending:
`uiLoadAttendance` is a login, a dozen chunked event requests, and a profile
lookup for everyone who rowed and has since left — tens of seconds, where the
ordinary page load is one request. Folding it into `uiLoadPayload` would make
every coach opening the page at the boathouse wait through it, on every visit,
for a number they want a few times a season.

The page draws the split as two blocks rather than the sheet's divider row —
*More than 10 sessions* and *10 or fewer* — because the pane already has that
shape from the Groups pane, and the split is the question being asked.

It answers one question — who has been to more than ten sessions — because
that is how the cleaning crews get picked. Sorted by count with a divider drawn
where the threshold falls, so the answer is "the rows above the line" rather
than something to work out cell by cell. `attendanceThreshold` in `Config.gs`
moves the line.

**It counts sign-ups, not check-ins, and this is not a bug that can be fixed
here.** Spond's record of an event is what people pressed in the app: accepted,
declined, no answer. Whether they then turned up is not in the API. So a rower
who accepts and stays home is counted, and one who rows every week without
answering is not. The tab says so in its own third line. Adjusting for the
people you know row anyway is the coach's job.

Three columns exist to make a low count readable rather than damning:

- **Invited** is the denominator. Somebody who joined the club in May has a
  small count for a reason that is not about them. It is not the sum of the
  other three — Spond also has *unconfirmed* and *waitinglist*, and both mean
  the invitation arrived.
- **Declined** and **No answer** separate "said no" from "never looked".

Who appears: every current member of the group, including anyone sitting on
nothing but zeroes — that is the finding, not a gap — plus anyone else who
actually rowed, marked *no longer in the group*. Somebody who was invited a
year ago, never answered, and has since left is not worth a row and does not
get one.

The window is a rolling 365 days rather than a season with a start date, so
there is nothing to remember to edit each spring. The cost is that it slides:
a rower's count drifts down as old sessions fall off the back of it.

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

## On a phone

The pane is used at the boathouse, on a phone, so it has to work there.

**Drag a rower by the grip** — the ⠿ at the right-hand end of a name, in the
pool and in a seat alike. A mouse can still take hold of the row anywhere; a
finger cannot, and the reason is the whole design. A touch that starts on
ordinary content belongs to the browser, which pans the page with it and hands
the page a `pointercancel`, so before this every drag on a phone died a few
pixels in and the rower never moved. `touch-action: none` takes that gesture
back — but applied to the row it would take scrolling with it, and the pool on
a phone is mostly rows, so there would be nothing left to pull the list up by.
One small grip per row is the exemption, and the two gestures stop competing:
grip to drag, anywhere else to scroll.

A long-press to start the drag was the alternative. It was rejected because it
holds the coach still for a third of a second before anything happens, and it
still has to guess whether a press that has not moved yet is a drag or the
beginning of a scroll. The grip answers that before the finger lands.

**A drag near the top or bottom edge scrolls the page**, faster the nearer the
edge. Stacked on a phone the pool is below the crews, so the two ends of a drag
are routinely not on screen together — and the hand that would scroll to find
the other end is the hand holding the rower.

**The ghost sits above the fingertip**, not below and to the right of it as it
does under a mouse. The drop point is the fingertip, and the finger is on top
of it.

Below 760px the two columns stop being columns: crews first, pool underneath,
each the full width. At 2fr and 1fr a 390px phone gave the crews about 150px —
the boat picker truncated to "Göta Lej" and `-` `assign` `clear` stacked one
per line down the side of a boat with one seat in it. 760px rather than a phone
width because a narrow desktop window has the same problem and wants the same
answer. Rows and controls also grow under `@media (pointer: coarse)`, where a
24px row is a coin toss between the name above and the name below.

A cancelled drag is not a drop. `pointercancel` — the phone turns, a second
finger lands, a system edge-swipe starts — carries coordinates like any pointer
event, and used to run the same handler as `pointerup`, which read them and
seated somebody there as though the coach had let go on purpose.

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
