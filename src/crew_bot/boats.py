"""The boat inventory, maintained by coaches in a Boats tab of the sheet.

The sheet is the source of truth: coaches already work there, and boats change
(damage, loans, new purchases) far more often than the code does.

The tab is the club's existing boat list, so this reads its vocabulary rather
than imposing one: a `type` column in rowing shorthand ("1x", "2x/2-", "8+")
with the seat count inside it, and a crew `weight` in kg.
"""

import gspread
from gspread.exceptions import WorksheetNotFound

from .config import Config
from .models import Boat

# Matches the club's own boat list, so a tab this code creates and the real one
# look the same. Reading is case-insensitive and order-independent, so neither
# the capitals nor the order here are load-bearing.
BOATS_HEADER = ["Type", "Weight", "Name", "Producer", "Class", "Available", "Notes"]

# Written into a freshly created tab so the format is self-explanatory.
EXAMPLE_ROWS = [
    ["8+", "85 kg", "Example eight", "Stampfli", "", "yes", "delete this row"],
    ["4x/4-", "75 kg", "Example four", "Filippi", "", "yes", "delete this row"],
    ["1x", "70 kg", "Example single", "Wintech", "", "no", "delete this row"],
]

# Only `name` and `type` have to be there; everything else is optional and
# absent columns simply read as blank.
REQUIRED_COLUMNS = ("name", "type")

# Types with no digit in them. Small and explicit rather than a guess, so a
# genuinely unrecognised type is an error a coach can see and fix.
TYPE_SEATS = {
    "trimmer": 1,
}

NOT_AVAILABLE = {"no", "false", "0", "n", "nej"}


class BoatsError(Exception):
    """The Boats tab is missing or its contents cannot be read."""


def _leading_number(text: str) -> int | None:
    """The first run of digits in `text`, e.g. "2x/2-" -> 2, "85 kg" -> 85.

    First run, not all digits: "2x/2-" is a double, and concatenating every
    digit would make it a 22-seater.
    """
    digits = ""
    for char in text:
        if char.isdigit():
            digits += char
        elif digits:
            break
    return int(digits) if digits else None


def seats_for_type(boat_type: str) -> int | None:
    """Seats in a boat of this type, or None if the type is unrecognised.

    The number in the type is the crew size: "8+" is eight rowers (the cox is
    not a seat we fill), "4x/4-" is four whether it is rigged for sculling or
    sweep, "C1x" is a coastal single.
    """
    normalised = boat_type.strip().lower()
    if not normalised:
        return None
    seats = _leading_number(normalised)
    if seats is not None:
        return seats
    return TYPE_SEATS.get(normalised)


def _available(value: str) -> bool:
    """Blank counts as available - a full column of "yes" is busywork."""
    return value.strip().lower() not in NOT_AVAILABLE


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


def parse_rows(rows: list[list[str]], source: str = "Boats") -> list[Boat]:
    """Turn the tab's raw cell values into Boats.

    Tolerant of how humans actually fill in spreadsheets: blank rows, extra
    whitespace, columns in any order, optional columns missing entirely,
    yes/no in any casing. `source` only names the tab in error messages.
    """
    if not rows:
        return []

    header = [h.strip().lower() for h in rows[0]]
    missing = [name for name in REQUIRED_COLUMNS if name not in header]
    if missing:
        raise BoatsError(
            f"The {source!r} tab is missing the column(s) {', '.join(missing)}. "
            f"Found: {', '.join(header) or '(nothing)'}. Expected something like: "
            f"{', '.join(BOATS_HEADER)}."
        )
    col = {name: header.index(name) for name in header}

    boats: list[Boat] = []
    for number, row in enumerate(rows[1:], start=2):

        def cell(name: str) -> str:
            index = col.get(name)
            if index is None or index >= len(row):
                return ""
            return row[index].strip()

        name = cell("name")
        if not name:
            continue  # blank spacer row

        boat_type = cell("type")
        seats = seats_for_type(boat_type)
        if seats is None:
            raise BoatsError(
                f"{source} row {number}: boat {name!r} has type={boat_type!r}, "
                f"which has no crew size in it. Use the rowing shorthand "
                f"(1x, 2x, 2x/2-, 4x/4-, 4++, 8+), or add it to TYPE_SEATS in "
                f"boats.py if it is a named boat like Trimmer."
            )

        # 0 in the weight column means the tab does not rate this hull, which
        # is not the same as a boat for a 0 kg crew.
        weight_kg = _leading_number(cell("weight")) or None

        boats.append(
            Boat(
                name=name,
                type=boat_type.strip(),
                seats=seats,
                weight_kg=weight_kg,
                boat_class=cell("class") or None,
                producer=cell("producer"),
                available=_available(cell("available")),
            )
        )

    return boats


def read_boats(worksheet: gspread.Worksheet) -> list[Boat]:
    return parse_rows(worksheet.get_all_values(), source=worksheet.title)


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
            f"Add one row per boat: at least a type and a name."
        )
    return boats
