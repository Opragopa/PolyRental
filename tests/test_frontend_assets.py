import re

from fastapi.testclient import TestClient

from app.frontend_assets import frontend_build, versioned_html
from app.miniapp import miniapp_html
from app.miniapp_server import app


def test_changed_file_gets_new_url_without_version_bump(tmp_path):
    (tmp_path / 'app.js').write_text('first')
    (tmp_path / 'design.css').write_text('styles')
    document = '<script src="/miniapp/static/app.js?v=0.5.11"></script><link href="/miniapp/static/design.css?v=0.5.11">'
    before = versioned_html(document, tmp_path)
    build = frontend_build(tmp_path)
    (tmp_path / 'app.js').write_text('second')
    after = versioned_html(document, tmp_path)
    assert before.split('</script>')[0] != after.split('</script>')[0]
    assert before.split('</script>')[1] == after.split('</script>')[1]
    assert build != frontend_build(tmp_path)
    assert versioned_html(document, tmp_path) == after


def test_served_html_and_static_revalidate():
    client = TestClient(app)
    response = client.get('/miniapp')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    urls = re.findall(r'/miniapp/static/(?:(?:app|site-navigation)\.js|(?:design|desktop)\.css|startup\.(?:js|css))\?v=[0-9a-f]{16}', response.text)
    assert len(urls) == 6
    for url in urls:
        asset = client.get(url)
        assert asset.status_code == 200
        assert asset.headers['cache-control'] == 'no-cache, max-age=0, must-revalidate'
        cached = client.get(url, headers={'If-None-Match':asset.headers['etag']})
        assert cached.status_code == 304
        assert cached.headers['cache-control'] == 'no-cache, max-age=0, must-revalidate'


def test_continuous_corners_stylesheet_is_acceptance_only(monkeypatch):
    monkeypatch.delenv('MINIAPP_CONTINUOUS_CORNERS', raising=False)
    assert 'acceptance-corners.css' not in miniapp_html()

    monkeypatch.setenv('MINIAPP_CONTINUOUS_CORNERS', '1')
    html = miniapp_html()
    urls = re.findall(r'/miniapp/static/acceptance-corners\.css\?v=[0-9a-f]{16}', html)
    assert len(urls) == 1
    assert html.index(urls[0]) > html.index('/miniapp/static/motion.css')
