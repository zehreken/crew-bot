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
**Assign crews**, then **Write crews.json**. `crews` pushes the result to a tab
named after the session date, e.g. `2026-08-13`.

Re-running replaces that tab rather than appending, so if someone drops out you
can just run the loop again.

### The Boats tab

The club's boat list. Created automatically with example rows if the tab does
not exist. Columns, in any order:

| type | weight | name | producer | class | available | notes |
|---|---|---|---|---|---|---|
| 8+ | 85 kg | Bajen | Stämpfli (trä) | | | |
| 2x/2- | 90 kg | Ricke | Filippi | | no | at the other lake |

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
- `class` is free text and empty for now — see the note below.

**Note:** `class` is carried through for display only. It does not yet restrict
who is put in which boat, because neither the class vocabulary nor rower skill
level is decided — see below.

### Crew assignment, as it currently works

Largest boats are filled first, from the list of people who accepted, and a boat
that cannot be completely filled is skipped rather than launched short. So 9
rowers with an eight and a four available gives one full eight and one person
left over.

Boats marked unavailable are dropped by `export`, so the C++ side never sees
them.

Neither rower skill level nor boat class is considered yet. `Rower.level` and
`Boat.boat_class` both exist in the data model and ship as `null` in the JSON,
so filling them in later does not change the shape of anything. Spond has
`Grupp 0`–`Grupp 4` subgroups that may encode rower level — that decision, and
what goes in the sheet's Class column, are both still open.

Run `subgroups` to see them. Every member carries the subgroups they belong to,
and rowers are commonly in more than one (the per-subgroup counts add up to well
over the group's member count), so if that ever feeds `Rower.level` it has to be
a list rather than a single value. Nothing reads it today.

Boat weight is exported but not used either. Matching a crew's weight to the
hull's rating is the obvious next step once the Class column means something.

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
  sheets.py        Google auth, attendance writer, crews writer
  export.py        the JSON contract with the C++ app
  cli.py           argparse entry point
tests/
  test_transforms.py   filter and flattening logic, no network needed

crew-assign/         the C++ crew assigner
  build.bat          MSVC build, no CMake
  src/crews.h        the assignment logic, no UI or JSON in it
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
