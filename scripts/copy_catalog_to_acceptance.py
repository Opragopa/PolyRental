"""Copy catalogue only; never export customers, bookings, documents or outbox."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SECTIONS = {
    'categories': 'SELECT code,name,normalized_name,parent_code,icon,encode(image_webp,\'hex\') AS image_hex FROM catalog_categories ORDER BY code',
    'articles': 'SELECT id,sku,name,description,composition,kind,brand,key_spec,category,inspection_profile,image_url,hourly_rate,buffer_hours,is_active,archived_at,is_test FROM articles ORDER BY id',
    'equipment': 'SELECT id,inventory_number,serial_number,asset_inventory_code,name,description,image_url,hourly_rate,condition,article_id,storage_location,health_percent,charge_percent FROM equipment ORDER BY id',
    'features': 'SELECT equipment_id,description FROM equipment_features WHERE deleted_at IS NULL ORDER BY id',
    'images': "SELECT article_id,encode(webp,'hex') AS image_hex FROM article_images ORDER BY article_id",
    'dependencies': 'SELECT parent_article_id,child_article_id,quantity,billable FROM article_dependencies ORDER BY parent_article_id,child_article_id',
}


def run(command, data=None):
    return subprocess.run(command, input=data, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    entries = [f"'{name}', COALESCE((SELECT json_agg(rows) FROM ({sql}) rows), '[]'::json)" for name, sql in SECTIONS.items()]
    query = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object(' + ','.join(entries) + '); COMMIT;'
    snapshot = run(['docker', 'exec', 'polyrental-db-1', 'psql', '-X', '-qAt', '-U', 'polyrental', '-d', 'polyrental', '-v', 'ON_ERROR_STOP=1', '-c', query])
    json.loads(snapshot)  # Refuse partial or invalid exports.
    directory = ROOT / 'artifacts' / 'focus-group'
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    (directory / f'catalog-{stamp}.json').write_bytes(snapshot)
    importer = (ROOT / 'scripts' / 'import_acceptance_catalog.py').read_text(encoding='utf-8')
    command = ['docker', 'compose', '-p', 'polyrental-acceptance', '-f', 'compose.acceptance.yaml', 'exec', '-T', 'miniapp', 'python', '-c', importer]
    print(run(command + ['--dry-run'], snapshot).decode().strip())
    if args.apply:
        backup = run(['docker', 'exec', 'polyrental-acceptance-db-1', 'pg_dump', '-U', 'acceptance', '-d', 'polyrental_acceptance', '-Fc'])
        backup_path = directory / f'acceptance-before-{stamp}.dump'
        backup_path.write_bytes(backup)
        print('Acceptance backup:', backup_path)
        print(run(command, snapshot).decode().strip())
        # The same snapshot must be safe to repeat without adding duplicates.
        verification = json.loads(run(command + ['--dry-run'], snapshot))
        if any(verification['added'].values()):
            raise RuntimeError('Repeat import would add duplicates')
        print('Verified: repeat import adds no duplicates')


if __name__ == '__main__':
    main()
