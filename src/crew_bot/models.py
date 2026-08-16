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

# The club's boat classes, as the Class column of the Boats tab writes them,
# lowest first: C is the stable trainer, AA the racing shell.
#
# The order is the point. Once rower skill is known, "may this crew take this
# boat" is a comparison rather than a table of special cases, and the ordering
# lives here only - `class_rank` is what the export ships so neither the sheet
# nor the C++ side has to know the letters.
BOAT_CLASSES = ("C", "B", "A", "AA")

# Rower levels are deliberately the same scale, not a parallel one. A level
# exists to say which class of boat someone can be trusted with, so sharing the
# vocabulary makes that a comparison ("level >= class") rather than a lookup
# table mapping one set of letters onto another.
LEVELS = BOAT_CLASSES


def normalise_class(value: str) -> str | None:
    """Tidy a Class cell into one of BOAT_CLASSES, or None if it is not one.

    Case and surrounding whitespace are noise a coach should not have to think
    about; anything else is a typo the caller should complain about loudly
    rather than quietly drop.
    """
    candidate = value.strip().upper()
    return candidate if candidate in BOAT_CLASSES else None


def class_rank(boat_class: str | None) -> int | None:
    """1-based position in BOAT_CLASSES: C -> 1, B -> 2, A -> 3, AA -> 4.

    1-based so that 0 is free to mean "unclassed" on the JSON and C++ side,
    where an absent value is a plain int rather than a None.
    """
    if boat_class is None:
        return None
    try:
        return BOAT_CLASSES.index(boat_class) + 1
    except ValueError:
        return None


@dataclass(frozen=True)
class Boat:
    """One hull from the club's inventory, as the Boats tab describes it.

    `type` is the rowing shorthand the tab is written in - "1x", "2x/2-",
    "4++", "8+", and a few named oddities like "Trimmer". `seats` is derived
    from it so the rest of the code never has to parse boat names.

    `weight_kg` is the crew weight the hull is built for, not the weight of the
    boat. None means the tab does not rate it (the trimmers and the coxed
    tubs), which is different from a light boat and must not be treated as 0.

    `boat_class` is the Class column: one of BOAT_CLASSES ("C" to "AA", how
    demanding the hull is), or None for a boat the tab has not classed yet.
    Which rowers may take which class is still undecided, so it constrains
    nothing yet - but it is a closed vocabulary rather than free text, so a
    typo in the sheet is caught at read time. Spelt with the prefix because
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

    @property
    def class_rank(self) -> int | None:
        """Where this boat's class sits in BOAT_CLASSES; None if unclassed."""
        return class_rank(self.boat_class)


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
