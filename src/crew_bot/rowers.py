"""The rower roster, kept in a Rowers tab of the sheet.

Spond owns *who* is a member. The sheet owns *what level* they are, because
Spond has nowhere to put one - no custom field for it, and the only field the
group does define is filled in for 1 member of 160 (see README). So the tab is
the club's own small database, and `crew_bot rowers` reconciles the two: it
appends anybody new that Spond knows about and never touches a level a coach
has already set.

The name is the key. That is what the club calls people and what a coach can
maintain by hand in two columns - the alternative, a Spond id column, is a
28-character string nobody can check by eye. The cost is that two members with
exactly the same name would share one row, so the sync reports duplicates
rather than silently merging them.
"""

import gspread
from gspread.exceptions import WorksheetNotFound

from .config import Config
from .models import LEVELS, Rower, Snapshot, normalise_class

ROWERS_HEADER = ["Name", "Level"]

REQUIRED_COLUMNS = ("name",)


class RowersError(Exception):
    """The Rowers tab is missing or its contents cannot be read."""


def _key(name: str) -> str:
    """Match names the way a person would: ignoring case and extra spaces."""
    return " ".join(name.split()).casefold()


def parse_rows(rows: list[list[str]], source: str = "Rowers") -> dict[str, str | None]:
    """Read the tab into {name key: level}, where level is None if blank.

    Tolerant of the same things the Boats tab is: blank rows, extra spaces,
    columns in any order or missing. An unrecognised level is an error naming
    the rower and row - the same rule the Class column follows, and for the
    same reason: a typo would produce a level no boat class can ever match.
    """
    if not rows:
        return {}

    header = [h.strip().lower() for h in rows[0]]
    missing = [name for name in REQUIRED_COLUMNS if name not in header]
    if missing:
        raise RowersError(
            f"The {source!r} tab is missing the column(s) {', '.join(missing)}. "
            f"Found: {', '.join(header) or '(nothing)'}. Expected: "
            f"{', '.join(ROWERS_HEADER)}."
        )
    col = {name: header.index(name) for name in header}

    levels: dict[str, str | None] = {}
    for number, row in enumerate(rows[1:], start=2):

        def cell(name: str) -> str:
            index = col.get(name)
            if index is None or index >= len(row):
                return ""
            return row[index].strip()

        name = cell("name")
        if not name:
            continue  # blank spacer row

        raw_level = cell("level")
        level = normalise_class(raw_level)
        if raw_level and level is None:
            raise RowersError(
                f"{source} row {number}: {name!r} has level={raw_level!r}, which "
                f"is not one of {', '.join(LEVELS)} (lowest to highest). Fix the "
                f"cell, or leave it blank until the rower has been graded."
            )
        levels[_key(name)] = level

    return levels


def sync_rows(
    rows: list[list[str]], member_names: list[str]
) -> tuple[list[list[str]], list[str], list[str]]:
    """Work out the tab's new contents from its old ones plus Spond's members.

    Returns (rows, added, duplicates).

    Existing rows keep their position and their level: this only ever appends.
    Nobody is removed either - a member who leaves Spond keeps their row, which
    is what you want of a database, and one line to delete by hand if not.
    """
    existing = rows[1:] if rows else []
    known = {_key(row[0]) for row in existing if row and row[0].strip()}

    added: list[str] = []
    duplicates: list[str] = []
    seen: set[str] = set()
    for name in member_names:
        if not name.strip():
            continue
        key = _key(name)
        if key in seen:
            duplicates.append(name)
            continue
        seen.add(key)
        if key not in known:
            added.append(name)

    # Sorted, so a first run produces an alphabetical tab and later runs add a
    # tidy block at the bottom rather than scattering new names.
    added.sort()
    new_rows = [ROWERS_HEADER]
    new_rows.extend(row[: len(ROWERS_HEADER)] for row in existing if row and row[0].strip())
    new_rows.extend([name, ""] for name in added)
    return new_rows, added, duplicates


def update_levels(
    rows: list[list[str]], levels: dict[str, str | None]
) -> tuple[list[list[str]], int]:
    """Put edited levels back into the tab's rows. Returns (rows, changed).

    Only the level cell of a row whose name is in `levels` is touched, so the
    tab's own order, its extra rows and anything a coach typed elsewhere all
    survive. Names not in the tab are ignored rather than appended - use
    `rowers` for that, which is the command that knows about Spond.
    """
    if not rows:
        return rows, 0

    header = [h.strip().lower() for h in rows[0]]
    if "name" not in header:
        raise RowersError("The Rowers tab has no name column to match against.")
    name_at = header.index("name")
    level_at = header.index("level") if "level" in header else len(header)

    width = max(len(header), level_at + 1)
    out = [list(rows[0]) + [""] * (width - len(rows[0]))]
    if level_at >= len(rows[0]):
        out[0][level_at] = "Level"

    changed = 0
    for row in rows[1:]:
        padded = list(row) + [""] * (width - len(row))
        if name_at < len(padded) and padded[name_at].strip():
            key = _key(padded[name_at])
            if key in levels:
                wanted = levels[key] or ""
                if padded[level_at] != wanted:
                    padded[level_at] = wanted
                    changed += 1
        out.append(padded)
    return out, changed


def apply_levels(snapshot: Snapshot, levels: dict[str, str | None]) -> Snapshot:
    """A copy of the snapshot with each rower's level filled in from the tab.

    Rowers the tab has never heard of keep level None, which is the same thing
    a blank cell means: not graded yet.
    """
    import dataclasses

    graded = {
        uid: dataclasses.replace(rower, level=levels.get(_key(rower.full_name)))
        for uid, rower in snapshot.rowers.items()
    }
    return dataclasses.replace(snapshot, rowers=graded)


def ensure_tab(
    spreadsheet: gspread.Spreadsheet, title: str = "Rowers"
) -> tuple[gspread.Worksheet, bool]:
    """Return the Rowers tab, creating it with just a header if absent."""
    try:
        return spreadsheet.worksheet(title), False
    except WorksheetNotFound:
        worksheet = spreadsheet.add_worksheet(
            title=title, rows=400, cols=len(ROWERS_HEADER)
        )
        worksheet.update(values=[ROWERS_HEADER], range_name="A1")
        return worksheet, True


def load_levels(config: Config, client: gspread.Client) -> dict[str, str | None]:
    """Read the Rowers tab. An absent tab is not an error - it just means no
    levels are set yet, and `export` should still produce a usable file."""
    spreadsheet = client.open(config.spreadsheet_name)
    try:
        worksheet = spreadsheet.worksheet(config.rowers_worksheet_name)
    except WorksheetNotFound:
        return {}
    return parse_rows(worksheet.get_all_values(), source=worksheet.title)
