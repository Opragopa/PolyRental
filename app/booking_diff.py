"""Safe equipment/date comparisons; private comments never enter history."""
from datetime import datetime

from sqlalchemy import select


def comparison(before, after):
    old = {row["article_id"]: row for row in before.get("lines", [])}
    new = {row["article_id"]: row for row in after.get("lines", [])}
    lines = []
    for article_id in sorted(old.keys() | new.keys()):
        previous, current = old.get(article_id, {}), new.get(article_id, {})
        first, last = previous.get("quantity", 0), current.get("quantity", 0)
        if first != last:
            lines.append({"article_id": article_id, "name": current.get("name") or previous.get("name") or str(article_id),
                          "before": first, "after": last,
                          "kind": "added" if not first else "removed" if not last else "updated"})
    dates = []
    for field in ("start", "end"):
        first, last = before.get(field), after.get(field)
        if first and last and datetime.fromisoformat(first) != datetime.fromisoformat(last):
            dates.append({"field": field, "before": first, "after": last})
    return {"lines": lines, "dates": dates}


def attach_history_details(session, booking_id, items):
    from .db import BookingChange
    from .booking_changes import _decode
    targets = {item["id"]: item for item in items if item["action"] in {"request_changes_proposed", "request_updated"}}
    if not targets:
        return items
    for change in session.scalars(select(BookingChange).where(BookingChange.booking_id == booking_id)):
        if not change.ciphertext:
            continue
        payload = _decode(change)
        for audit_id, snapshots in payload.get("history", {}).items():
            target = targets.get(f"audit:{audit_id}")
            if target:
                target["changes"] = comparison(snapshots["before"], snapshots["after"])
        # Legacy proposals have exact transaction timestamps; actual edits did
        # not retain snapshots, so never guess their contents from a later state.
        if change.change_type == "manager_edit":
            for target in targets.values():
                if ("changes" not in target and target["action"] == "request_changes_proposed"
                        and target["actor_id"] == change.actor_id
                        and datetime.fromisoformat(target["created_at"]) == change.created_at):
                    target["changes"] = comparison(payload.get("before", {}), payload.get("after", {}))
    for target in targets.values():
        if "changes" not in target:
            target["changes_unavailable"] = True
    return items
