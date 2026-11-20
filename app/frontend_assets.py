"""Give each frontend file a new URL whenever its content changes."""
import hashlib
import re
from pathlib import Path

STATIC_DIR = Path(__file__).with_name('miniapp_static')
ASSET_URL = re.compile(r"(/miniapp/static/([A-Za-z0-9_.-]+\.(?:js|css)))(?:\?[^\s\"'<>]*)?")


def versioned_html(document, directory=STATIC_DIR):
    def replace(match):
        path = directory / match[2]
        if not path.is_file():
            return match[0]
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
        return f'{match[1]}?v={digest}'
    return ASSET_URL.sub(replace, document)


def frontend_build(directory=STATIC_DIR):
    digest = hashlib.sha256()
    for path in sorted(directory.iterdir()):
        if path.is_file() and path.suffix in {'.html', '.js', '.css'}:
            digest.update(path.name.encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:16]
