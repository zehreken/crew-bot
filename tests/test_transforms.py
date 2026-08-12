"""Tests for the pure transformation logic - no network, no credentials.

These cover the places a wrong answer would be silent rather than loud: the
open training title filter, the response-list flattening, and reading the
Boats tab (where a misparsed type would launch the wrong sized crew).

Run with `pytest`, or directly with `python tests/test_transforms.py`.
"""

from datetime import datetime, timedelta, timezone

from crew_bot import boats, export, sheets
from crew_bot.models import ACCEPTED, DECLINED, UNANSWERED, Snapshot
from crew_bot.config import _as_titles
from crew_bot.spond_client import (
    _find_group,
    _normalise,
    _parse_timestamp,
    _rowers_from_group,
    _session_from_event,
    matches_title,
)

NOW = datetime.now(timezone.utc)

# The real configured sessions, as of the club's current schedule.
OPEN_SESSIONS = ("monday rowing", "thursday rowing", "saturday rowing")


def make_group():
    return {
        "id": "g1",
        "name": "Rowing Club",
        "members": [
            {"id": "m1", "firstName": "Anna", "lastName": "Berg"},
            {"id": "m2", "firstName": "Bjorn", "lastName": "Dahl"},
            {"id": "m3", "firstName": "Cecilie", "lastName": "Voss"},
        ],
    }


def make_event():
    return {
        "id": "e1",
        "heading": "  Thursday   rowing ",
        "startTimestamp": (NOW + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "endTimestamp": None,
        "responses": {
            "acceptedIds": ["m1", "m2"],
            "declinedIds": ["m3"],
            "unansweredIds": ["guest9"],
            # unconfirmedIds / waitinglistIds omitted: Spond does not always
            # send every key, and a KeyError here would kill the whole run.
        },
    }


def test_title_match_ignores_case_and_whitespace():
    assert matches_title("  Thursday   rowing ", OPEN_SESSIONS)
    assert matches_title("SATURDAY ROWING", OPEN_SESSIONS)
    assert _normalise("  A   b ") == "a b"


def test_title_match_accepts_any_of_the_listed_sessions():
    for heading in ("Monday rowing", "Thursday rowing", "Saturday rowing"):
        assert matches_title(heading, OPEN_SESSIONS), heading


def test_title_match_excludes_everything_else():
    # These are real titles from the club's Spond group. Farstarodden and
    # strength training must never reach crew generation.
    for heading in ("Farstarodden", "Strength training \U0001f4aa", "Ergo session"):
        assert not matches_title(heading, OPEN_SESSIONS), heading


def test_title_match_is_not_a_loose_rowing_substring():
    # The whole reason for an explicit list: a bare "rowing" match would let
    # these through.
    assert not matches_title("Sunday rowing", OPEN_SESSIONS)
    assert not matches_title("Youth rowing", OPEN_SESSIONS)


def test_empty_title_list_matches_nothing():
    assert not matches_title("Thursday rowing", ())


def test_a_plain_string_in_config_is_not_split_into_characters():
    # tuple("abc") would silently become ("a", "b", "c") and match everything.
    assert _as_titles("thursday rowing") == ("thursday rowing",)
    assert _as_titles(["a", "b"]) == ("a", "b")
    assert _as_titles(None) == ()


def test_find_group_is_case_insensitive():
    assert _find_group([make_group()], "rowing club")["id"] == "g1"


def test_missing_group_error_lists_what_exists():
    message = ""
    try:
        _find_group([make_group()], "Nope")
    except Exception as exc:
        message = str(exc)
    assert "Rowing Club" in message


def test_timestamps_are_timezone_aware():
    parsed = _parse_timestamp("2026-08-13T06:00:00Z")
    assert parsed is not None
    assert parsed.tzinfo is not None
    assert parsed.hour == 6


def test_bad_timestamps_do_not_raise():
    assert _parse_timestamp(None) is None
    assert _parse_timestamp("garbage") is None


def test_responses_flatten_across_all_lists():
    session = _session_from_event(make_event())
    assert session.responses == {
        "m1": ACCEPTED,
        "m2": ACCEPTED,
        "m3": DECLINED,
        "guest9": UNANSWERED,
    }
    assert session.count(ACCEPTED) == 2
    assert sorted(session.ids_with_response(ACCEPTED)) == ["m1", "m2"]


def test_heading_is_tidied_for_display():
    assert _session_from_event(make_event()).heading == "Thursday rowing"


def test_event_without_start_is_skipped():
    event = make_event()
    event["startTimestamp"] = None
    assert _session_from_event(event) is None


def test_unknown_responder_falls_back_to_id():
    snapshot = _snapshot()
    assert snapshot.name_for("m1") == "Anna Berg"
    assert snapshot.name_for("guest9") == "guest9"


def test_sheet_rows_are_rectangular_and_sorted():
    rows = sheets.snapshot_to_rows(_snapshot())
    assert rows[0] == sheets.HEADER
    assert len(rows) == 5  # header + 4 responses
    # Ragged rows make Sheets' update() misalign columns.
    assert all(len(row) == len(sheets.HEADER) for row in rows)
    names = [row[5] for row in rows[1:]]
    assert names == sorted(names)


# --- the Boats tab ---------------------------------------------------------
# Real rows from the club's inventory, headers in the club's own order.
BOAT_ROWS = [
    ["Type", "Weight", "Name", "Producer", "Class", "Available", "Notes"],
    ["8+", "85 kg", "Bajen", "Stampfli", "", "", ""],
    ["4x/4-", "75 kg", "Kaza", "Filippi", "", "yes", ""],
    ["2x/2-", "90 kg", "Ricke", "Filippi", "", "no", "at the other lake"],
    ["1x", "55 kg", "Rio", "Wintech", "", "", ""],
    ["Trimmer", "0", "Cecil", "Hasle", "", "", ""],
    ["", "", "", "", "", "", ""],
]


def test_seats_come_from_the_type_not_from_every_digit_in_it():
    # "2x/2-" is a double. Concatenating its digits would make it a 22.
    assert boats.seats_for_type("2x/2-") == 2
    assert boats.seats_for_type("4x/4-") == 4
    assert boats.seats_for_type("8+") == 8
    assert boats.seats_for_type("4++") == 4
    assert boats.seats_for_type("C1x") == 1
    assert boats.seats_for_type("1x") == 1


def test_named_types_without_a_number_are_known():
    assert boats.seats_for_type("Trimmer") == 1
    assert boats.seats_for_type("  trimmer ") == 1
    assert boats.seats_for_type("skiff") is None


def test_boat_rows_parse_into_the_model():
    parsed = boats.parse_rows(BOAT_ROWS)
    assert [b.name for b in parsed] == ["Bajen", "Kaza", "Ricke", "Rio", "Cecil"]

    bajen = parsed[0]
    assert (bajen.type, bajen.seats, bajen.weight_kg) == ("8+", 8, 85)
    assert bajen.producer == "Stampfli"
    # The Class column is empty for now; blank must not become the string "".
    assert bajen.boat_class is None


def test_columns_may_be_renamed_in_case_and_moved_around():
    # Coaches reorder and re-capitalise columns; nothing here may depend on
    # where a column sits or how it is spelt.
    order = [2, 0, 5, 1, 4, 6, 3]  # name, type, available, weight, ...
    shuffled = [[row[i] for i in order] for row in BOAT_ROWS]
    shuffled[0] = [h.upper() for h in shuffled[0]]

    assert boats.parse_rows(shuffled) == boats.parse_rows(BOAT_ROWS)


def test_unrated_hulls_have_no_weight_rather_than_zero():
    cecil = boats.parse_rows(BOAT_ROWS)[4]
    assert cecil.weight_kg is None


def test_availability_defaults_to_yes_and_no_means_no():
    parsed = {b.name: b.available for b in boats.parse_rows(BOAT_ROWS)}
    assert parsed["Bajen"] is True  # blank counts as available
    assert parsed["Kaza"] is True
    assert parsed["Ricke"] is False  # kept at the other lake


def test_a_tab_without_an_available_column_is_all_available():
    rows = [row[:5] + row[6:] for row in BOAT_ROWS]
    assert all(b.available for b in boats.parse_rows(rows))


def test_unknown_type_is_an_error_naming_the_boat_and_row():
    rows = [BOAT_ROWS[0], ["skiff", "70 kg", "Nemo", "", "", "", ""]]
    message = ""
    try:
        boats.parse_rows(rows)
    except boats.BoatsError as exc:
        message = str(exc)
    assert "Nemo" in message and "skiff" in message and "row 2" in message


def test_missing_required_column_is_an_error():
    rows = [["Weight", "Name"], ["85 kg", "Bajen"]]
    message = ""
    try:
        boats.parse_rows(rows)
    except boats.BoatsError as exc:
        message = str(exc)
    assert "type" in message


def test_unavailable_boats_are_never_exported():
    payload = export.build_payload(_snapshot(), boats.parse_rows(BOAT_ROWS))
    names = [b["name"] for b in payload["boats"]]
    assert "Ricke" not in names  # damaged or at the other lake
    assert names == ["Bajen", "Kaza", "Rio", "Cecil"]
    assert payload["boats"][0] == {
        "name": "Bajen",
        "type": "8+",
        "seats": 8,
        "weight_kg": 85,
        "class": None,
    }


def _snapshot() -> Snapshot:
    return Snapshot(
        fetched_at=NOW,
        group_name="Rowing Club",
        rowers=_rowers_from_group(make_group()),
        sessions=[_session_from_event(make_event())],
    )


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
            passed += 1
    print(f"\n{passed} checks passed.")
