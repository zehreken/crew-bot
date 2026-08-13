"""Everything that talks to Spond.

The `spond` package is fully async (aiohttp), so this module is async
throughout and the CLI drives it with asyncio.run(). Authentication is lazy -
the first API call logs in, there is no explicit login() to call.
"""

import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from spond import spond

from .config import Config
from .models import (
    ACCEPTED,
    DECLINED,
    UNANSWERED,
    UNCONFIRMED,
    WAITINGLIST,
    Rower,
    Session,
    Snapshot,
)

# Spond reports responses as five parallel lists of ids on each event.
RESPONSE_KEYS = {
    "acceptedIds": ACCEPTED,
    "declinedIds": DECLINED,
    "unansweredIds": UNANSWERED,
    "unconfirmedIds": UNCONFIRMED,
    "waitinglistIds": WAITINGLIST,
}


class SpondError(Exception):
    """A Spond request succeeded but returned something we cannot use."""


@asynccontextmanager
async def _session(config: Config):
    """Yield a Spond client and always close its aiohttp session.

    Without the close the process hangs on exit instead of returning.
    """
    client = spond.Spond(username=config.spond_username, password=config.spond_password)
    try:
        yield client
    finally:
        await client.clientsession.close()


def _normalise(text: str) -> str:
    """Lowercase and collapse whitespace, so titles compare forgivingly."""
    return re.sub(r"\s+", " ", text or "").strip().lower()


def matches_title(heading: str, wanted: tuple[str, ...]) -> bool:
    """True if the heading contains any of the configured titles."""
    normalised = _normalise(heading)
    return any(_normalise(w) in normalised for w in wanted)


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    # Spond returns ISO-8601 with a trailing Z, which fromisoformat only
    # accepts from 3.11 onwards - swap it for an explicit offset regardless.
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _rowers_from_group(group: dict) -> dict[str, Rower]:
    """Build the id -> Rower map from the group's member list.

    Doing this once is why we do not need a get_person() call per rower the way
    the upstream attendance example does.
    """
    rowers: dict[str, Rower] = {}
    for member in group.get("members") or []:
        uid = member.get("id")
        if not uid:
            continue
        rowers[uid] = Rower(
            id=uid,
            first_name=member.get("firstName", ""),
            last_name=member.get("lastName", ""),
        )
    return rowers


def _find_group(groups: list[dict], wanted: str) -> dict:
    target = _normalise(wanted)
    for group in groups:
        if _normalise(group.get("name", "")) == target:
            return group
    # A bare "not found" is useless when you cannot remember the exact spelling.
    available = ", ".join(sorted(g.get("name", "?") for g in groups)) or "none"
    raise SpondError(
        f"No Spond group named {wanted!r}. Groups this login can see: {available}."
    )


def _session_from_event(event: dict) -> Session | None:
    uid = event.get("id")
    start = _parse_timestamp(event.get("startTimestamp"))
    if not uid or start is None:
        return None

    responses: dict[str, str] = {}
    raw = event.get("responses") or {}
    for key, status in RESPONSE_KEYS.items():
        for rower_id in raw.get(key) or []:
            responses[rower_id] = status

    return Session(
        id=uid,
        # Tidy the display copy; matching uses _normalise separately.
        heading=re.sub(r"\s+", " ", event.get("heading", "")).strip(),
        start=start,
        end=_parse_timestamp(event.get("endTimestamp")),
        responses=responses,
    )


async def list_groups(config: Config) -> list[str]:
    """Group names this login can see. Used to fill in config.toml."""
    async with _session(config) as client:
        groups = await client.get_groups() or []
        return sorted(g.get("name", "?") for g in groups)


async def list_subgroups(config: Config) -> list[tuple[str, int]]:
    """Subgroup names in the configured group, with how many members each has.

    Subgroups arrive inside the group payload, so this costs no extra request.
    """
    async with _session(config) as client:
        groups = await client.get_groups()
        if not groups:
            raise SpondError("Spond returned no groups for this login.")
        group = _find_group(groups, config.group_name)

    counts: dict[str, int] = {}
    for member in group.get("members") or []:
        for sub_id in member.get("subGroups") or []:
            counts[sub_id] = counts.get(sub_id, 0) + 1

    rows = [
        (sub.get("name", "?"), counts.get(sub.get("id"), 0))
        for sub in group.get("subGroups") or []
    ]
    return sorted(rows, key=lambda row: row[0])


async def list_members(config: Config) -> list[tuple[str, list[str], dict[str, str]]]:
    """Every member of the configured group, with subgroups and custom fields.

    Membership is a list: a rower can sit in several subgroups at once, and
    those mix levels with crews, so nothing here interprets what they mean.

    Custom fields are whatever the group defines in Spond (`fieldDefs`), keyed
    here by the field's display name rather than its id. They are per-group and
    filled in by hand, so most are empty for most members.
    """
    async with _session(config) as client:
        groups = await client.get_groups()
        if not groups:
            raise SpondError("Spond returned no groups for this login.")
        group = _find_group(groups, config.group_name)

    names = {sub.get("id"): sub.get("name", "?") for sub in group.get("subGroups") or []}
    field_names = {fd.get("id"): fd.get("name", "?") for fd in group.get("fieldDefs") or []}

    rows = []
    for member in group.get("members") or []:
        rower = Rower(
            id=member.get("id", ""),
            first_name=member.get("firstName", ""),
            last_name=member.get("lastName", ""),
        )
        # An id with no matching subgroup means the member is in a subgroup this
        # login cannot see; show the raw id rather than dropping it silently.
        subs = sorted(names.get(sid, sid) for sid in member.get("subGroups") or [])
        fields = {
            field_names.get(fid, fid): str(value)
            for fid, value in (member.get("fields") or {}).items()
            if value not in (None, "")
        }
        rows.append((rower.full_name, subs, fields))
    return sorted(rows, key=lambda row: row[0].lower())


async def list_event_titles(config: Config) -> list[tuple[datetime, str, bool]]:
    """Every upcoming event, unfiltered, with whether it currently matches.

    The filter failing silently produces an empty sheet rather than an error,
    so there needs to be a way to see what the events are really called.
    """
    now = datetime.now(timezone.utc)
    async with _session(config) as client:
        groups = await client.get_groups()
        if not groups:
            raise SpondError("Spond returned no groups for this login.")
        group = _find_group(groups, config.group_name)
        events = (
            await client.get_events(
                group_id=group.get("id"),
                min_start=now,
                max_start=now + timedelta(days=config.lookahead_days),
                max_events=config.max_events,
            )
            or []
        )

    rows = []
    for event in events:
        start = _parse_timestamp(event.get("startTimestamp"))
        if start is None or start < now:
            continue
        heading = re.sub(r"\s+", " ", event.get("heading", "")).strip()
        rows.append((start, heading, matches_title(heading, config.event_title_matches)))
    return sorted(rows, key=lambda row: row[0])


async def fetch_snapshot(config: Config) -> Snapshot:
    now = datetime.now(timezone.utc)
    window_end = now + timedelta(days=config.lookahead_days)

    async with _session(config) as client:
        groups = await client.get_groups()
        if not groups:
            raise SpondError("Spond returned no groups for this login.")
        group = _find_group(groups, config.group_name)
        rowers = _rowers_from_group(group)

        events = (
            await client.get_events(
                group_id=group.get("id"),
                min_start=now,
                max_start=window_end,
                max_events=config.max_events,
            )
            or []
        )

        sessions: list[Session] = []
        for event in events:
            if not matches_title(event.get("heading", ""), config.event_title_matches):
                continue
            session = _session_from_event(event)
            # Spond's timestamp filter only has day resolution (it formats
            # every datetime as midnight), so today's finished sessions come
            # back too. Drop them here.
            if session is None or session.start < now:
                continue
            sessions.append(session)

        sessions.sort(key=lambda s: s.start)

        # Guests and members of other groups can respond without appearing in
        # this group's member list. Look those up individually - there are
        # usually none, so this rarely costs a request.
        unknown = {
            rower_id
            for session in sessions
            for rower_id in session.responses
            if rower_id not in rowers
        }
        for rower_id in unknown:
            try:
                person = await client.get_person(rower_id)
            except Exception:
                # An unresolvable id still belongs in the output; Rower.full_name
                # falls back to showing the id itself.
                person = {}
            rowers[rower_id] = Rower(
                id=rower_id,
                first_name=person.get("firstName", ""),
                last_name=person.get("lastName", ""),
            )

    return Snapshot(
        fetched_at=now,
        group_name=group.get("name", config.group_name),
        rowers=rowers,
        sessions=sessions,
    )
