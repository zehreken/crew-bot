"""The data model everything else is built around.

Nothing here knows about Spond or Google Sheets. `spond_client` produces a
`Snapshot`; `sheets` consumes one. The C++ crew generator will be built against
this same shape, so keep it free of anything vendor-specific.
"""

from dataclasses import dataclass, field
from datetime import datetime

# The response states Spond reports. Ordered roughly by how much a coach cares.
ACCEPTED = "accepted"
DECLINED = "declined"
UNANSWERED = "unanswered"
UNCONFIRMED = "unconfirmed"
WAITINGLIST = "waitinglist"


@dataclass(frozen=True)
class Boat:
    """One hull from the club's inventory, as the Boats tab describes it.

    `type` is the rowing shorthand the tab is written in - "1x", "2x/2-",
    "4++", "8+", and a few named oddities like "Trimmer". `seats` is derived
    from it so the rest of the code never has to parse boat names.

    `weight_kg` is the crew weight the hull is built for, not the weight of the
    boat. None means the tab does not rate it (the trimmers and the coxed
    tubs), which is different from a light boat and must not be treated as 0.

    `boat_class` is the Class column: free text, empty everywhere for now.
    What goes in it - and which rowers may take which class - is undecided,
    so nothing downstream acts on it yet. Spelt with the prefix because
    `class` is a keyword.

    `available` is what the crew assigner honours: a damaged boat, or one
    kept at the other lake, stays in the inventory but is never assigned at an
    open session. Why it is unavailable belongs in the tab's Notes column.
    """

    name: str
    type: str
    seats: int
    weight_kg: int | None = None
    boat_class: str | None = None
    producer: str = ""
    available: bool = True


@dataclass(frozen=True)
class Rower:
    id: str
    first_name: str
    last_name: str
    # Unset until we decide where skill level comes from.
    level: str | None = None

    @property
    def full_name(self) -> str:
        name = f"{self.first_name} {self.last_name}".strip()
        # Falling back to the id keeps a row readable even when Spond gives us
        # nothing but an id (guests, deleted accounts).
        return name or self.id


@dataclass(frozen=True)
class Session:
    """One open training event."""

    id: str
    heading: str
    start: datetime
    end: datetime | None
    # rower id -> one of the response constants above
    responses: dict[str, str] = field(default_factory=dict)

    def ids_with_response(self, status: str) -> list[str]:
        return [rid for rid, s in self.responses.items() if s == status]

    def count(self, status: str) -> int:
        return sum(1 for s in self.responses.values() if s == status)


@dataclass(frozen=True)
class Snapshot:
    """Everything one run of the tool pulled from Spond."""

    fetched_at: datetime
    group_name: str
    rowers: dict[str, Rower]
    sessions: list[Session]

    def name_for(self, rower_id: str) -> str:
        rower = self.rowers.get(rower_id)
        return rower.full_name if rower else rower_id
