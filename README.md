# crew-bot

Pulls the club's **open rowing sessions** and their sign-ups from Spond and writes
them to a Google Sheet. Currently that means Monday, Thursday and Saturday rowing —
configured in `config.toml`, see below.

A later C++ layer will read this data to generate crews (boat assignments) for each
session. This repo is currently just the Python half.

## Setup

### 1. Install

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
```

That first line is the only one that uses the system Python. **Every command
below must use the venv's Python**, which is why they all spell out
`.\.venv\Scripts\python.exe` — the system Python cannot see this package and
will say `No module named crew_bot`.

If you would rather type plain `python`, activate the venv once per terminal
and it becomes the venv's for that session:

```powershell
.\.venv\Scripts\Activate.ps1
python -m crew_bot groups
```

If activating fails with *"running scripts is disabled on this system"*, allow it
once for your user account:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 2. Spond login

```powershell
copy .env.example .env
```

Edit `.env` and put in the email and password you use for the Spond app.
`.env` is gitignored — **never commit it**.

Now find your group's exact name:

```powershell
.\.venv\Scripts\python.exe -m crew_bot groups
```

Paste the group you want into `config.toml` as `group_name`.

Then check which events will be picked up:

```powershell
.\.venv\Scripts\python.exe -m crew_bot titles
```

This lists every upcoming event and marks with `*` the ones matching
`event_title_matches` in `config.toml`. Use it whenever the sheet comes out
emptier than expected — a filter that matches nothing produces an empty sheet
rather than an error, so this is the way to see what your events are really
called.

`event_title_matches` is a list, and an event matches if **any** entry matches
(case-insensitive, extra spaces ignored). It is deliberately an explicit list of
session titles rather than a loose `"rowing"` match, which would also sweep in
anything else with "rowing" in the title. **Add a line when a new open session
starts running**, otherwise it will silently never appear.

You can now verify the whole Spond half, before touching Google at all:

```powershell
.\.venv\Scripts\python.exe -m crew_bot fetch --dry-run
```

### 3. Google service account

A service account is a robot Google account with its own email address. The tool
signs in as the robot, not as you — so it keeps working unattended, and other
coaches can run it without needing your password. It is free; no billing account
is required.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a
   project (any name).
2. **APIs & Services → Library**: enable both **Google Sheets API** and
   **Google Drive API**. Both are needed — Drive is what opens a sheet by name.
3. **APIs & Services → Credentials → Create credentials → Service account**.
   Give it a name, click through to Done.
4. Click the new service account → **Keys → Add key → Create new key → JSON**.
   A `.json` file downloads.
5. Save it as `secrets/service_account.json` in this repo. It is gitignored.
6. Open that JSON and copy the `client_email` value (it looks like
   `something@your-project.iam.gserviceaccount.com`).
7. **Open your Google Sheet and share it with that email as an Editor**, exactly
   as you would share with a person.

Forgetting step 7 is the single most common failure — it shows up as
"could not open a spreadsheet named ...".

Then put the sheet's exact name into `config.toml` as `spreadsheet_name`, and check
it works:

```powershell
.\.venv\Scripts\python.exe -m crew_bot check-sheets
```

This prints the service account address it is using and writes a timestamp into
cell `A1` of the target tab.

## Usage

```powershell
.\.venv\Scripts\python.exe -m crew_bot groups           # list Spond groups your login can see
.\.venv\Scripts\python.exe -m crew_bot subgroups        # list the subgroups inside the configured group
.\.venv\Scripts\python.exe -m crew_bot members          # list members and the subgroups each is in
.\.venv\Scripts\python.exe -m crew_bot titles           # list upcoming events, marking which match
.\.venv\Scripts\python.exe -m crew_bot fetch --dry-run  # pull and print, write nothing
.\.venv\Scripts\python.exe -m crew_bot fetch            # pull and write to the sheet
.\.venv\Scripts\python.exe -m crew_bot boats            # list the boat inventory
.\.venv\Scripts\python.exe -m crew_bot rowers           # build/update the Rowers tab from Spond
.\.venv\Scripts\python.exe -m crew_bot levels           # push levels set in the crew app back
.\.venv\Scripts\python.exe -m crew_bot check-sheets     # verify Google credentials and sharing
```

`fetch` replaces the tab's contents each run, so re-running never duplicates rows.

## Deciding crews

The full loop, run a couple of hours before a session:

```powershell
.\.venv\Scripts\python.exe -m crew_bot export  # Spond + Boats tab -> data/attendance.json
.\crew-assign\build\crew-assign.exe            # pick session, Assign, Write crews.json
.\.venv\Scripts\python.exe -m crew_bot crews   # crews.json -> that day's sheet tab
```

`export` pulls the current sign-ups and the boat inventory into
`data/attendance.json`. The C++ app reads that, you pick a session and press
**Assign crews** (or build the crews from scratch — see below), adjust by hand,
then **Write crews.json**. `crews` pushes the result to a tab named after the
session date, e.g. `2026-08-13`.

Re-running replaces that tab rather than appending, so if someone drops out you
can just run the loop again.

### The Boats tab

The club's boat list. Created automatically with example rows if the tab does
not exist. Columns, in any order:

| type | weight | name | producer | class | available | notes |
|---|---|---|---|---|---|---|
| 8+ | 85 kg | Bajen | Stämpfli (trä) | B | | |
| 2x/2- | 90 kg | Ricke | Filippi | AA | no | at the other lake |

Only **type** and **name** are required; the rest can be blank or missing
entirely.

- `type` is the usual rowing shorthand, and the crew size is read out of it:
  `8+` → 8, `4x/4-` → 4, `2x/2-` → 2, `C1x` → 1. Only the *first* number counts,
  so `2x/2-` is a double and not a 22-seater. A cox is not counted as a seat.
  A type with no number in it (`Trimmer`) needs a line in `TYPE_SEATS` in
  `boats.py`; anything else unrecognised is an error naming the boat and row,
  rather than a boat silently missing from the session.
- `weight` is the crew weight the hull is built for, in kg. `0` or blank means
  unrated — that is kept distinct from a light boat, not turned into 0.
- `available` — set to `no` for a boat that is damaged or kept at the other
  lake. It stays in the inventory and in the `boats` listing, but is
  never exported and so can never be assigned. **Blank counts as available**,
  so only the exceptions need filling in. Put the reason in `notes`.
- `class` is how demanding the hull is, on the club's scale: **C, B, A, AA**,
  lowest to highest. Case and stray spaces do not matter (`aa` is `AA`), but
  anything that is not one of the four is an error naming the boat and row —
  a typo would otherwise put a boat in a class nothing can ever match. Blank
  is fine and means the boat has not been classed yet; `boats` prints those
  as `-` and counts them, so it is easy to see what is left to fill in.

**`class` is what gates the assignment.** Every rower put in a boat must be at
least its class, so a `C` hull takes anyone and an `AA` hull only takes AA
rowers. An unclassed boat constrains nobody. See
[Levels and boat classes](#levels-and-boat-classes).

### The Rowers tab

The club's roster, and the only place a rower's **level** exists. Spond has
nowhere to put one — no field for it, and the one custom field the group does
define is filled in for 1 member out of 160 — so this tab is the database.

```powershell
.\.venv\Scripts\python.exe -m crew_bot rowers
```

Creates the tab if it is missing and reconciles it with Spond's member list.
Two columns, `name` and `level`:

| name | level |
|---|---|
| Anna Berg | B |
| Björn Dahl | |

- Levels are **C, B, A, AA**, lowest to highest — deliberately the *same*
  scale as the boat classes, because a level exists to say which class of boat
  someone can be trusted with. Anything else is an error naming the rower and
  row.
- **Blank means not graded, and counts as C** when boats are handed out: an
  ungraded rower gets the stable trainers, and grading them is what unlocks the
  better hulls. Until you fill this column in, every crew goes out in a C boat.
- The sync only ever **appends**. An existing level is never touched, and
  nobody is ever removed — a member who leaves Spond keeps their row, which is
  what you want of a database and is one line to delete by hand if not.
- **The name is the key.** That is what fits in a sheet a coach maintains by
  hand; a Spond id column would be 28 characters nobody can check by eye. The
  cost is that two members with exactly the same name share one row, which the
  sync warns about rather than silently merging. If that ever happens for real,
  an id column is the fix.

Levels can be set either by typing in the sheet, or in the crew app's Rowers
tab and then pushed back:

```powershell
.\crew-assign\build\crew-assign.exe             # Rowers tab -> set levels -> Write rowers.json
.\.venv\Scripts\python.exe -m crew_bot levels   # rowers.json -> the Rowers tab
```

`levels` only ever rewrites the level cell of a row whose name it recognises —
it never adds or removes rows, so the tab's own order and anything else you
have typed there survive. Use `rowers` to add people; that is the command that
knows about Spond.

### Crew assignment, as it currently works

**Assign crews** fills the largest boats first, from the list of people who
accepted, and skips a boat it cannot completely fill rather than launching it
short. So 9 rowers with an eight and a four available gives one full eight and
one person left over. Every boat it does launch starts full.

Nobody is put in a boat their **level** does not reach: a hull's class must be
met by every rower in it. A boat short of *eligible* rowers is skipped the same
way a boat short of rowers is — twenty C rowers do not launch the AA eight
between them. Within a boat the weakest eligible rowers go first, so a rower
who only just reaches this class is spent here and the stronger ones are still
in the pool when the demanding hulls come round. See
[Levels and boat classes](#levels-and-boat-classes).

Boats marked unavailable are dropped by `export`, so the C++ side never sees
them.

### The two tabs

The file box, the **Load** button and the status line sit above the tabs, so
they apply to both and a load error stays readable whichever tab is open.

- **Assignment** — the session picker, the boats and the pool. Everything
  below is about this tab.
- **Rowers** — the whole club, one button each, with details on the right for
  whoever you pick. Everyone in the Spond group, not just the people who
  accepted something: a rower who has signed up for nothing is exactly the one
  you might want to look up.

The details panel shows the Spond id, a **level** dropdown (C/B/A/AA, or
`not set`), which of the loaded sessions they accepted, and — once you have
assigned — which boat and seat they are in, or that they are in the pool.

Changing a level here only changes it in the app. **Write rowers.json**, then
`python -m crew_bot levels`, puts it in the sheet, which is where levels
actually live. The button and the path box are at the top of the tab.

A level set here does take effect immediately for the boats: press **Assign
crews** after grading someone and the new level is what decides which hulls
they can take, without a round trip through the sheet and a re-export.

### Adjusting the crews by hand

The solver only knows how many seats a boat has and what class it is, so the
last word is yours.

**Choosing the boats.** Each crew's boat is a dropdown listing every hull that
is not already out with another crew — a boat can only be on the water once, so
it can only be in one crew. Next to it:

| | |
|---|---|
| `-` | takes the boat off the water; its crew goes back to the pool |
| `assign` | fills *this* boat's empty seats from the pool |
| `clear` | empties the boat but keeps it, ready to fill again |
| `+` (below the last boat) | puts the next free boat out, all seats empty |

Per-boat `assign` tops a boat up rather than re-seating it: anyone already
aboard stays exactly where they are, so you can place the pair who must row
together and let it find the other six. Unlike the big **Assign crews** button
it will part-fill — that button's rule of never launching a boat it cannot
crew is about choosing which boats go out at all, and here you have already
chosen this one, so three in a four is more useful than refusing. The status
line tells you how many seats are still empty.

It respects the class as well, and steps over anyone in the pool the boat is
too demanding for. A boat that comes back part-filled with people still in the
pool says so: `nobody left in the pool is A or better`.

Picking a **bigger** hull keeps everyone where they are and adds empty seats at
the stern. Picking a **smaller** one drops the seats off the end, and anyone
sitting in them goes back to the pool — the seats that survive keep their
rowers rather than everyone shuffling forward, because a seat number means
something in a boat.

`+` works before you have pressed **Assign crews**, and that is the only button
in the Crews pane until you do. Use it if you would rather build the whole
session by hand: it puts everyone who accepted in the pool and gives you an
empty boat to drag them into.

**Moving the rowers.**

- Each boat shows **every** seat, numbered bow to stern, whether or not
  anyone is in it. An empty seat prints as `3.  --`.
- **Seat → Pool**: takes the rower out. The seat stays where it is and goes
  empty — the people behind them do not shuffle up a seat. The whole Pool
  pane is the target, so you can aim at the empty space below the names
  rather than at one of the rows.
- **Pool → seat**: puts them in. Dropping on an empty seat just seats them;
  dropping on a taken one swaps, and the rower who was there goes back to
  the pool rather than being quietly overwritten.
- **Seat → seat**: swaps the two rowers, in the same boat or between boats.
  Dropping on an empty seat moves them there and leaves their old seat
  empty. This is the bowside/strokeside shuffle, and it never changes how
  many people are in a boat.
- Dragging is never refused on level grounds. You can put anyone in any boat —
  you have reasons the sheet does not know about — but the seat turns red and
  reads `Sara Lind   C   below class`, the boat's header says `1 below class
  A`, and the status line spells out what was overridden. Marked, not undone.
- Pressing **Assign crews** again throws away every hand edit and re-solves
  from scratch. That is the undo.

Every one of those is a no-op if it does not make sense — dragging an empty
seat, dropping something on itself, a drop that lands nowhere, picking a boat
that is already out. The status line under the buttons says what just
happened, including where a displaced rower went.

Whatever you do, nobody is ever lost or duplicated: every rower who accepted
is in exactly one seat or in the pool. That is the property `selftest.exe`
checks after each kind of edit.

`Write crews.json` writes the occupied seats in seat order. A boat with a gap
in it shows up on the day's sheet tab as `Kaza  (3/4 seats)` — the count comes
from the boat, so a short crew is visible rather than silently renumbered.

### Levels and boat classes

Each hull carries a **class** from the Boats tab, each rower a **level** from
the Rowers tab, and the two are the same C/B/A/AA scale on purpose: the whole
comparison is `level >= class`. The export ships `class_rank` (C=1 … AA=4) so
the C++ side orders them without a second copy of the letters.

The rule, decided by the club:

- **Every rower in a boat must be at least its class.** One strong rower does
  not carry a crew into a better hull — an A four is as demanding for the
  person in seat 2 as for the stroke.
- **Ungraded counts as C**, the bottom of the scale. Waving ungraded rowers
  through would make the rule mean nothing while the roster is mostly ungraded,
  which is the state it starts in. A new member gets the stable trainers and
  grading them is what unlocks the rest.
- **An unclassed hull constrains nobody.** A blank Class cell is an unanswered
  question about the boat, not a judgement that anyone may row it.
- **Assign crews and per-boat assign obey it; dragging does not.** The solver
  never produces an under-classed crew. A coach can, deliberately, and the app
  marks it in red rather than undoing it.

The consequence worth knowing before you fill the Rowers tab in: with nobody
graded, every crew goes out in a C boat, and the eights and the A/AA hulls stay
on the rack no matter how many people turn up.

Being greedy, the solver does not backtrack: a boat skipped for want of one
eligible rower stays skipped even if a different split would have launched
both. It goes big boats first and weakest-eligible first within a boat, which
is predictable on a dock at seven in the morning in a way a search would not
be. Where it gets it wrong, drag it.

Spond's `Grupp 0`–`Grupp 4` subgroups may or may not encode something similar;
the Rowers tab was chosen over them because a coach can see and edit it, and
because the subgroup listing argues against reading them as levels (see below).

Run `subgroups` to see them. Every member carries the subgroups they belong to,
and rowers are commonly in more than one (the per-subgroup counts add up to well
over the group's member count), so if that ever feeds `Rower.level` it has to be
a list rather than a single value. Nothing reads it today. The listing also
argues against reading them as levels: `Hammarby Herråtta 2026` is a crew that
spans Grupp 2, 3 and 4, and `Magelungen` looks like a location.

### What Spond does not carry

Checked against the live group, because it shapes what the assigner can ever do:

- **No sex, gender, or date of birth**, on the member record or on `get_person`
  (which returns the same shape). Assigning by sex needs the data from
  somewhere else — a group custom field in Spond, or a column in the sheet
  alongside the Boats tab.
- **`profile`** holds only `contactMethod`, `imageUrl`, `unableToReach`, and the
  names already used. Nothing usable for crews, which is why `members` does not
  print it.
- **Custom fields** (`fieldDefs` on the group) are the extension point that does
  exist. The group defines one, `Oarside`, filled in for 1 of 160 members. The
  `members` command prints any that are set, in brackets after the subgroups.

Boat weight is exported but not used. Now that class gates who takes which
boat, matching a crew's weight to the hull's rating is the obvious next step —
and unlike the class rule it is arithmetic on a number the Boats tab already
has, so it needs no new data, only a decision about how much slack to allow.

## Sheet format

**Not final.** Currently one row per session × rower:

| session_id | start | end | heading | rower_id | name | response |
|---|---|---|---|---|---|---|

`response` is one of `accepted`, `declined`, `unanswered`, `unconfirmed`,
`waitinglist`.

This long format was chosen because it is a direct dump of the internal data model
with no layout logic to throw away. Once there is real data in the sheet, it may
change to an attendance matrix (rowers as rows, sessions as columns). Only
`snapshot_to_rows` in `src/crew_bot/sheets.py` needs to change.

## Layout

```
src/crew_bot/
  config.py        settings from config.toml + secrets from .env
  models.py        Rower / Session / Snapshot / Boat - the shared data model
  spond_client.py  Spond login, event fetch, session title filter
  boats.py         reads the Boats tab
  rowers.py        the Rowers tab: roster sync and rower levels
  sheets.py        Google auth, attendance writer, crews writer
  export.py        the JSON contract with the C++ app
  cli.py           argparse entry point
tests/
  test_transforms.py   filter and flattening logic, no network needed

crew-assign/         the C++ crew assigner
  build.bat          MSVC build, no CMake
  src/crews.h        the assignment logic and seat edits, no UI or JSON in it
  src/io.h           attendance.json in, crews.json out
  src/main.cpp       ImGui Win32+DX11 window
  src/selftest.cpp   console test using the same io.h / crews.h
  vendor/            imgui clone + nlohmann json.hpp (gitignored)
```

`Snapshot` in `models.py` is the Python-side seam. `data/attendance.json`
(documented at the top of `export.py`) is the seam with C++ — the two halves
share no code, only that file.

## Tests

```powershell
.\.venv\Scripts\python.exe tests\test_transforms.py  # Python side
.\crew-assign\build\selftest.exe                     # C++ side
```

The C++ self-test covers crew assignment against both synthetic cases and your
real exported file, and checks the properties that matter: nobody appears in two
boats, everyone is accounted for, and no boat launches part-crewed. It uses the
same `io.h` and `crews.h` the GUI does.

## Building the C++ app

Needs Visual Studio 2022 with the C++ workload. No CMake required.

```powershell
git clone --depth 1 https://github.com/ocornut/imgui.git crew-assign\vendor\imgui
curl -L -o crew-assign\vendor\json.hpp https://github.com/nlohmann/json/releases/latest/download/json.hpp
.\crew-assign\build.bat
```

If Visual Studio is somewhere other than the default path, edit `VSROOT` at the
top of `build.bat`.

## Notes for later

- **Running on a schedule**: the service account makes unattended runs possible.
  Windows Task Scheduler calling `.venv\Scripts\python.exe -m crew_bot fetch` is
  the simplest route.
- **Spond's date filter has day resolution only** — it formats every timestamp as
  midnight, so it returns today's already-finished sessions too. `spond_client`
  drops those client-side.
