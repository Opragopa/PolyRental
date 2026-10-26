"""Guard benchmark reporting and local-only dataset boundaries."""
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, BoundedSemaphore, Event

import pytest

from scripts.benchmark_documents import evaluate, manifest_cases, summarize
from app.document_check import Verdict, check_documents


def test_unknown_is_not_counted_as_success():
    rows = [{"expected":"student", "document":"unknown", "student":"unknown", "reason":"uncertain", "manual_review":True, "seconds":.2},
            {"expected":"other", "document":"document", "student":"other", "reason":"other_document", "manual_review":True, "seconds":.3}]
    result = summarize(rows)
    assert result["student_recall"] == 0
    assert result["document_accuracy"] == .5
    assert result["manual_review_rate"] == 1


def test_report_contains_codes_and_numbered_cases_only(monkeypatch):
    import scripts.benchmark_documents as benchmark
    monkeypatch.setattr(benchmark, "check_documents", lambda _: {"image": {
        "document":"document", "student":"student", "reason":"student_text", "manual_review":True}})
    secret = b"PRIVATE-IMAGE-CONTENT"
    report = evaluate([("student", "clean", secret)], "synthetic")
    assert report["cases"][0]["id"] == "case-0001"
    assert "PRIVATE-IMAGE-CONTENT" not in json.dumps(report)
    assert not report["passed"]  # No negative samples means no false-positive evidence.


def test_manifest_cannot_escape_dataset_root(tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps([{"path":"../private.png", "label":"student"}]))
    with pytest.raises(ValueError, match="invalid_manifest"):
        list(manifest_cases(manifest))


def test_saturated_checker_uses_manual_fallback_without_queue(monkeypatch):
    import app.document_check as module
    gate, ready = Event(), Barrier(3)
    class Blocked:
        def check(self, data):
            ready.wait(timeout=2)
            gate.wait(timeout=4)
            return Verdict()
    with ThreadPoolExecutor(max_workers=2) as workers, ThreadPoolExecutor(max_workers=2) as callers:
        monkeypatch.setattr(module, "_workers", workers)
        monkeypatch.setattr(module, "_slots", BoundedSemaphore(2))
        jobs = [callers.submit(check_documents, {"image": (b"synthetic", "image/png")}, Blocked()) for _ in range(2)]
        try:
            ready.wait(timeout=2)
            result = check_documents({"image": (b"synthetic", "image/png")})
            assert result["image"]["reason"] == "unavailable" and result["image"]["manual_review"]
        finally:
            gate.set()
        assert all(job.result()["image"]["manual_review"] for job in jobs)
