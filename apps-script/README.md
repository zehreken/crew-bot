# apps-script

The browser version of crew-bot: Google pulls the Spond data, the coach
assigns crews in a web page, and the result goes back to the sheet. No computer
of ours involved and no database — the sheet stays the database, as it always
was.

Nothing outside this folder is touched. The Python CLI in the rest of the repo
keeps working exactly as it did.

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
| `Rowers.gs` | reads the Rowers tab, and the roster sync |
| `Attendance.gs` | writes the Attendance tab |
| `Export.gs` | assembles the payload the page reads |
| `Ui.gs` | serves the page; loads the payload, saves crews and levels |

Client side (`.html`) — runs in the coach's browser:

| file | what it is |
|---|---|
| `Index.html` | the page |
| `Styles.html` | the CSS |
| `CrewsJs.html` | the assignment and every seat edit — no DOM in it |
| `AppJs.html` | pointer events, rendering, the two server calls |
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
entirely. Mute its notifications, and skip it when syncing the roster or it
will appear in the Rowers tab as a rower.

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
4. **`syncRowers`** — build or update the Rowers tab from Spond's members. Only
   ever appends; an existing level is never touched.
5. **`pullAttendance`** — writes the Attendance tab.
6. **`logPayload`** — the whole data layer in one call, as JSON.

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

`logPayload` prints the same JSON `crew_bot export` writes — snake_case keys
and all, kept that way purely so it can be diffed against a real
`data/attendance.json`. Once the Python side is retired, that is the moment to
rename them.

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
they have reasons the sheet does not know about — but the seat turns red, the
boat's header counts how many are below class, and the status line spells out
what was overridden. Marked, not undone.

Pressing **Assign crews** again re-solves from scratch and throws away every
hand edit. That is the undo.

## The Rowers pane

The whole club, not just whoever accepted something — a rower who has signed up
for nothing is exactly the one a coach might want to look up. Picking someone
shows their Spond id, their level, which of the loaded sessions they accepted,
and where they are in the current assignment.

Levels can be set here or by typing in the sheet; this is the only place in the
app that changes one, and the Rowers tab is the only place a level lives.

A level set here **takes effect immediately for the boats**: press Assign crews
after grading someone and the new level is what decides which hulls they can
take, with no round trip through the sheet and no re-pull. That works because
`setLevel` writes the change everywhere the payload repeats it — the roster,
every session's accepted list, and whoever is currently sitting in a seat.

**Save levels** writes them to the Rowers tab. Only the level cell of a row
whose name is recognised is touched, so the tab's own order and anything else
typed there survive. A name the tab has never heard of is ignored rather than
appended — `syncRowers` is the thing that knows about Spond and adds people, so
if a level does not stick, run that first.

Unsaved changes show in bold in the list, and the details panel says so.

## Keeping it in git

Once it runs, [`clasp`](https://github.com/google/clasp) syncs this folder with
the project so the code lives here rather than in Google's editor:

```powershell
npm install -g @google/clasp
clasp login
clasp clone <script id>   # from Project Settings -> Script ID
```

With fourteen files, hand-copying is now the most likely source of a bug —
`clasp push` is worth the ten minutes.
