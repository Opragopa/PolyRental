"""Advisory local document classification. Images/text never leave this process
and its local Tesseract child. No OCR text is stored, returned or logged.
"""

import io
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from dataclasses import asdict, dataclass
from threading import BoundedSemaphore
from typing import Protocol

from PIL import Image, ImageOps, ImageStat


@dataclass(frozen=True)
class Verdict:
    document: str = "unknown"  # document / not_document / unknown
    student: str = "unknown"   # student / other / unknown
    reason: str = "manual_review"
    manual_review: bool = True


REASONS = {
    "manual_review": "Нужна ручная проверка",
    "student_text": "Найдены признаки студенческого билета; подтвердите вручную",
    "other_document": "Найдены признаки другого документа; проверьте тип вручную",
    "blank_image": "Однотонное изображение: признаки документа не обнаружены",
    "uncertain": "Недостаточно признаков: возможны блики, наклон или нечёткое фото",
    "unavailable": "Локальная проверка недоступна; проверьте вручную",
    "timeout": "Время автоматической проверки истекло; проверьте вручную",
}


class DocumentChecker(Protocol):
    def check(self, data: bytes) -> Verdict: ...


def _deskew(image):
    """Estimate small page tilt locally from horizontal ink projections.

    A 360px working mask bounds the cost. It contains no extracted text and
    is never stored. Require a clear score improvement to leave upright or
    unstructured images alone; unreadable inputs still go to manual review.
    """
    mask = image.copy()
    mask.thumbnail((360, 360))
    mask = mask.point(lambda value: 255 if value < 110 else 0)

    def score(angle):
        candidate = mask.rotate(angle, resample=Image.Resampling.NEAREST, expand=True, fillcolor=0)
        data, width = candidate.tobytes(), candidate.width
        rows = [sum(data[offset:offset + width]) for offset in range(0, len(data), width)]
        return sum((right - left) ** 2 for left, right in zip(rows, rows[1:]))

    baseline = score(0)
    angle, best = 0, baseline
    for candidate in (-15, -12, -9, -6, -3, 3, 6, 9, 12, 15):
        value = score(candidate)
        if value > best:
            angle, best = candidate, value
    if angle and best > baseline * 1.25:
        image = image.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=255)
        image.thumbnail((1400, 1400))
    return image


class LocalDocumentChecker:
    def check(self, data):
        with Image.open(io.BytesIO(data)) as image:
            image = ImageOps.exif_transpose(image).convert("L")
            image.thumbnail((1400, 1400))
            if ImageStat.Stat(image).stddev[0] < 2:
                return Verdict("not_document", "unknown", "blank_image")
            output = io.BytesIO()
            _deskew(ImageOps.autocontrast(image)).save(output, format="PNG")
        try:
            result = subprocess.run(
                ["tesseract", "stdin", "stdout", "-l", "rus+eng", "--psm", "11"],
                input=output.getvalue(), capture_output=True, timeout=0.65,
                check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired:
            return Verdict(reason="timeout")
        except (OSError, subprocess.CalledProcessError):
            return Verdict(reason="unavailable")
        text = re.sub(r"\s+", " ", result.stdout.decode("utf-8", errors="replace").casefold())
        if re.search(r"студенческ\w*\s+билет|student\s+(?:id|card)", text):
            return Verdict("document", "student", "student_text")
        if re.search(r"паспорт|passport|удостоверени|свидетельств|водительск", text):
            return Verdict("document", "other", "other_document")
        return Verdict(reason="uncertain")


_workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="document-check")
_slots = BoundedSemaphore(2)


def check_documents(documents, checker: DocumentChecker | None = None):
    """Bound the entire batch to 2.2s, including a hung internal provider.

    At most two batches are outstanding; saturation immediately uses manual
    review. The default provider also bounds each local OCR child to 650ms.
    """
    fallback = {kind: asdict(Verdict(reason="unavailable")) for kind in documents}
    if os.getenv("DOCUMENT_CHECK_MODE", "local") == "manual":
        return {kind: asdict(Verdict()) for kind in documents}
    if not documents:
        return fallback
    if not _slots.acquire(blocking=False):
        return fallback
    provider = checker or LocalDocumentChecker()

    def run():
        return {kind: asdict(provider.check(data[0])) for kind, data in documents.items()}

    future = _workers.submit(run)
    future.add_done_callback(lambda _: _slots.release())
    try:
        checks = future.result(timeout=2.2)
        # Providers may only return controlled codes, never recognized text.
        for check in checks.values():
            if (check["reason"] not in REASONS or check["document"] not in {"document", "not_document", "unknown"}
                    or check["student"] not in {"student", "other", "unknown"}):
                return fallback
            check["manual_review"] = True
        return {kind: {"document": check["document"], "student": check["student"],
                       "reason": check["reason"], "manual_review": True}
                for kind, check in checks.items()}
    except TimeoutError:
        return {kind: asdict(Verdict(reason="timeout")) for kind in documents}
    except Exception:
        # Never log exception messages: providers may put OCR/PII in them.
        return fallback
