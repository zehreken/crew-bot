"""Settings and secrets.

Non-secret settings live in config.toml (committed, shareable with other
coaches). Secrets live in .env (gitignored). Errors here are the first thing a
new user hits, so they name the exact file and key that is wrong.

Validation is per-command rather than all-or-nothing: `groups` needs only a
Spond login, and `fetch --dry-run` needs no Google setup at all. Requiring
every key up front would block exactly the commands you use while still
setting the tool up.
"""

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# src/crew_bot/config.py -> project root is three levels up.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_FILE = PROJECT_ROOT / "config.toml"
ENV_FILE = PROJECT_ROOT / ".env"

DEFAULT_SERVICE_ACCOUNT_FILE = "secrets/service_account.json"
PLACEHOLDER = "CHANGE ME"


class ConfigError(Exception):
    """Something is missing or wrong in config.toml or .env."""


@dataclass(frozen=True)
class Config:
    spond_username: str
    spond_password: str
    service_account_file: Path

    group_name: str
    event_title_matches: tuple[str, ...]
    lookahead_days: int
    max_events: int

    spreadsheet_name: str
    worksheet_name: str
    boats_worksheet_name: str
    export_path: Path


def _unset(value: str) -> bool:
    return not value.strip() or value.strip() == PLACEHOLDER


def _resolve(path: str) -> Path:
    """Interpret a configured path relative to the project root."""
    candidate = Path(path)
    return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate


def _as_titles(value: object) -> tuple[str, ...]:
    """Accept either a single string or a list of them, so a plain string in
    config.toml does not silently become a list of characters."""
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    return tuple(str(item) for item in value if str(item).strip())


def load_config() -> Config:
    """Read config.toml and .env. Does not validate values - see require_*."""
    if not CONFIG_FILE.exists():
        raise ConfigError(f"No config.toml found at {CONFIG_FILE}.")

    with CONFIG_FILE.open("rb") as f:
        raw = tomllib.load(f)

    spond_table = raw.get("spond", {})
    sheets_table = raw.get("sheets", {})

    load_dotenv(ENV_FILE)

    service_account_file = Path(
        os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", DEFAULT_SERVICE_ACCOUNT_FILE)
    )
    if not service_account_file.is_absolute():
        service_account_file = PROJECT_ROOT / service_account_file

    return Config(
        spond_username=os.environ.get("SPOND_USERNAME", ""),
        spond_password=os.environ.get("SPOND_PASSWORD", ""),
        service_account_file=service_account_file,
        group_name=str(spond_table.get("group_name", "")),
        event_title_matches=_as_titles(spond_table.get("event_title_matches")),
        lookahead_days=int(spond_table.get("lookahead_days", 14)),
        max_events=int(spond_table.get("max_events", 100)),
        spreadsheet_name=str(sheets_table.get("spreadsheet_name", "")),
        worksheet_name=str(sheets_table.get("worksheet_name", "Attendance")),
        boats_worksheet_name=str(sheets_table.get("boats_worksheet_name", "Boats")),
        export_path=_resolve(
            str(raw.get("export", {}).get("path", "data/attendance.json"))
        ),
    )


def require_login(config: Config) -> None:
    """Needed by every command that talks to Spond."""
    missing = [
        key
        for key, value in (
            ("SPOND_USERNAME", config.spond_username),
            ("SPOND_PASSWORD", config.spond_password),
        )
        if _unset(value)
    ]
    if missing:
        raise ConfigError(
            f"{' and '.join(missing)} not set in {ENV_FILE.name}. "
            f"Copy .env.example to .env and fill it in."
        )


def require_group(config: Config) -> None:
    """Needed to fetch events, but not to list groups."""
    if _unset(config.group_name):
        raise ConfigError(
            "config.toml [spond] group_name is not set. "
            "Run `python -m crew_bot groups` to see the groups you can access, "
            "then paste the one you want into config.toml."
        )
    if not config.event_title_matches:
        # An empty list would match nothing and write an empty sheet, which
        # looks like "nobody signed up" rather than like a broken config.
        raise ConfigError(
            "config.toml [spond] event_title_matches is empty, so no session "
            "would ever match. List the session titles you want, e.g. "
            '["monday rowing", "thursday rowing"].'
        )


def require_sheets(config: Config) -> None:
    """Needed only by commands that write to Google."""
    if _unset(config.spreadsheet_name):
        raise ConfigError(
            "config.toml [sheets] spreadsheet_name is not set. "
            "Set it to the exact name of the Google Sheet you want to write to."
        )
    if not config.service_account_file.exists():
        raise ConfigError(
            f"No service account key at {config.service_account_file}. "
            f"See README.md for how to create one, or set "
            f"GOOGLE_SERVICE_ACCOUNT_FILE in .env to point somewhere else."
        )
