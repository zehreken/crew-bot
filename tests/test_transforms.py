"""Tests for the pure transformation logic - no network, no credentials.

These cover the two places a wrong answer would be silent rather than loud:
the open training title filter, and the response-list flattening.

Run with `pytest`, or directly with `python tests/test_transforms.py`.
"""

from datetime import datetime, timedelta, timezone

from crew_bot import sheets
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
