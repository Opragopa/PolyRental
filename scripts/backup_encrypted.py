"""Create an encrypted PostgreSQL backup without writing a plaintext dump.

Run from the repository root with the project virtualenv Python. The output format
is: magic (16 bytes), nonce (12 bytes), ciphertext, GCM tag (16 bytes).
"""

import argparse
import base64
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b"POLYRENTALBAK01\0"


def key_from_environment():
    raw = os.environ.get("BACKUP_MASTER_KEY", "").strip()
    try:
        key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except Exception as exc:
        raise SystemExit("BACKUP_MASTER_KEY must be a 32-byte base64url value") from exc
    if len(key) != 32:
        raise SystemExit("BACKUP_MASTER_KEY must be a 32-byte base64url value")
    return key


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path, help="Dedicated directory for encrypted backups")
    parser.add_argument("--retention-days", type=int, default=30)
    parser.add_argument("--stdin", action="store_true", help="Read a PostgreSQL custom archive from standard input")
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    nonce = os.urandom(12)
    filename = args.directory / f"polyrental-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.prbak"
    process = None if args.stdin else subprocess.Popen(
        ["docker", "compose", "exec", "-T", "db", "pg_dump", "-U", "polyrental",
         "-d", "polyrental", "--format=custom"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    source = sys.stdin.buffer if args.stdin else process.stdout
    encryptor = Cipher(algorithms.AES(key_from_environment()), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(MAGIC)
    try:
        with filename.open("xb") as target:
            target.write(MAGIC)
            target.write(nonce)
            while chunk := source.read(1024 * 1024):
                target.write(encryptor.update(chunk))
            target.write(encryptor.finalize())
            target.write(encryptor.tag)
        error = process.stderr.read().decode(errors="replace") if process else ""
        if process and process.wait() != 0:
            filename.unlink(missing_ok=True)
            raise SystemExit(f"pg_dump failed: {error.strip()}")
    except Exception:
        if process:
            process.kill()
        filename.unlink(missing_ok=True)
        raise
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, args.retention_days))
    for old in args.directory.glob("polyrental-*.prbak"):
        if datetime.fromtimestamp(old.stat().st_mtime, timezone.utc) < cutoff:
            old.unlink()
    print(filename)


if __name__ == "__main__":
    sys.exit(main())
