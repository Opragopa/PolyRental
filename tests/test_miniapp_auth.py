import json
import time
from urllib.parse import parse_qsl, urlencode

import pytest
from fastapi.testclient import TestClient

from app.miniapp_server import app
from tests.test_miniapp import configure, signed_init_data


@pytest.mark.parametrize("case", ["valid", "expired", "future", "tampered_user", "bad_hash", "duplicate", "empty"])
def test_init_data_http_boundary(monkeypatch, case):
    configure(monkeypatch)
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE", "3600")
    frozen = int(time.time())
    monkeypatch.setattr(time, "time", lambda: frozen)
    raw = signed_init_data(auth_date=frozen)
    if case == "expired":
        raw = signed_init_data(auth_date=frozen - 3601)
    elif case == "future":
        raw = signed_init_data(auth_date=frozen + 1)
    elif case in {"tampered_user", "bad_hash"}:
        data = dict(parse_qsl(raw))
        if case == "tampered_user":
            data["user"] = json.dumps({"id": 100, "first_name": "Forged staff"})
        else:
            data["hash"] = "0" * 64
        raw = urlencode(data)
    elif case == "duplicate":
        raw += "&auth_date=" + str(frozen)
    elif case == "empty":
        raw = ""
    with TestClient(app) as client:
        response = client.get("/api/miniapp/me", headers={"X-Telegram-Init-Data": raw})
    if case == "valid":
        assert response.status_code == 200
        assert response.json() == {"id": 42, "admin": False, "pii_admin": False}
    else:
        assert response.status_code == 401
        assert "Telegram" in response.json()["detail"]
