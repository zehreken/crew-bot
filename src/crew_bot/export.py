"""The JSON contract between the Python half and the C++ crew assigner.

Shape:

    {
      "generated_at": "2026-08-12T22:30:00+02:00",
      "group": "Hammarby Rodd",
      "boats": [
        {"name": "Bajen", "type": "8+", "seats": 8, "weight_kg": 85,
         "class": "B", "class_rank": 2}
      ],
      "rowers": [
        {"id": "5ADE...", "name": "Albin Torstensson", "level": "B"}
      ],
      "sessions": [
        {
          "id": "E977...",
          "date": "2026-08-13",
          "heading": "Thursday rowing",
          "start": "2026-08-13T18:00:00+02:00",
          "accepted": [{"id": "5ADE...", "name": "Albin Torstensson",
                        "level": null}],
          "counts": {"accepted": 9, "declined": 13, "unanswered": 136}
        }
      ]
    }

Only rowers who accepted are exported - a crew is made of people who said they
are coming, and shipping the other 93% would just be noise for the solver.

Times are local, because everything downstream is read by humans in Stockholm.
`date` is pre-computed because it names the sheet tab the crews get written to,
and deriving it from a timestamp is one more thing for C++ to get wrong.

`rowers` is the whole club - every member of the Spond group, not just the
people who accepted something. It is what the C++ app's Rowers tab lists, and a
rower who has signed up for nothing is exactly the one a coach might want to
look up. `level` comes from the Rowers tab of the sheet (Spond has nowhere to
put one) and is null for anybody not graded yet. The same level is repeated on
each `accepted` entry so the solver never has to join the two lists.

Boat `class` is the club's C/B/A/AA scale, and `class_rank` is its position on
that scale (C=1 ... AA=4) so the C++ side can order and compare classes without
carrying a second copy of the vocabulary - if the club ever adds a class,
BOAT_CLASSES in models.py is the only place it goes. Both are null for a boat
the Boats tab has not classed, as `weight_kg` is for the hulls it does not rate.

Only boats marked available are exported: a damaged boat, or one kept at the
other lake, stays in the inventory but must never be assigned at an open
session, and filtering here means the solver cannot accidentally pick one.

Both halves of this file are written and read in the same repo, so the format
is not versioned: if it changes, change both sides and re-export.
"""

import json
from datetime import datetime
from pathlib import Path

from .models import ACCEPTED, DECLINED, UNANSWERED, Boat, Snapshot


def build_payload(snapshot: Snapshot, boats: list[Boat]) -> dict:
    return {
        "generated_at": snapshot.fetched_at.astimezone().isoformat(),
        "group": snapshot.group_name,
        "boats": [
            {
                "name": b.name,
                "type": b.type,
                "seats": b.seats,
                "weight_kg": b.weight_kg,
                "class": b.boat_class,
                "class_rank": b.class_rank,
            }
            for b in boats
            if b.available
        ],
        # The whole club, not just whoever accepted: the C++ app's Rowers tab
        # is a roster view, and a rower who has not signed up for anything is
        # exactly the one a coach might want to look up.
        "rowers": [
            {"id": rower.id, "name": rower.full_name, "level": rower.level}
            for rower in sorted(
                snapshot.rowers.values(), key=lambda rower: rower.full_name
            )
        ],
        "sessions": [
            {
                "id": session.id,
                "date": session.start.astimezone().date().isoformat(),
                "heading": session.heading,
                "start": session.start.astimezone().isoformat(),
                "accepted": [
                    {
                        "id": rower_id,
                        "name": snapshot.name_for(rower_id),
                        "level": (
                            snapshot.rowers[rower_id].level
                            if rower_id in snapshot.rowers
                            else None
                        ),
                    }
                    for rower_id in sorted(
                        session.ids_with_response(ACCEPTED),
                        key=snapshot.name_for,
                    )
                ],
                "counts": {
                    "accepted": session.count(ACCEPTED),
                    "declined": session.count(DECLINED),
                    "unanswered": session.count(UNANSWERED),
                },
            }
            for session in snapshot.sessions
        ],
    }


def write_json(payload: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        # ensure_ascii=False keeps the Swedish names readable in the file.
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return path


def load_crews(path: Path) -> dict:
    """Read the crews JSON the C++ app produced, with useful errors."""
    if not path.exists():
        raise FileNotFoundError(
            f"No crews file at {path}. Run the C++ crew app first, or pass the "
            f"path with --in."
        )
    with path.open(encoding="utf-8") as f:
        try:
            payload = json.load(f)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path} is not valid JSON: {exc}") from exc

    if "crews" not in payload:
        raise ValueError(f"{path} has no 'crews' key. Keys present: {list(payload)}")
    return payload


def load_rowers(path: Path) -> dict:
    """Read the rowers JSON the C++ app produced, with useful errors."""
    if not path.exists():
        raise FileNotFoundError(
            f"No rowers file at {path}. Set some levels in the crew app's "
            f"Rowers tab and press 'Write rowers.json', or pass the path with "
            f"--in."
        )
    with path.open(encoding="utf-8") as f:
        try:
            payload = json.load(f)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path} is not valid JSON: {exc}") from exc

    if "rowers" not in payload:
        raise ValueError(f"{path} has no 'rowers' key. Keys present: {list(payload)}")
    return payload
