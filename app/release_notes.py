"""Regular-release announcements with per-account acknowledgements."""
import json
from pathlib import Path
import re

from sqlalchemy import select, text

from . import __version__
from .db import ClientActivity, Session


def current_release():
    # A hotfix keeps the announcement identity of its regular release.
    match = re.fullmatch(r"(\d+\.\d+\.\d+)(?:-hotfix(?:[-.]?\d+)?)?", __version__)
    if not match:
        return None
    notes = json.loads((Path(__file__).parent / "assets" / "releases.json").read_text(encoding="utf-8"))
    return next((release for release in notes if release["version"] == match[1]), None)


def release_for_user(user_id, staff=False):
    release = current_release()
    if release is None:
        return None
    with Session() as session:
        seen = session.scalar(select(ClientActivity.id).where(ClientActivity.telegram_id == user_id,
            ClientActivity.action == f"release_seen:{release['version']}").limit(1)) is not None
    return {"version": release["version"], "date": release["date"], "seen": seen,
            "items": [{"title": item["title"], "text": item["text"]} for item in release["items"]
                      if item["audience"] == "all" or staff]}


def mark_release_seen(user_id, version):
    release = current_release()
    if release is None or version != release["version"]:
        raise ValueError("Обновление изменилось. Откройте приложение заново")
    action = f"release_seen:{version}"
    with Session.begin() as session:
        session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                        {"key": f"release-seen:{user_id}:{version}"})
        existing = session.scalar(select(ClientActivity.id).where(ClientActivity.telegram_id == user_id,
            ClientActivity.action == action).limit(1))
        if existing is not None:
            return False
        session.add(ClientActivity(telegram_id=user_id, action=action))
        return True
