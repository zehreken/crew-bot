"""Command line entry point.

Split into subcommands so the Spond half and the Google half can be verified
independently - `groups` and `fetch --dry-run` need no Google setup at all.
"""

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import boats, export, sheets, spond_client
from .config import (
    ConfigError,
    load_config,
    require_group,
    require_login,
    require_sheets,
)
from .models import ACCEPTED, DECLINED, UNANSWERED, Snapshot


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


def _cmd_export(config, out: str | None) -> int:
    require_login(config)
    require_group(config)
    require_sheets(config)

    client = sheets.get_client(config)
    boat_list = boats.load_boats(config, client)
    snapshot = asyncio.run(spond_client.fetch_snapshot(config))
    _print_summary(snapshot, config.event_title_matches)

    path = Path(out) if out else config.export_path
    payload = export.build_payload(snapshot, boat_list)
    export.write_json(payload, path)

    active = sum(1 for b in boat_list if b.active)
    print(f"\nBoats: {active} active of {len(boat_list)}")
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
    print(f"{len(boat_list)} boats in the {config.boats_worksheet_name!r} tab:\n")
    for boat in sorted(boat_list, key=lambda b: (-b.seats, b.name)):
        flag = "" if boat.active else "   (inactive)"
        print(f"  {boat.seats:2} seats  {boat.level:<12} {boat.name}{flag}")
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
        if args.command == "titles":
            return _cmd_titles(config)
        if args.command == "fetch":
            return _cmd_fetch(config, dry_run=args.dry_run)
        if args.command == "boats":
            return _cmd_boats(config)
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
        FileNotFoundError,
        ValueError,
    ) as exc:
        # These are all "you need to go and fix something" errors, and a
        # traceback would only bury the message.
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0
