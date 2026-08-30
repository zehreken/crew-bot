# crew-bot

Pulls the club's **open rowing sessions** and their sign-ups from Spond, and
turns them into crews.

Everything runs on Google's servers. There is one folder:

**[`apps-script/`](apps-script/README.md) — start there.** It is the web app
the coaches use, and its README is the real document: setup, Script
Properties, deployment, the self-tests, and every rule the thing encodes.

## What it does

A coach opens the deployed web app on a phone at the boathouse and sees the
next few sessions, who signed up, and which boats are free. Pressing `assign`
fills the boats; a seat can be dragged to fix what the solver got wrong; `save`
writes the crews to a dated tab in the club's Google Sheet.

Four tabs in that sheet:

| tab | direction | written by |
|---|---|---|
| **Boats** | input, typed by hand | nobody — the hull inventory |
| **Groups** | output | `pullGroups` — each Spond group and its members |
| **Attendance** | output | `pullAttendance` — sessions signed up for, per rower |
| dated crew tabs | output | the page's `save` |

Two things worth knowing before reading any code:

- **A rower's level comes from their Spond groups**, not from a column
  somewhere. Grupp 1 and 1a are C, 2 is B, 3 is A, 4 is AA, and Grupp 0 goes in
  no boat at all. A rower's level is the *best* of the groups they are in.
- **Attendance counts sign-ups, not check-ins.** Spond knows what somebody
  pressed in the app, not who turned up. The tab says so on itself.

## History

This started as a Python CLI plus a C++/ImGui desktop app, ported to Apps
Script because `api.spond.com` sends CORS headers only for `https://spond.com`
— so no static page can call Spond, and a server has to. Once the port was
deployed and the coaches were using it, the two originals were doing nothing
but drifting out of step with it, and they were deleted.

They are in the git history, up to commit `3c6cb75`, if the way a rule used to
be stated is ever wanted: `src/crew_bot/` (Python), `crew-assign/` (C++), and
`tests/test_transforms.py`. Nothing here depends on them.
