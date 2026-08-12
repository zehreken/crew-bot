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
.\.venv\Scripts\pip install -e .
```

**Every command below must use the venv's Python, not the system one.** The system
Python cannot see this package and will say `No module named crew_bot`.

Either write the path out each time:

```powershell
.\.venv\Scripts\python.exe -m crew_bot groups
```

or activate the venv once per terminal, after which plain `python` is the venv's:

```powershell
.\.venv\Scripts\Activate.ps1
python -m crew_bot groups
```

If activating fails with *"running scripts is disabled on this system"*, allow it
once for your user account:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

The rest of this README writes `python` as shorthand for **the venv's Python** —
either activate first, or substitute `.\.venv\Scripts\python.exe`.

### 2. Spond login

```powershell
copy .env.example .env
```

Edit `.env` and put in the email and password you use for the Spond app.
`.env` is gitignored — **never commit it**.

Now find your group's exact name:

```powershell
python -m crew_bot groups
```

Paste the group you want into `config.toml` as `group_name`.

Then check which events will be picked up:

```powershell
python -m crew_bot titles
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
python -m crew_bot fetch --dry-run
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
python -m crew_bot check-sheets
```

This prints the service account address it is using and writes a timestamp into
cell `A1` of the target tab.

## Usage

```powershell
python -m crew_bot groups           # list Spond groups your login can see
python -m crew_bot titles           # list upcoming events, marking which match
python -m crew_bot fetch --dry-run  # pull and print, write nothing
python -m crew_bot fetch            # pull and write to the sheet
python -m crew_bot check-sheets     # verify Google credentials and sharing
```

`fetch` replaces the tab's contents each run, so re-running never duplicates rows.

## Deciding crews

The full loop, run a couple of hours before a session:

```powershell
python -m crew_bot export                  # Spond + Boats tab -> data/attendance.json
.\crew-assign\build\crew-assign.exe        # pick session, Assign, Write crews.json
python -m crew_bot crews                   # crews.json -> that day's sheet tab
```

`export` pulls the current sign-ups and the boat inventory into
`data/attendance.json`. The C++ app reads that, you pick a session and press
**Assign crews**, then **Write crews.json**. `crews` pushes the result to a tab
named after the session date, e.g. `2026-08-13`.

Re-running replaces that tab rather than appending, so if someone drops out you
can just run the loop again.

### The Boats tab

Created automatically with example rows the first time you run
`python -m crew_bot boats`. Columns:

| name | seats | level | active | notes |
|---|---|---|---|---|
| Ragnar | 8 | experienced | yes | |

- `seats` tolerates boat-style names — `8+` and `4x` both read as a number.
- `level` must be one of `experienced`, `mid`, `beginner`.
- `active` — set to `no` to keep a damaged boat in the list without it being
  assigned. Blank counts as active.

**Note:** boat level is currently carried through for display only. It does not
yet restrict who is put in which boat, because rower skill level is still
undecided — see below.

### Crew assignment, as it currently works

Largest boats are filled first, from the list of people who accepted, and a boat
that cannot be completely filled is skipped rather than launched short. So 9
rowers with an eight and a four available gives one full eight and one person
left over.

Rower skill level is **not** considered yet. `Rower.level` exists in the data
model and ships as `null` in the JSON, so adding it later is not a schema
change. Spond has `Grupp 0`–`Grupp 4` subgroups that may encode it — that
decision is still open.

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
python tests\test_transforms.py                  # Python side
.\crew-assign\build\selftest.exe                 # C++ side
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
