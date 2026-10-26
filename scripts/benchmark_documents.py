"""Reproducible local-only OCR benchmark. Never writes images or OCR text.

Default fixtures are generated drawings, not real identity documents. An optional
local manifest can reference an explicitly approved, anonymized evaluation set.
Only numbered case IDs, controlled conditions and verdict codes enter reports.
"""
import argparse
import hashlib
import io
import json
import random
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
from app.document_check import check_documents


CONDITIONS = ("clean", "low_light", "glare", "rotation", "perspective", "blur")
# Engineering regression gates for synthetic fixtures, not an agreed real-data SLA.
GATES = {"max_false_non_document_rate": 0.0, "max_false_student_rate": 0.0,
         "min_student_recall": 0.8, "max_p95_seconds": 3.0}


def synthetic_card(student, layout):
    image = Image.new("RGB", (1000, 620), (245, 242, 228) if layout % 2 else "white")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((12, 12, 988, 608), radius=20, outline="#243c60", width=5)
    font = ImageFont.truetype("DejaVuSans.ttf", 40 if layout % 2 else 44)
    small = ImageFont.truetype("DejaVuSans.ttf", 28)
    heading = ("STUDENT ID CARD" if layout % 2 else "СТУДЕНЧЕСКИЙ БИЛЕТ") if student else ("PASSPORT" if layout % 2 else "ПАСПОРТ")
    draw.text((48, 58), heading, fill="#162b50", font=font)
    draw.text((48, 130), "SAMPLE / ОБРАЗЕЦ", fill="black", font=small)
    draw.text((48, 180), "NOT VALID / НЕ ДЕЙСТВИТЕЛЕН", fill="black", font=small)
    draw.rectangle((48, 255, 278, 540), outline="#627083", width=3)
    draw.ellipse((110, 280, 215, 385), fill="#adb6c0")
    draw.polygon(((80, 510), (125, 395), (205, 395), (245, 510)), fill="#adb6c0")
    for y in (290, 355, 420, 485):
        draw.line((330, y, 905, y), fill="#536477", width=3)
    return image


def non_document(layout):
    image = Image.new("RGB", (1000, 620), (100 + layout * 15, 170, 220))
    draw = ImageDraw.Draw(image)
    if layout == 0:
        return Image.new("RGB", image.size, "white")
    rng = random.Random(layout)
    draw.rectangle((0, 410, 1000, 620), fill="#52864b")
    for _ in range(10):
        x, y = rng.randrange(800), rng.randrange(350)
        draw.ellipse((x, y, x + 160, y + 80), fill="#e5e9ec")
    if layout % 2:
        draw.text((80, 250), "RENTAL CAMERA", fill="black", font=ImageFont.truetype("DejaVuSans.ttf", 42))
    return image


def transform(image, condition):
    if condition == "low_light":
        return ImageEnhance.Brightness(ImageEnhance.Contrast(image).enhance(.65)).enhance(.28)
    if condition == "glare":
        overlay = Image.new("RGB", image.size, "white")
        mask = Image.new("L", image.size, 0)
        ImageDraw.Draw(mask).ellipse((350, 180, 1100, 650), fill=210)
        return Image.composite(overlay, image, mask.filter(ImageFilter.GaussianBlur(35)))
    if condition == "rotation":
        return image.rotate(12, resample=Image.Resampling.BICUBIC, expand=True, fillcolor="white")
    if condition == "perspective":
        w, h = image.size
        return image.transform(image.size, Image.Transform.QUAD,
            (30, 12, 0, h - 25, w - 30, h, w, 35), resample=Image.Resampling.BICUBIC, fillcolor="white")
    if condition == "blur":
        return image.filter(ImageFilter.GaussianBlur(1.2))
    return image


def synthetic_cases():
    for label in ("student", "other", "not_document"):
        for layout in range(4):
            source = non_document(layout) if label == "not_document" else synthetic_card(label == "student", layout)
            for condition in CONDITIONS:
                output = io.BytesIO()
                transform(source, condition).save(output, format="PNG")
                yield label, condition, output.getvalue()


def manifest_cases(manifest_path):
    from app.pii import sanitize_image
    root = manifest_path.resolve().parent
    entries = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(entries, list) or not 1 <= len(entries) <= 2000:
        raise ValueError("invalid_manifest")
    for entry in entries:
        label, condition = entry.get("label"), entry.get("condition", "clean")
        if label not in {"student", "other", "not_document"} or condition not in CONDITIONS:
            raise ValueError("invalid_manifest")
        path = (root / entry["path"]).resolve()
        if not path.is_relative_to(root):
            raise ValueError("invalid_manifest")
        mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(path.suffix.lower())
        if not mime or path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("invalid_case")
        yield label, condition, sanitize_image(path.read_bytes(), mime)[0]


def summarize(rows):
    positives = [r for r in rows if r["expected"] != "not_document"]
    students = [r for r in rows if r["expected"] == "student"]
    negatives = [r for r in rows if r["expected"] != "student"]
    ratio = lambda total, rows: round(total / len(rows), 4) if rows else None
    durations = sorted(r["seconds"] for r in rows)
    return {
        "cases": len(rows), "labels": dict(Counter(r["expected"] for r in rows)),
        "document_accuracy": ratio(sum(r["document"] == ("not_document" if r["expected"] == "not_document" else "document") for r in rows), rows),
        "document_coverage": ratio(sum(r["document"] != "unknown" for r in rows), rows),
        "student_recall": ratio(sum(r["student"] == "student" for r in students), students),
        "false_non_document_rate": ratio(sum(r["document"] == "not_document" for r in positives), positives),
        "false_student_rate": ratio(sum(r["student"] == "student" for r in negatives), negatives),
        "manual_review_rate": ratio(sum(r["manual_review"] for r in rows), rows),
        "p50_seconds": round(statistics.median(durations), 4),
        "p95_seconds": durations[max(0, int(len(durations) * .95 + .9999) - 1)],
        "reasons": dict(Counter(r["reason"] for r in rows)),
    }


def evaluate(cases, source):
    rows, digest = [], hashlib.sha256()
    for number, (label, condition, image) in enumerate(cases, 1):
        digest.update(label.encode() + condition.encode() + image)
        started = time.monotonic()
        verdict = check_documents({"image": (image, "image/png")})["image"]
        rows.append({"id": f"case-{number:04}", "expected": label, "condition": condition,
                     **verdict, "seconds": round(time.monotonic() - started, 4)})
    if not rows:
        raise ValueError("empty_dataset")
    metrics = summarize(rows)
    gates = {
        "false_non_document": metrics["false_non_document_rate"] is not None and metrics["false_non_document_rate"] <= GATES["max_false_non_document_rate"],
        "false_student": metrics["false_student_rate"] is not None and metrics["false_student_rate"] <= GATES["max_false_student_rate"],
        "student_recall": metrics["student_recall"] is not None and metrics["student_recall"] >= GATES["min_student_recall"],
        "latency": metrics["p95_seconds"] < GATES["max_p95_seconds"],
    }
    return {"schema": 1, "source": source, "dataset_sha256": digest.hexdigest(),
            "gates_scope": "synthetic_engineering_regression_only" if source == "synthetic" else "provisional_not_user_agreed",
            "thresholds": GATES, "metrics": metrics, "gates": gates, "passed": all(gates.values()),
            "by_condition": {condition: summarize([r for r in rows if r["condition"] == condition])
                             for condition in CONDITIONS if any(r["condition"] == condition for r in rows)},
            "cases": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--approved-local-dataset", action="store_true")
    args = parser.parse_args()
    if args.manifest and not args.approved_local_dataset:
        parser.error("A manifest requires --approved-local-dataset and the owner's prior authorization")
    try:
        report = evaluate(manifest_cases(args.manifest) if args.manifest else synthetic_cases(),
                          "approved_local_manifest" if args.manifest else "synthetic")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"passed": report["passed"], "source": report["source"], "metrics": report["metrics"], "gates": report["gates"]}))
        return 0 if report["passed"] else 1
    except Exception:
        # File names, OCR output and provider exceptions may contain PII.
        print('{"error":"benchmark_failed_without_logging_private_input"}', file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
