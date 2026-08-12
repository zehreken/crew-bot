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
        rows.append([f"{boat}  ({len(rowers)}/{seats} seats)", crew.get("level", "")])
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


def write_snapshot(worksheet: gspread.Worksheet, snapshot: Snapshot) -> int:
    """Replace the sheet contents. Returns the number of data rows written.

    One clear + one batched update, rather than per-cell writes which are slow
    and burn through the API quota.
    """
    rows = snapshot_to_rows(snapshot)
    worksheet.clear()
    worksheet.update(values=rows, range_name="A1")
    return len(rows) - 1
