"""SLA deadlines for one request, using the configured business calendar."""
from datetime import datetime, timedelta, timezone
from .sla_clock import add_business_time, business_time_between


def request_sla(booking, at=None):
    at = at or datetime.now(timezone.utc)
    if booking.sla_closed_at is not None or booking.status in {"returned", "cancelled", "expired"}:
        return {"stage": "closed", "deadline": None, "breached": False, "admin_breached": False, "soon": False, "progress": 1.0}
    claimed = booking.claimed_at is not None
    start = booking.claimed_at if claimed else booking.created_at
    duration = timedelta(hours=24 if claimed else 2)
    deadline = add_business_time(start, duration)
    admin_deadline = add_business_time(start, timedelta(hours=48 if claimed else 26))
    elapsed = business_time_between(start, max(at, start))
    return {"stage": "resolve" if claimed else "claim", "deadline": deadline.isoformat(),
            "breached": at > deadline, "admin_breached": at > admin_deadline,
            "soon": at <= deadline and business_time_between(at, deadline) <= timedelta(hours=2),
            "progress": min(1.0, elapsed.total_seconds() / duration.total_seconds())}
