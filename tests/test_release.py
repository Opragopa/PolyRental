import pytest
from fastapi.testclient import TestClient

from app import __version__
from app.miniapp_server import app as miniapp_app
from app.web import app as web_app


@pytest.mark.parametrize("application", [miniapp_app, web_app], ids=["miniapp", "legacy-web"])
def test_release_version_is_visible_and_matches_health(application):
    with TestClient(application) as client:
        assert client.get("/health").json() == {"status": "ok", "version": __version__}
        page = client.get("/miniapp")
        assert page.status_code == 200
        assert page.headers["cache-control"] == "no-store"
        assert f'content="{__version__}"' in page.text
        assert f'>v{__version__}</button>' in page.text
        assert "__APP_VERSION__" not in page.text
        for asset in ["range-calendar.js", "app.js", "style.css"]:
            url = f"/miniapp/static/{asset}?v={__version__}"
            assert url in page.text
            assert client.get(url).status_code == 200
