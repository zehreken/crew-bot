"""The JSON contract between the Python half and the C++ crew assigner.

Shape (schema 1):

    {
      "schema": 1,
      "generated_at": "2026-08-12T22:30:00+02:00",
      "group": "Hammarby Rodd",
      "boats": [
        {"name": "Ragnar", "seats": 8, "level": "experienced"}
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

`level` is null on every rower for now: where skill level comes from is still
undecided. The key is present so adding it later is not a schema change.
"""

import json
from datetime import datetime
from pathlib import Path

from .models import ACCEPTED, DECLINED, UNANSWERED, Boat, Snapshot

SCHEMA_VERSION = 1


def build_payload(snapshot: Snapshot, boats: list[Boat]) -> dict:
    return {
        "schema": SCHEMA_VERSION,
        "generated_at": snapshot.fetched_at.astimezone().isoformat(),
        "group": snapshot.group_name,
        "boats": [
            {"name": b.name, "seats": b.seats, "level": b.level}
            for b in boats
            if b.active
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
