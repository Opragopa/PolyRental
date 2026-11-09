"""Small, metadata-free catalogue previews stored with the model in PostgreSQL."""
import base64
import io
import warnings
from datetime import datetime, timezone

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select

from .db import Article, ArticleImage, Session
from .inventory import require_role

MAX_UPLOAD = 8 * 1024 * 1024
MAX_PREVIEW = 100 * 1024


def thumbnail(raw):
    if not raw or len(raw) > MAX_UPLOAD:
        raise ValueError("Фото должно быть не больше 8 МБ")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"} or source.width * source.height > 24_000_000:
                    raise ValueError("Используйте JPEG, PNG или WebP до 24 мегапикселей")
                oriented = ImageOps.exif_transpose(source)
                has_alpha = "A" in oriented.getbands() or "transparency" in oriented.info
                image = oriented.convert("RGBA" if has_alpha else "RGB")
                image.thumbnail((640, 640), Image.Resampling.LANCZOS)
                for quality in (85, 70, 50, 30):
                    output = io.BytesIO()
                    image.save(output, format="WEBP", quality=quality, method=6)
                    if output.tell() <= MAX_PREVIEW:
                        return output.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("Не удалось прочитать фото") from exc
    raise ValueError("Фото слишком сложное: уменьшите размер изображения")


def image_data(session, article_ids):
    if not article_ids:
        return {}
    return {row.article_id: "data:image/webp;base64," + base64.b64encode(row.webp).decode("ascii")
            for row in session.scalars(select(ArticleImage).where(ArticleImage.article_id.in_(article_ids)))}


def save_image(article_id, raw, actor_id):
    require_role(actor_id)
    preview = thumbnail(raw) if raw is not None else None
    with Session.begin() as session:
        if not session.get(Article, article_id, with_for_update=True):
            raise ValueError("Модель оборудования не найдена")
        row = session.get(ArticleImage, article_id)
        if preview is None:
            if row:
                session.delete(row)
        else:
            if row is None:
                row = ArticleImage(article_id=article_id)
                session.add(row)
            row.webp, row.updated_at = preview, datetime.now(timezone.utc)
