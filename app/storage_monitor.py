"""Read-only size checks. Reports metadata only, never customer content."""
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import text

from .db import engine

GIB = 1024 ** 3


def evaluate_storage(database_bytes, backup_sizes, latest_backup_age_hours, *,
                     database_limit=5 * GIB, backup_limit=50 * GIB, max_age_hours=26):
    alerts = []
    if database_bytes >= database_limit:
        alerts.append("database_size")
    if sum(backup_sizes) >= backup_limit:
        alerts.append("backup_size")
    if latest_backup_age_hours is None or latest_backup_age_hours >= max_age_hours:
        alerts.append("backup_stale_or_missing")
    return alerts


def storage_report(directory, database_limit=5 * GIB, backup_limit=50 * GIB, max_age_hours=26):
    directory = Path(directory)
    if not directory.is_dir():
        raise ValueError("Backup directory must exist and be readable")
    files = [path.stat() for path in directory.glob("polyrental-*.prbak") if path.is_file()]
    latest_age = ((datetime.now(timezone.utc).timestamp() - max(item.st_mtime for item in files)) / 3600
                  if files else None)
    with engine.connect() as connection:
        size = connection.scalar(text("SELECT pg_database_size(current_database())"))
        tables = [dict(row._mapping) for row in connection.execute(text("""
            SELECT relname AS name, pg_total_relation_size(relid) AS bytes
            FROM pg_stat_user_tables WHERE schemaname = current_schema()
            ORDER BY pg_total_relation_size(relid) DESC LIMIT 20
        """))]
    return {"database_bytes": size, "backup_bytes": sum(item.st_size for item in files),
            "backup_count": len(files), "latest_backup_age_hours": latest_age, "largest_tables": tables,
            "alerts": evaluate_storage(size, [item.st_size for item in files], latest_age,
                                       database_limit=database_limit, backup_limit=backup_limit,
                                       max_age_hours=max_age_hours),
            "partition_review": any("audit" in table["name"] and table["bytes"] >= GIB for table in tables)}
