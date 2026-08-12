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


# What a boat requires of its crew. Which rowers count as what is still an open
# question - Spond has Grupp 0-4 subgroups that may or may not encode it - so
# `Rower.level` stays None for now and crew assignment ignores it.
EXPERIENCED = "experienced"
MID = "mid"
BEGINNER = "beginner"
LEVELS = (EXPERIENCED, MID, BEGINNER)


@dataclass(frozen=True)
class Boat:
    name: str
    seats: int
    level: str
    active: bool = True


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
