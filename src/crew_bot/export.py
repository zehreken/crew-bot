"""The JSON contract between the Python half and the C++ crew assigner.

Shape:

    {
      "generated_at": "2026-08-12T22:30:00+02:00",
      "group": "Hammarby Rodd",
      "boats": [
        {"name": "Bajen", "type": "8+", "seats": 8, "weight_kg": 85,
         "class": null}
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

Rower `level` is null for now: where skill level comes from is still undecided.
The key is present so filling it in later touches neither side's parsing. Boat
`class` is null for the same reason - the Class column of the Boats tab is not
filled in yet - and `weight_kg` is null for the hulls the club does not rate.

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
            }
            for b in boats
            if b.available
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
