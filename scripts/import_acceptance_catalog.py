"""Merge an allowlisted catalogue snapshot into the isolated acceptance DB."""
import argparse
import json
import os
import sys
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.engine import make_url

from app.db import (Session, Article, ArticleImage, ArticleDependency, CatalogCategory,
                    Equipment, EquipmentFeature)


def apply_catalog(data, *, dry_run=False):
    if make_url(os.environ['DATABASE_URL']).database != 'polyrental_acceptance':
        raise RuntimeError('Only polyrental_acceptance is allowed')
    expected = {'categories', 'articles', 'equipment', 'features', 'images', 'dependencies'}
    if set(data) != expected:
        raise ValueError('Unexpected snapshot sections')
    counts = {key: len(rows) for key, rows in data.items()}
    added = dict.fromkeys(expected, 0)
    with Session() as session:
        try:
            if session.scalar(text('select current_database()')) != 'polyrental_acceptance':
                raise RuntimeError('Wrong target database')
            session.execute(text("SELECT pg_advisory_xact_lock(5111311)"))
            category_map = {}
            # Create all category rows before assigning parent references.
            for row in data['categories']:
                category = session.get(CatalogCategory, row['code'])
                category = category or session.scalar(select(CatalogCategory).where(CatalogCategory.normalized_name == row['normalized_name']))
                if category is None:
                    category = CatalogCategory(code=row['code'])
                    session.add(category); added['categories'] += 1
                category_map[row['code']] = category.code
                for key in ('name', 'normalized_name', 'icon'):
                    setattr(category, key, row[key])
                category.image_webp = bytes.fromhex(row['image_hex']) if row['image_hex'] else None
                session.flush()
            for row in data['categories']:
                session.get(CatalogCategory, category_map[row['code']]).parent_code = category_map.get(row['parent_code'])
            articles = {}
            for row in data['articles']:
                article = session.scalar(select(Article).where(Article.sku == row['sku']))
                if article is None:
                    article = Article(sku=row['sku']); session.add(article); added['articles'] += 1
                for key in ('name', 'description', 'composition', 'kind', 'brand', 'key_spec', 'inspection_profile',
                            'image_url', 'buffer_hours', 'is_active', 'is_test'):
                    setattr(article, key, row[key])
                article.hourly_rate = Decimal(str(row['hourly_rate']))
                article.category = category_map.get(row['category'], row['category'])
                article.archived_at = datetime.fromisoformat(row['archived_at']) if row['archived_at'] else None
                # Staff identities and audit history are deliberately excluded.
                session.flush(); articles[row['id']] = article.id
            equipment = {}
            for row in data['equipment']:
                asset = session.scalar(select(Equipment).where(Equipment.inventory_number == row['inventory_number']))
                if asset is None:
                    asset = Equipment(inventory_number=row['inventory_number']); session.add(asset); added['equipment'] += 1
                for key in ('name', 'description', 'image_url', 'condition', 'serial_number', 'asset_inventory_code',
                            'storage_location', 'health_percent', 'charge_percent'):
                    setattr(asset, key, row[key])
                asset.article_id = articles[row['article_id']] if row['article_id'] else None
                asset.hourly_rate = Decimal(str(row['hourly_rate']))
                session.flush(); equipment[row['id']] = asset.id
            for row in data['images']:
                target = articles[row['article_id']]
                image = session.get(ArticleImage, target)
                if image is None:
                    image = ArticleImage(article_id=target); session.add(image); added['images'] += 1
                image.webp = bytes.fromhex(row['image_hex'])
            for row in data['dependencies']:
                pair = (articles[row['parent_article_id']], articles[row['child_article_id']])
                dependency = session.get(ArticleDependency, pair)
                if dependency is None:
                    dependency = ArticleDependency(parent_article_id=pair[0], child_article_id=pair[1])
                    session.add(dependency); added['dependencies'] += 1
                dependency.quantity, dependency.billable = row['quantity'], row['billable']
            for row in data['features']:
                target = equipment[row['equipment_id']]
                feature = session.scalar(select(EquipmentFeature).where(EquipmentFeature.equipment_id == target,
                    EquipmentFeature.description == row['description'], EquipmentFeature.deleted_at.is_(None)))
                if feature is None:
                    session.add(EquipmentFeature(equipment_id=target, description=row['description'], source='catalog', actor_id=0))
                    added['features'] += 1
            session.flush()
            # Check bytes and references before making the transaction visible.
            for row in data['images']:
                assert session.get(ArticleImage, articles[row['article_id']]).webp == bytes.fromhex(row['image_hex'])
            if dry_run:
                session.rollback()
            else:
                session.commit()
        except BaseException:
            session.rollback()
            raise
    return {'mode': 'dry_run' if dry_run else 'committed', 'source': counts, 'added': added}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    print(json.dumps(apply_catalog(json.load(sys.stdin), dry_run=args.dry_run)))
