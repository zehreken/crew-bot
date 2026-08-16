"""Command line entry point.

Split into subcommands so the Spond half and the Google half can be verified
independently - `groups` and `fetch --dry-run` need no Google setup at all.
"""

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import boats, export, rowers, sheets, spond_client
from .config import (
    ConfigError,
    load_config,
    require_group,
    require_login,
    require_sheets,
)
from .models import ACCEPTED, BOAT_CLASSES, DECLINED, LEVELS, UNANSWERED, Snapshot


def _print_summary(snapshot: Snapshot, titles: tuple[str, ...]) -> None:
    wanted = ", ".join(repr(t) for t in titles)
    print(f"Group: {snapshot.group_name}")
    print(f"Rowers known: {len(snapshot.rowers)}")

    if not snapshot.sessions:
        print(f"\nNo upcoming sessions matching {wanted}.")
        print("If you expected some, run `python -m crew_bot titles` to see what")
        print("your events are actually called, then fix event_title_matches")
        print("in config.toml.")
        return

    print(f"\nUpcoming sessions matching {wanted}: {len(snapshot.sessions)}\n")
    for session in snapshot.sessions:
        when = session.start.astimezone().strftime("%a %d %b %H:%M")
        print(f"  {when}  {session.heading}")
        print(
            f"    accepted {session.count(ACCEPTED)}"
            f"  declined {session.count(DECLINED)}"
            f"  unanswered {session.count(UNANSWERED)}"
        )
        names = sorted(
            snapshot.name_for(rid) for rid in session.ids_with_response(ACCEPTED)
        )
        if names:
            print(f"    in: {', '.join(names)}")


def _cmd_groups(config) -> int:
    require_login(config)
    names = asyncio.run(spond_client.list_groups(config))
    if not names:
        print("This login can not see any Spond groups.")
        return 1
    print("Groups this login can see:\n")
    for name in names:
        print(f"  {name}")
    print("\nPaste the one you want into config.toml as [spond] group_name.")
    return 0


def _cmd_subgroups(config) -> int:
    require_login(config)
    require_group(config)
    rows = asyncio.run(spond_client.list_subgroups(config))
    if not rows:
        print(f"{config.group_name} has no subgroups.")
        return 0
    print(f"Subgroups in {config.group_name}:\n")
    width = max(len(name) for name, _ in rows)
    for name, members in rows:
        print(f"  {name:<{width}}  {members} member" + ("s" if members != 1 else ""))
    return 0


def _cmd_members(config) -> int:
    require_login(config)
    require_group(config)
    rows = asyncio.run(spond_client.list_members(config))
    if not rows:
        print(f"{config.group_name} has no members.")
        return 0

    print(f"{len(rows)} members of {config.group_name}:\n")
    width = max(len(name) for name, _, _ in rows)
    filled = 0
    for name, subs, fields in rows:
        # Custom fields are nearly always empty, so they trail the subgroups
        # rather than forming a column - a mostly blank column reads as broken.
        extra = "  ".join(f"{key}: {value}" for key, value in sorted(fields.items()))
        if extra:
            filled += 1
            extra = f"  ({extra})"
        print(f"  {name:<{width}}  {', '.join(subs) or '-'}{extra}")
    print("\nA rower can be in several subgroups; '-' means none.")
    print(f"{filled} of {len(rows)} members have any custom field filled in.")
    return 0


def _cmd_titles(config) -> int:
    require_login(config)
    require_group(config)
    rows = asyncio.run(spond_client.list_event_titles(config))
    if not rows:
        print(f"No events at all in the next {config.lookahead_days} days.")
        return 0

    print(f"All events in the next {config.lookahead_days} days")
    print("(* = currently matches event_title_matches in config.toml)\n")
    for start, heading, matched in rows:
        mark = "*" if matched else " "
        print(f"  {mark} {start.astimezone().strftime('%a %d %b %H:%M')}  {heading}")
    matched_count = sum(1 for _, _, m in rows if m)
    print(f"\n{matched_count} of {len(rows)} events match.")
    return 0


def _cmd_fetch(config, dry_run: bool) -> int:
    require_login(config)
    require_group(config)
    if not dry_run:
        # Check the Google side before spending time on the Spond fetch.
        require_sheets(config)

    snapshot = asyncio.run(spond_client.fetch_snapshot(config))
    _print_summary(snapshot, config.event_title_matches)

    if dry_run:
        print("\nDry run - nothing written to Google Sheets.")
        return 0

    client = sheets.get_client(config)
    worksheet = sheets.open_worksheet(client, config)
    written = sheets.write_snapshot(worksheet, snapshot)
    print(
        f"\nWrote {written} rows to "
        f"{config.spreadsheet_name} / {config.worksheet_name}."
    )
    return 0


def _cmd_rowers(config) -> int:
    require_login(config)
    require_group(config)
    require_sheets(config)

    member_rows = asyncio.run(spond_client.list_members(config))
    names = [name for name, _, _ in member_rows]

    client = sheets.get_client(config)
    spreadsheet = client.open(config.spreadsheet_name)
    worksheet, created = rowers.ensure_tab(spreadsheet, config.rowers_worksheet_name)

    existing = worksheet.get_all_values()
    new_rows, added, duplicates = rowers.sync_rows(existing, names)

    if added or created:
        worksheet.clear()
        worksheet.update(values=new_rows, range_name="A1")

    total = len(new_rows) - 1
    where = f"{config.spreadsheet_name} / {worksheet.title}"
    if created:
        print(f"Created the {worksheet.title!r} tab.")
    print(f"{total} rowers in {where}, {len(added)} added this run.")
    if added:
        for name in added[:10]:
            print(f"  + {name}")
        if len(added) > 10:
            print(f"  ... and {len(added) - 10} more")

    graded = sum(1 for level in rowers.parse_rows(new_rows).values() if level)
    print(f"\n{graded} of {total} have a level set. Levels are "
          f"{', '.join(LEVELS)}, lowest to highest.")
    print("Fill the Level column in by hand, or set it in the crew app and run")
    print("`python -m crew_bot levels`.")

    if duplicates:
        # Names are the key, so two members sharing one is worth saying out
        # loud rather than quietly giving them one shared row.
        print(f"\nWarning: Spond has more than one member called: "
              f"{', '.join(sorted(set(duplicates)))}.")
        print("They share a single row and so a single level.")
    return 0


def _cmd_levels(config, source: str | None) -> int:
    require_sheets(config)
    path = Path(source) if source else config.export_path.parent / "rowers.json"
    payload = export.load_rowers(path)

    edited = {
        entry["name"]: entry.get("level") or None
        for entry in payload.get("rowers", [])
        if entry.get("name")
    }
    if not edited:
        print(f"No rowers in {path}. Nothing to push.")
        return 0

    client = sheets.get_client(config)
    spreadsheet = client.open(config.spreadsheet_name)
    worksheet, created = rowers.ensure_tab(spreadsheet, config.rowers_worksheet_name)
    if created:
        raise rowers.RowersError(
            f"There was no {worksheet.title!r} tab yet. Run "
            f"`python -m crew_bot rowers` first to build the roster."
        )

    keyed = {rowers._key(name): level for name, level in edited.items()}
    new_rows, changed = rowers.update_levels(worksheet.get_all_values(), keyed)
    if changed:
        worksheet.clear()
        worksheet.update(values=new_rows, range_name="A1")

    print(f"Read {len(edited)} rowers from {path}.")
    print(f"Updated {changed} level(s) in "
          f"{config.spreadsheet_name} / {worksheet.title}.")
    return 0


def _cmd_export(config, out: str | None) -> int:
    require_login(config)
    require_group(config)
    require_sheets(config)

    client = sheets.get_client(config)
    boat_list = boats.load_boats(config, client)
    levels = rowers.load_levels(config, client)
    snapshot = rowers.apply_levels(
        asyncio.run(spond_client.fetch_snapshot(config)), levels
    )
    _print_summary(snapshot, config.event_title_matches)

    path = Path(out) if out else config.export_path
    payload = export.build_payload(snapshot, boat_list)
    export.write_json(payload, path)

    available = sum(1 for b in boat_list if b.available)
    graded = sum(1 for r in snapshot.rowers.values() if r.level)
    print(f"\nBoats: {available} available of {len(boat_list)}")
    print(f"Rowers: {len(snapshot.rowers)} in the club, {graded} with a level")
    print(f"Wrote {path}")
    print("The C++ crew app reads this file.")
    return 0


def _cmd_crews(config, source: str | None) -> int:
    require_sheets(config)
    path = Path(source) if source else config.export_path.parent / "crews.json"
    payload = export.load_crews(path)

    client = sheets.get_client(config)
    spreadsheet = client.open(config.spreadsheet_name)
    title, lines = sheets.write_crews(spreadsheet, payload)
    print(f"Wrote {lines} lines to {config.spreadsheet_name} / {title}.")
    return 0


def _cmd_boats(config) -> int:
    require_sheets(config)
    client = sheets.get_client(config)
    boat_list = boats.load_boats(config, client)
    available = sum(1 for b in boat_list if b.available)
    print(
        f"{len(boat_list)} boats in the {config.boats_worksheet_name!r} tab, "
        f"{available} available:\n"
    )
    for boat in sorted(boat_list, key=lambda b: (-b.seats, b.name)):
        weight = f"{boat.weight_kg} kg" if boat.weight_kg else "-"
        seats = f"{boat.seats} seat" + ("s" if boat.seats != 1 else "")
        # Right-aligned so AA lines up under A rather than shunting the name.
        boat_class = f"{boat.boat_class or '-':>2}"
        flag = "" if boat.available else "   (not available)"
        print(
            f"  {boat.type:<8} {seats:<8} {weight:>6}  {boat_class}  "
            f"{boat.name}{flag}"
        )

    unclassed = sum(1 for b in boat_list if b.boat_class is None)
    if unclassed:
        print(
            f"\n{unclassed} boat(s) have no class yet ('-'). "
            f"Classes are {', '.join(BOAT_CLASSES)}, lowest to highest."
        )
    return 0


def _cmd_check_sheets(config) -> int:
    require_sheets(config)
    print(f"Service account: {sheets.service_account_email(config)}")

    client = sheets.get_client(config)
    worksheet = sheets.open_worksheet(client, config)
    print(f"Opened spreadsheet: {worksheet.spreadsheet.title}")
    print(f"Opened worksheet:   {worksheet.title}")

    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    worksheet.update(values=[[f"crew-bot check-sheets OK {stamp}"]], range_name="A1")
    print(f"Wrote a timestamp to {worksheet.title}!A1 - go and look at it.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="crew_bot",
        description="Pull open training attendance from Spond into a Google Sheet.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("groups", help="list the Spond groups your login can see")

    subparsers.add_parser(
        "subgroups", help="list the subgroups inside the configured Spond group"
    )

    subparsers.add_parser(
        "members", help="list the group's members and the subgroups they are in"
    )

    subparsers.add_parser(
        "titles", help="list all upcoming event titles and show which ones match"
    )

    fetch = subparsers.add_parser(
        "fetch", help="pull sessions from Spond and write them to the sheet"
    )
    fetch.add_argument(
        "--dry-run",
        action="store_true",
        help="print what was found without writing to Google Sheets",
    )

    subparsers.add_parser("boats", help="list the boats in the Boats tab")

    subparsers.add_parser(
        "rowers", help="create/update the Rowers tab from the Spond member list"
    )

    levels_cmd = subparsers.add_parser(
        "levels", help="push levels set in the crew app back to the Rowers tab"
    )
    levels_cmd.add_argument("--in", dest="source", help="path to the rowers JSON")

    export_cmd = subparsers.add_parser(
        "export", help="write attendance + boats to JSON for the C++ crew app"
    )
    export_cmd.add_argument("--out", help="override the output path")

    crews_cmd = subparsers.add_parser(
        "crews", help="write the C++ app's crews JSON to that day's tab"
    )
    crews_cmd.add_argument("--in", dest="source", help="path to the crews JSON")

    subparsers.add_parser(
        "check-sheets", help="verify the Google credentials and sheet sharing"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        config = load_config()
        if args.command == "groups":
            return _cmd_groups(config)
        if args.command == "subgroups":
            return _cmd_subgroups(config)
        if args.command == "members":
            return _cmd_members(config)
        if args.command == "titles":
            return _cmd_titles(config)
        if args.command == "fetch":
            return _cmd_fetch(config, dry_run=args.dry_run)
        if args.command == "boats":
            return _cmd_boats(config)
        if args.command == "rowers":
            return _cmd_rowers(config)
        if args.command == "levels":
            return _cmd_levels(config, args.source)
        if args.command == "export":
            return _cmd_export(config, args.out)
        if args.command == "crews":
            return _cmd_crews(config, args.source)
        if args.command == "check-sheets":
            return _cmd_check_sheets(config)
    except (
        ConfigError,
        spond_client.SpondError,
        sheets.SheetsError,
        boats.BoatsError,
        rowers.RowersError,
        FileNotFoundError,
        ValueError,
    ) as exc:
        # These are all "you need to go and fix something" errors, and a
        # traceback would only bury the message.
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0
