from fastapi.testclient import TestClient

from app.miniapp_server import app
from tests.test_miniapp import configure, signed_init_data


def _upload(client, headers, content):
    return client.post("/api/miniapp/admin/catalog/import-csv", headers=headers,
                       files={"file": ("equipment.csv", content, "text/csv")})


def test_csv_import_creates_models_and_equipment_atomically(monkeypatch):
    configure(monkeypatch)
    admin = {"X-Telegram-Init-Data": signed_init_data(100)}
    customer = {"X-Telegram-Init-Data": signed_init_data(42)}
    header = "sku;name;serial;location;condition;category;inspection_profile;buffer_hours\n"
    with TestClient(app) as client:
        assert _upload(client, customer, header.encode()).status_code == 403
        first = _upload(client, admin, ("\ufeff" + header +
            "CSV-CAM;Камера CSV;CSV-001;A-01;available;camera;camera;24\n"
            "CSV-CAM;Камера CSV;CSV-002;A-02;maintenance;camera;camera;24\n").encode())
        assert first.status_code == 200, first.text
        assert first.json() == {"articles_created": 1, "equipment_created": 2}
        second = _upload(client, admin, (header +
            "CSV-CAM;Камера CSV;CSV-003;A-03;available;;;\n").encode())
        assert second.status_code == 200, second.text
        assert second.json() == {"articles_created": 0, "equipment_created": 1}
        catalog = client.get("/api/miniapp/admin/catalog", headers=admin).json()
        article = next(item for item in catalog["articles"] if item["sku"] == "CSV-CAM")
        assert {item["serial"] for item in article["equipment"]} == {"CSV-001", "CSV-002", "CSV-003"}

        failed = _upload(client, admin, (header.replace("serial;", "serial;inventory_code;") +
            "CSV-OTHER;Другая модель;CSV-004;A-04;A-04;available;;;\n"
            "CSV-OTHER;Другая модель;CSV-001;A-04;A-05;available;;;\n").encode())
        assert failed.status_code == 422
        catalog = client.get("/api/miniapp/admin/catalog", headers=admin).json()
        assert not any(item["sku"] == "CSV-OTHER" for item in catalog["articles"])


def test_inventory_csv_allows_empty_and_duplicate_serials(monkeypatch):
    configure(monkeypatch)
    admin = {"X-Telegram-Init-Data": signed_init_data(100)}
    inventory = (
        "№,Наименование,Модель,S/N,Оценочная стоимость,Инвентаризационный номер/ Код ОС\n"
        "1,Наушники,Sony MDR,-,1000,OS-001\n"
        "2,Наушники,Sony MDR,-,1000,OS-002\n"
        "3,,,,,\n"
    ).encode()
    with TestClient(app) as client:
        imported = _upload(client, admin, inventory)
        assert imported.status_code == 200, imported.text
        assert imported.json() == {"articles_created": 1, "equipment_created": 2}
        catalog = client.get("/api/miniapp/admin/catalog", headers=admin).json()
        article = next(item for item in catalog["articles"] if item["name"] == "Sony MDR")
        assert article["description"] == "Наушники"
        assert {item["serial"] for item in article["equipment"]} == {""}
        assert {item["inventory_code"] for item in article["equipment"]} == {"OS-001", "OS-002"}


def test_csv_import_rejects_invalid_file_without_writes(monkeypatch):
    configure(monkeypatch)
    admin = {"X-Telegram-Init-Data": signed_init_data(100)}
    with TestClient(app) as client:
        assert _upload(client, admin, b"sku,name,serial\nCSV-X,Camera,\xff\n").status_code == 422
        invalid = _upload(client, admin, b"sku,name,serial,condition\nCSV-X,Camera,CSV-X-1,broken\n")
        assert invalid.status_code == 422
        assert "Строка 2" in invalid.json()["detail"]
        catalog = client.get("/api/miniapp/admin/catalog", headers=admin).json()
        assert not any(item["sku"] == "CSV-X" for item in catalog["articles"])
