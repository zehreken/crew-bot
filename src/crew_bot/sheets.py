"""Everything that talks to Google Sheets.

Credential construction is deliberately confined to `get_client` so switching
auth method later is a one-function change.

The row layout in `snapshot_to_rows` is not final - it is the long format
(one row per session x rower), chosen because it is a direct serialisation of
Snapshot with no layout logic to throw away when we pick the real format.
"""

from datetime import datetime

import gspread
from gspread.exceptions import SpreadsheetNotFound, WorksheetNotFound

from .config import Config
from .models import Snapshot

HEADER = [
    "session_id",
    "start",
    "end",
    "heading",
    "rower_id",
    "name",
    "response",
]


class SheetsError(Exception):
    """We could not reach or open the target spreadsheet."""


def get_client(config: Config) -> gspread.Client:
    """The single place credentials are built."""
    return gspread.service_account(filename=str(config.service_account_file))


def service_account_email(config: Config) -> str:
    """The address the sheet has to be shared with. Worth printing in errors."""
    import json

    try:
        with config.service_account_file.open(encoding="utf-8") as f:
            return json.load(f).get("client_email", "unknown")
    except (OSError, ValueError):
        return "unknown"


def open_worksheet(client: gspread.Client, config: Config) -> gspread.Worksheet:
    try:
        spreadsheet = client.open(config.spreadsheet_name)
    except SpreadsheetNotFound:
        # Almost always the sharing step, not a typo, so lead with that.
        raise SheetsError(
            f"Could not open a spreadsheet named {config.spreadsheet_name!r}. "
            f"Check the name is exact, and that the sheet is shared with "
            f"{service_account_email(config)} as an Editor."
        ) from None

    try:
        return spreadsheet.worksheet(config.worksheet_name)
    except WorksheetNotFound:
        return spreadsheet.add_worksheet(
            title=config.worksheet_name, rows=200, cols=len(HEADER)
        )


def snapshot_to_rows(snapshot: Snapshot) -> list[list[str]]:
    rows = [HEADER]
    for session in snapshot.sessions:
        start = session.start.isoformat()
        end = session.end.isoformat() if session.end else ""
        for rower_id, response in sorted(
            session.responses.items(), key=lambda item: snapshot.name_for(item[0])
        ):
            rows.append(
                [
                    session.id,
                    start,
                    end,
                    session.heading,
                    rower_id,
                    snapshot.name_for(rower_id),
                    response,
                ]
            )
    return rows


def crews_to_rows(payload: dict) -> list[list[str]]:
    """Lay out the C++ crew assignment for humans to read on the day.

    One block per boat, then anyone left over. Read by a coach on a phone at
    the boathouse, so it favours short lines over a wide table.
    """
    session = payload.get("session", {})
    rows: list[list[str]] = [
        [session.get("heading", "Crews"), session.get("start", "")],
        [f"Generated {payload.get('generated_at', '')}", ""],
        ["", ""],
    ]

    for crew in payload.get("crews", []):
        boat = crew.get("boat", "?")
        seats = crew.get("seats", "")
        rowers = crew.get("rowers", [])
        # Type and class share the second column: "8+  B". The class is what
        # tells a coach at the boathouse how demanding the hull is, and it is
        # null for boats the Boats tab has not classed.
        detail = "  ".join(
            part for part in (crew.get("type", ""), crew.get("class") or "") if part
        )
        rows.append([f"{boat}  ({len(rowers)}/{seats} seats)", detail])
        for position, rower in enumerate(rowers, start=1):
            name = rower.get("name", "") if isinstance(rower, dict) else str(rower)
            rows.append([f"  {position}. {name}", ""])
        rows.append(["", ""])

    leftover = payload.get("unassigned", [])
    if leftover:
        rows.append([f"Not assigned ({len(leftover)})", ""])
        for rower in leftover:
            name = rower.get("name", "") if isinstance(rower, dict) else str(rower)
            rows.append([f"  {name}", ""])

    return rows


def write_crews(spreadsheet: gspread.Spreadsheet, payload: dict) -> tuple[str, int]:
    """Write crews to a tab named after the session date, e.g. '2026-08-13'.

    The tab is replaced wholesale, so re-running after a late cancellation just
    produces the corrected list rather than a second copy.
    """
    session = payload.get("session", {})
    title = session.get("date") or datetime.now().date().isoformat()

    try:
        worksheet = spreadsheet.worksheet(title)
    except WorksheetNotFound:
        worksheet = spreadsheet.add_worksheet(title=title, rows=200, cols=2)

    rows = crews_to_rows(payload)
    worksheet.clear()
    worksheet.update(values=rows, range_name="A1")
    return title, sum(1 for r in rows if r[0].strip())


def _member_count(count: int) -> str:
    """'1 member' / '7 members', the same wording `crew_bot subgroups` prints."""
    return f"{count} member" + ("s" if count != 1 else "")


def groups_to_rows(
    group_name: str,
    blocks: list[tuple[str, list[str]]],
    ungrouped: list[str],
    updated: str = "",
) -> list[list[str]]:
    """Lay out the Spond subgroups as one block per group, members beneath.

    Same shape as `crews_to_rows`, and for the same reason: this is read down a
    phone screen at the boathouse, so it is a list with headings rather than a
    wide table.

    The banner says out loud that the tab is rebuilt from Spond. Boats and
    Rowers sit next to it and are the opposite - things a coach types into -
    and without the line there is nothing to tell them apart on screen.

    Names repeat: Spond lets a rower sit in several subgroups at once, and the
    club uses that (Grupp 3 and Hammarby Herråtta 2026 overlap heavily). A
    reader must not take the blocks for a partition, hence the second line.
    """
    rows: list[list[str]] = [
        [f"Groups in {group_name}", f"Updated {updated}" if updated else ""],
        ["Rebuilt from Spond each run; a rower can be in several groups.", ""],
        ["", ""],
    ]

    for name, members in blocks:
        rows.append([name, _member_count(len(members))])
        for member in members:
            rows.append([f"  {member}", ""])
        rows.append(["", ""])

    if ungrouped:
        # Last, and named rather than implied: a member in no group is the one
        # thing on this tab that is a to-do rather than a fact.
        rows.append(["Not in any group", _member_count(len(ungrouped))])
        for member in ungrouped:
            rows.append([f"  {member}", ""])

    return rows


def ensure_groups_tab(
    spreadsheet: gspread.Spreadsheet, title: str, after: str = ""
) -> tuple[gspread.Worksheet, bool]:
    """Return the Groups tab, creating it just after `after` if it is absent.

    Placing it next to the Rowers tab is deliberate: it is the same roster cut
    a different way, and Google appends new tabs at the far right where it
    would land past the dated crew tabs instead. An existing tab is never
    moved - by then the coach has put it where they want it.
    """
    try:
        return spreadsheet.worksheet(title), False
    except WorksheetNotFound:
        index = None
        for worksheet in spreadsheet.worksheets():
            if worksheet.title == after:
                index = worksheet.index + 1
                break
        return (
            spreadsheet.add_worksheet(title=title, rows=400, cols=2, index=index),
            True,
        )


def write_groups(
    spreadsheet: gspread.Spreadsheet,
    title: str,
    group_name: str,
    blocks: list[tuple[str, list[str]]],
    ungrouped: list[str],
    updated: str = "",
    after: str = "",
) -> tuple[int, bool]:
    """Replace the Groups tab. Returns (data rows written, tab was created).

    Replaced wholesale rather than reconciled, because unlike Rowers there is
    nothing here a coach owns: every cell comes from Spond, so re-running after
    someone changes group in the app is the whole point.
    """
    worksheet, created = ensure_groups_tab(spreadsheet, title, after)
    rows = groups_to_rows(group_name, blocks, ungrouped, updated)
    worksheet.clear()
    worksheet.update(values=rows, range_name="A1")
    return sum(1 for row in rows if row[0].strip()), created


def write_snapshot(worksheet: gspread.Worksheet, snapshot: Snapshot) -> int:
    """Replace the sheet contents. Returns the number of data rows written.

    One clear + one batched update, rather than per-cell writes which are slow
    and burn through the API quota.
    """
    rows = snapshot_to_rows(snapshot)
    worksheet.clear()
    worksheet.update(values=rows, range_name="A1")
    return len(rows) - 1
