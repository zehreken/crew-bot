"""The boat inventory, maintained by coaches in a Boats tab of the sheet.

The sheet is the source of truth: coaches already work there, and boats change
(damage, loans, new purchases) far more often than the code does.
"""

import gspread
from gspread.exceptions import WorksheetNotFound

from .config import Config
from .models import LEVELS, Boat

BOATS_HEADER = ["name", "seats", "level", "active", "notes"]

# Written into a freshly created tab so the format is self-explanatory.
EXAMPLE_ROWS = [
    ["Example 8+", "8", "experienced", "yes", "delete this row"],
    ["Example 4x", "4", "mid", "yes", "delete this row"],
    ["Example 2x", "2", "beginner", "yes", "delete this row"],
]


class BoatsError(Exception):
    """The Boats tab is missing or its contents cannot be read."""


def _truthy(value: str) -> bool:
    return value.strip().lower() not in {"no", "false", "0", "n"}


def ensure_tab(spreadsheet: gspread.Spreadsheet, title: str = "Boats") -> tuple[gspread.Worksheet, bool]:
    """Return the Boats tab, creating and seeding it if absent.

    Returns (worksheet, created) so the caller can tell the user to go and fill
    it in rather than silently handing back an empty inventory.
    """
    try:
        return spreadsheet.worksheet(title), False
    except WorksheetNotFound:
        worksheet = spreadsheet.add_worksheet(
            title=title, rows=100, cols=len(BOATS_HEADER)
        )
        worksheet.update(values=[BOATS_HEADER, *EXAMPLE_ROWS], range_name="A1")
        return worksheet, True


def read_boats(worksheet: gspread.Worksheet) -> list[Boat]:
    """Parse the Boats tab.

    Tolerant of how humans actually fill in spreadsheets: blank rows, extra
    whitespace, "8+" in the seats column, yes/no in any casing.
    """
    rows = worksheet.get_all_values()
    if not rows:
        return []

    header = [h.strip().lower() for h in rows[0]]
    try:
        col = {name: header.index(name) for name in ("name", "seats", "level")}
    except ValueError as exc:
        raise BoatsError(
            f"The {worksheet.title!r} tab needs at least the columns "
            f"name, seats and level. Found: {header}"
        ) from exc
    active_col = header.index("active") if "active" in header else None

    boats: list[Boat] = []
    for number, row in enumerate(rows[1:], start=2):
        def cell(index: int | None) -> str:
            if index is None or index >= len(row):
                return ""
            return row[index].strip()

        name = cell(col["name"])
        if not name:
            continue  # blank spacer row

        raw_seats = cell(col["seats"])
        # "8+" and "4x" are how boats are actually named; keep the digits.
        digits = "".join(ch for ch in raw_seats if ch.isdigit())
        if not digits:
            raise BoatsError(
                f"{worksheet.title}!A{number}: boat {name!r} has seats="
                f"{raw_seats!r}, which has no number in it."
            )
        seats = int(digits)

        level = cell(col["level"]).lower()
        if level not in LEVELS:
            raise BoatsError(
                f"{worksheet.title}!A{number}: boat {name!r} has level="
                f"{level!r}. Use one of: {', '.join(LEVELS)}."
            )

        active = _truthy(cell(active_col)) if active_col is not None else True
        boats.append(Boat(name=name, seats=seats, level=level, active=active))

    return boats


def load_boats(config: Config, client: gspread.Client) -> list[Boat]:
    spreadsheet = client.open(config.spreadsheet_name)
    worksheet, created = ensure_tab(spreadsheet, config.boats_worksheet_name)
    if created:
        raise BoatsError(
            f"Created a {worksheet.title!r} tab with example rows. "
            f"Fill in your real boats there, then run this again."
        )
    boats = read_boats(worksheet)
    if not boats:
        raise BoatsError(
            f"The {worksheet.title!r} tab has no boats in it yet. "
            f"Add one row per boat: name, seats, level."
        )
    return boats
