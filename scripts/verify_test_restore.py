"""Exercise encrypted backup/restore exclusively in Compose's isolated db_test.

No production database is accessed and no plaintext dump is written to disk.
The disposable verification database and ephemeral backup are removed afterward.
"""
import base64
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
DB_COMMAND = ["docker", "compose", "exec", "-T", "db_test"]


def run(command, data=None, env=None):
    return subprocess.run(command, cwd=ROOT, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, env=env, check=True).stdout


def fingerprint(database):
    query = """SELECT json_build_object(
        'bookings', (SELECT count(*) FROM bookings),
        'handovers', (SELECT count(*) FROM booking_handovers),
        'documents', (SELECT count(*) FROM booking_documents),
        'changes', (SELECT count(*) FROM booking_changes),
        'identities', (SELECT count(*) FROM customer_identities),
        'catalog_images', (SELECT count(*) FROM article_images),
        'image_digest', (SELECT md5(coalesce(string_agg(md5(webp), ',' ORDER BY article_id), '')) FROM article_images),
        'document_digest', (SELECT md5(coalesce(string_agg(sha256, ',' ORDER BY booking_id, kind), '')) FROM booking_documents),
        'revision', (SELECT version_num FROM alembic_version))"""
    result = run([*DB_COMMAND, "psql", "-U", "polyrental", "-d", database, "-At", "-c", query])
    return json.loads(result)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--seed-synthetic",action="store_true")
    parser.add_argument("--fresh-migrations",action="store_true")
    args=parser.parse_args()
    if args.fresh_migrations:
        expected_head = run(["docker", "compose", "run", "--rm", "--no-deps",
            "--volume", f"{ROOT.as_posix()}:/app", "test", "python", "-c",
            "from alembic.config import Config; from alembic.script import ScriptDirectory; "
            "print(ScriptDirectory.from_config(Config('alembic.ini')).get_current_head())"
        ]).decode().strip()
        migration_name="polyrental_migration_test_"+uuid4().hex
        assert migration_name.startswith("polyrental_migration_test_") and len(migration_name)<63
        run([*DB_COMMAND,"createdb","-U","polyrental",migration_name])
        try:
            dsn=f"postgresql+psycopg://polyrental:polyrental_test@db_test:5432/{migration_name}"
            for _ in range(2):
                run(["docker","compose","run","--rm","--no-deps","--volume",f"{ROOT.as_posix()}:/app",
                    "--env",f"DATABASE_URL={dsn}","test","alembic","upgrade","head"])
            revision = fingerprint(migration_name)["revision"]
            if revision != expected_head:
                raise RuntimeError(f"Fresh migrations reached {revision}, expected {expected_head}")
        finally:
            run([*DB_COMMAND,"dropdb","-U","polyrental",migration_name])
    if args.seed_synthetic:
        run(["docker","compose","run","--rm","--no-deps","--volume",f"{ROOT.as_posix()}:/app","test","python","scripts/seed_backup_verification.py"])
    restore_name = "polyrental_restore_test_" + uuid4().hex
    # Every database-changing command below targets a fresh name in db_test.
    assert restore_name.startswith("polyrental_restore_test_") and len(restore_name) < 63
    source = fingerprint("polyrental_test")
    archive = run([*DB_COMMAND, "pg_dump", "-U", "polyrental", "-d", "polyrental_test", "-Fc"])
    environment = {**os.environ, "BACKUP_MASTER_KEY": base64.urlsafe_b64encode(os.urandom(32)).decode()}
    created = False
    with tempfile.TemporaryDirectory(prefix="polyrental-backup-qa-") as folder:
        assert Path(folder).resolve().parent==Path(tempfile.gettempdir()).resolve()
        run([sys.executable, str(ROOT / "scripts/backup_encrypted.py"), folder, "--stdin"], archive, environment)
        backups = list(Path(folder).glob("*.prbak"))
        if len(backups) != 1:
            raise RuntimeError("Expected exactly one encrypted test backup")
        restored_archive = run([sys.executable, str(ROOT / "scripts/verify_encrypted_backup.py"),
                                str(backups[0]), "--stdout"], env=environment)
        if restored_archive != archive:
            raise RuntimeError("Encrypted backup round-trip differs")
        try:
            run([*DB_COMMAND, "createdb", "-U", "polyrental", restore_name])
            created = True
            run([*DB_COMMAND, "pg_restore", "-U", "polyrental", "--exit-on-error", "--no-owner", "-d", restore_name], restored_archive)
            target = fingerprint(restore_name)
            if source != target:
                raise RuntimeError("Restored database does not match the source fingerprint")
            print(json.dumps({"status": "passed", "source": "db_test/polyrental_test", "fresh_migrations":args.fresh_migrations,"restored": source}, ensure_ascii=False))
        finally:
            if created:
                run([*DB_COMMAND, "dropdb", "-U", "polyrental", restore_name])


if __name__ == "__main__":
    main()

