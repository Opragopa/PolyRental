"""Create a read-only catalog reconciliation report before a production cleanup.

The report deliberately performs no updates.  It is intended to be run after an
encrypted database backup and before an operator approves an exact-match merge.
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select

from app.catalog_import import parse_catalog_csv
from app.db import Article, Equipment, Session


def normalized(value):
    return " ".join((value or "").casefold().split())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Исходная опись в UTF-8 CSV")
    parser.add_argument("--output", type=Path, required=True, help="Куда записать JSON-отчёт")
    args = parser.parse_args()

    source_models, source_assets = parse_catalog_csv(args.source.read_bytes())
    source_keys = {(normalized(model["fields"].get("description")), normalized(model["name"]))
                   for model in source_models.values()}
    with Session() as session:
        articles = session.scalars(select(Article).order_by(Article.id)).all()
        assets = session.scalars(select(Equipment).order_by(Equipment.id)).all()
        duplicate_inventory_codes = session.execute(
            select(Equipment.asset_inventory_code, func.count(Equipment.id)).where(
                Equipment.asset_inventory_code.is_not(None), Equipment.asset_inventory_code != ""
            ).group_by(Equipment.asset_inventory_code).having(func.count(Equipment.id) > 1)
        ).all()

    by_model = defaultdict(list)
    for article in articles:
        by_model[(normalized(article.description), normalized(article.name))].append(article)
    report = {
        "source": {"models": len(source_models), "assets": len(source_assets)},
        "database": {"articles": len(articles), "equipment": len(assets)},
        "empty_or_placeholder_serials": [asset.id for asset in assets if not normalized(asset.serial_number) or normalized(asset.serial_number) == "-"],
        "duplicate_inventory_codes": [{"code": code, "count": count} for code, count in duplicate_inventory_codes],
        "exact_merge_candidates": [
            {"type": key[0], "model": key[1], "article_ids": [article.id for article in group],
             "equipment": sum(1 for asset in assets if asset.article_id in {article.id for article in group})}
            for key, group in by_model.items() if key[0] and key[1] and len(group) > 1
        ],
        "source_model_matches": [article.id for article in articles
                                 if (normalized(article.description), normalized(article.name)) in source_keys],
        "notes": [
            "Report is read-only. Run scripts/backup_encrypted.py successfully before any merge.",
            "Only exact normalized type+model matches may be merged; all other rows require review.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: len(value) if isinstance(value, list) else value for key, value in report.items() if key not in {"notes"}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
