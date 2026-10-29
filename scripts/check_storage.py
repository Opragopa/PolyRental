"""Emit size/backup freshness checks as JSON; exit 1 when a threshold is crossed."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.storage_monitor import GIB, storage_report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup_directory", type=Path)
    parser.add_argument("--database-limit-gib", type=float, default=float(os.getenv("DATABASE_WARN_GIB", "5")))
    parser.add_argument("--backup-limit-gib", type=float, default=float(os.getenv("BACKUP_WARN_GIB", "50")))
    parser.add_argument("--max-backup-age-hours", type=float, default=float(os.getenv("BACKUP_MAX_AGE_HOURS", "26")))
    args = parser.parse_args()
    if min(args.database_limit_gib, args.backup_limit_gib, args.max_backup_age_hours) <= 0:
        parser.error("Thresholds must be positive")
    report = storage_report(args.backup_directory, args.database_limit_gib * GIB,
                            args.backup_limit_gib * GIB, args.max_backup_age_hours)
    print(json.dumps(report))
    return int(bool(report["alerts"]))


if __name__ == "__main__":
    sys.exit(main())
