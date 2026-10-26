"""Verify an encrypted PostgreSQL custom-format backup without touching production data."""

import argparse
import subprocess
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from backup_encrypted import MAGIC, key_from_environment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("backup", type=Path)
    parser.add_argument("--stdout", action="store_true", help="Write the verified PostgreSQL archive to standard output")
    args = parser.parse_args()
    data = args.backup.read_bytes()
    if len(data) <= len(MAGIC) + 12 + 16 or not data.startswith(MAGIC):
        raise SystemExit("Backup file is empty or has an invalid header")
    nonce_start = len(MAGIC)
    nonce = data[nonce_start:nonce_start + 12]
    ciphertext, tag = data[nonce_start + 12:-16], data[-16:]
    decryptor = Cipher(algorithms.AES(key_from_environment()), modes.GCM(nonce, tag)).decryptor()
    decryptor.authenticate_additional_data(MAGIC)
    archive = decryptor.update(ciphertext) + decryptor.finalize()
    if not archive:
        raise SystemExit("Backup decrypted to an empty archive")
    if args.stdout:
        sys.stdout.buffer.write(archive)
        return
    check = subprocess.run(["pg_restore", "--list", "-"], input=archive, capture_output=True)
    if check.returncode:
        raise SystemExit(f"pg_restore verification failed: {check.stderr.decode(errors='replace').strip()}")
    print(f"Verified encrypted backup: {args.backup} ({len(archive)} bytes of PostgreSQL archive)")


if __name__ == "__main__":
    sys.exit(main())
