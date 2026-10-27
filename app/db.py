import os
from datetime import datetime
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import (BigInteger, Boolean, DateTime, ForeignKey, Integer, LargeBinary,
                        Numeric, String, Text, UniqueConstraint, create_engine, inspect,
                        select, text)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker


class Base(DeclarativeBase):
    pass


class Article(Base):
    __tablename__ = "articles"
    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    composition: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String(80), default="", server_default="")
    brand: Mapped[str] = mapped_column(String(100), default="", server_default="")
    key_spec: Mapped[str] = mapped_column(String(120), default="", server_default="")
    category: Mapped[str] = mapped_column(String(40), default="generic")
    inspection_profile: Mapped[str] = mapped_column(String(30), default="generic")
    image_url: Mapped[str] = mapped_column(String(500), default="")
    hourly_rate: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    buffer_hours: Mapped[int] = mapped_column(Integer, default=24)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    equipment: Mapped[list["Equipment"]] = relationship(back_populates="article")


class ArticleTitleAudit(Base):
    __tablename__ = "article_title_audit"
    id: Mapped[int] = mapped_column(primary_key=True)
    article_id: Mapped[int | None] = mapped_column(ForeignKey("articles.id", ondelete="SET NULL"), nullable=True, index=True)
    actor_id: Mapped[int] = mapped_column(BigInteger)
    before: Mapped[str] = mapped_column(Text)
    after: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class ArticleDependency(Base):
    __tablename__ = "article_dependencies"
    parent_article_id: Mapped[int] = mapped_column(ForeignKey("articles.id", ondelete="CASCADE"), primary_key=True)
    child_article_id: Mapped[int] = mapped_column(ForeignKey("articles.id", ondelete="RESTRICT"), primary_key=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    billable: Mapped[bool] = mapped_column(Boolean, default=False)
    parent: Mapped[Article] = relationship(foreign_keys=[parent_article_id])
    child: Mapped[Article] = relationship(foreign_keys=[child_article_id])


class Equipment(Base):
    __tablename__ = "equipment"
    id: Mapped[int] = mapped_column(primary_key=True)
    # Stable internal asset code. It remains unique even when a manufacturer
    # serial number or institutional inventory code is missing or repeated.
    inventory_number: Mapped[str] = mapped_column(String(80), unique=True)
    serial_number: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    asset_inventory_code: Mapped[str | None] = mapped_column(String(80), nullable=True, unique=True)
    # Legacy snapshot fields remain for rollback and old bot commands.
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    image_url: Mapped[str] = mapped_column(String(500), default="")
    hourly_rate: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    condition: Mapped[str] = mapped_column(String(30), default="available")
    article_id: Mapped[int | None] = mapped_column(ForeignKey("articles.id"), nullable=True, index=True)
    storage_location: Mapped[str] = mapped_column(String(120), default="")
    health_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    charge_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    article: Mapped[Article | None] = relationship(back_populates="equipment")


class Booking(Base):
    __tablename__ = "bookings"
    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(BigInteger)
    client_request_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    human_number: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)
    customer_name: Mapped[str] = mapped_column(String(200))
    customer_contact: Mapped[str] = mapped_column(String(200))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(30), default="pending")
    hold_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    identity_status: Mapped[str] = mapped_column(String(30), default="not_required")
    act_signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    act_signed_by: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    returned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    receipt_number: Mapped[str | None] = mapped_column(String(20), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    items: Mapped[list["BookingItem"]] = relationship(back_populates="booking", cascade="all, delete-orphan")
    lines: Mapped[list["BookingLine"]] = relationship(back_populates="booking", cascade="all, delete-orphan")
    assets: Mapped[list["BookingAsset"]] = relationship(back_populates="booking", cascade="all, delete-orphan")
    inspections: Mapped[list["Inspection"]] = relationship(cascade="all, delete-orphan")


class RequestNumberCounter(Base):
    __tablename__ = "request_number_counters"
    year: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_sequence: Mapped[int] = mapped_column(Integer, nullable=False)


class BookingOperationLease(Base):
    """Temporary claim on the current workflow stage, not ownership of a booking."""
    __tablename__ = "booking_operation_leases"
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), primary_key=True)
    stage: Mapped[str] = mapped_column(String(30), primary_key=True)
    actor_id: Mapped[int] = mapped_column(BigInteger)
    actor_name: Mapped[str] = mapped_column(String(160), default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class BookingItem(Base):
    """Legacy concrete booking rows, retained for migration compatibility."""
    __tablename__ = "booking_items"
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), primary_key=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id"), primary_key=True)
    hourly_rate: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    booking: Mapped[Booking] = relationship(back_populates="items")
    equipment: Mapped[Equipment] = relationship()


class BookingLine(Base):
    __tablename__ = "booking_lines"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), index=True)
    article_id: Mapped[int] = mapped_column(ForeignKey("articles.id"), index=True)
    quantity: Mapped[int] = mapped_column(Integer)
    billable_quantity: Mapped[int] = mapped_column(Integer, default=0)
    hourly_rate: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    auto_added: Mapped[bool] = mapped_column(Boolean, default=False)
    booking: Mapped[Booking] = relationship(back_populates="lines")
    article: Mapped[Article] = relationship()
    assets: Mapped[list["BookingAsset"]] = relationship(back_populates="line")
    __table_args__ = (UniqueConstraint("booking_id", "article_id", name="booking_line_article_unique"),)


class BookingAsset(Base):
    __tablename__ = "booking_assets"
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), primary_key=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id"), primary_key=True)
    booking_line_id: Mapped[int] = mapped_column(ForeignKey("booking_lines.id", ondelete="CASCADE"), index=True)
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    booking: Mapped[Booking] = relationship(back_populates="assets")
    line: Mapped[BookingLine] = relationship(back_populates="assets")
    equipment: Mapped[Equipment] = relationship()


class BookingDocument(Base):
    """Encrypted, durable copies of signed issue acts and saved receipts."""
    __tablename__ = "booking_documents"
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), primary_key=True)
    filename: Mapped[str] = mapped_column(String(160))
    media_type: Mapped[str] = mapped_column(String(120), default="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    encrypted_data: Mapped[bytes] = mapped_column(LargeBinary)
    nonce: Mapped[bytes] = mapped_column(LargeBinary)
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class Occupancy(Base):
    """Legacy per-asset occupancy. New reservations are quantity based."""
    __tablename__ = "occupancy"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), index=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id"), index=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Inspection(Base):
    __tablename__ = "inspections"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), index=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id"), index=True)
    stage: Mapped[str] = mapped_column(String(20))
    result: Mapped[str] = mapped_column(String(20))
    checklist: Mapped[dict] = mapped_column(JSONB, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")
    defect: Mapped[str] = mapped_column(Text, default="")
    estimated_cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    charge_customer: Mapped[bool] = mapped_column(Boolean, default=False)
    encrypted_photo: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    photo_nonce: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    photo_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actor_id: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    __table_args__ = (UniqueConstraint("booking_id", "equipment_id", "stage", name="inspection_asset_stage_unique"),)


class RepairTicket(Base):
    __tablename__ = "repair_tickets"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int | None] = mapped_column(ForeignKey("bookings.id"), nullable=True, index=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id"), index=True)
    status: Mapped[str] = mapped_column(String(30), default="open")
    defect: Mapped[str] = mapped_column(Text)
    estimated_cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    charge_customer: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    equipment: Mapped[Equipment] = relationship()


class CustomerIdentity(Base):
    __tablename__ = "customer_identities"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), unique=True, index=True)
    customer_id: Mapped[int] = mapped_column(BigInteger, index=True)
    encrypted_key: Mapped[bytes] = mapped_column(LargeBinary)
    key_nonce: Mapped[bytes] = mapped_column(LargeBinary)
    encrypted_payload: Mapped[bytes] = mapped_column(LargeBinary)
    payload_nonce: Mapped[bytes] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(String(30), default="submitted")
    review_comment: Mapped[str] = mapped_column(String(500), default="")
    review_fields: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), onupdate=text("now()"))
    delete_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    documents: Mapped[list["IdentityDocument"]] = relationship(cascade="all, delete-orphan")


class IdentityDocument(Base):
    __tablename__ = "identity_documents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    identity_id: Mapped[int] = mapped_column(ForeignKey("customer_identities.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    media_type: Mapped[str] = mapped_column(String(40), default="image/jpeg")
    encrypted_data: Mapped[bytes] = mapped_column(LargeBinary)
    nonce: Mapped[bytes] = mapped_column(LargeBinary)
    size: Mapped[int] = mapped_column(Integer)
    encrypted_check: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    check_nonce: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    __table_args__ = (UniqueConstraint("identity_id", "kind", name="identity_document_kind_unique"),)


class PrivacyConsent(Base):
    __tablename__ = "privacy_consents"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), unique=True, index=True)
    customer_id: Mapped[int] = mapped_column(BigInteger)
    policy_version: Mapped[str] = mapped_column(String(80))
    text_hash: Mapped[str] = mapped_column(String(64))
    consented_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class PIIAudit(Base):
    __tablename__ = "pii_audit"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int | None] = mapped_column(ForeignKey("bookings.id", ondelete="SET NULL"), nullable=True, index=True)
    actor_id: Mapped[int] = mapped_column(BigInteger)
    action: Mapped[str] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class Audit(Base):
    __tablename__ = "audit"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id"), index=True)
    actor_id: Mapped[int] = mapped_column(BigInteger)
    action: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class NotificationDelivery(Base):
    """Durable Telegram delivery log and retry queue."""
    __tablename__ = "notification_deliveries"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int | None] = mapped_column(ForeignKey("bookings.id", ondelete="SET NULL"), nullable=True, index=True)
    recipient_id: Mapped[int] = mapped_column(BigInteger, index=True)
    event: Mapped[str] = mapped_column(String(50))
    message: Mapped[str] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class BookingDeletionAudit(Base):
    """Minimal non-PII record that an operator permanently deleted a booking."""
    __tablename__ = "booking_deletion_audit"
    id: Mapped[int] = mapped_column(primary_key=True)
    deleted_booking_id: Mapped[int] = mapped_column(Integer, index=True)
    actor_id: Mapped[int] = mapped_column(BigInteger)
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


engine = create_engine(os.getenv("DATABASE_URL", "postgresql+psycopg://polyrental:polyrental@localhost:5432/polyrental"), pool_pre_ping=True)
Session = sessionmaker(engine, expire_on_commit=False)


def _columns(connection, table):
    return {column["name"] for column in inspect(connection).get_columns(table)}


def _legacy_backfill():
    with Session.begin() as session:
        groups = {}
        for item in session.scalars(select(Equipment).order_by(Equipment.id)).all():
            if item.article_id:
                continue
            key = (item.name.strip(), str(item.hourly_rate), item.description or "", item.image_url or "")
            article = groups.get(key) or session.scalar(select(Article).where(
                Article.name == key[0], Article.hourly_rate == item.hourly_rate,
                Article.description == key[2], Article.image_url == key[3]))
            if article is None:
                article = Article(sku=f"LEGACY-{item.id}", name=key[0], description=key[2],
                                  image_url=key[3], hourly_rate=item.hourly_rate)
                session.add(article)
                session.flush()
            groups[key] = article
            item.article_id = article.id
        session.flush()
        for booking in session.scalars(select(Booking).order_by(Booking.id)).all():
            if booking.lines or not booking.items:
                continue
            grouped = {}
            for old_item in booking.items:
                grouped.setdefault((old_item.equipment.article_id, old_item.hourly_rate), []).append(old_item.equipment)
            for (article_id, rate), assets in grouped.items():
                line = BookingLine(booking_id=booking.id, article_id=article_id,
                                   quantity=len(assets), hourly_rate=rate)
                session.add(line)
                session.flush()
                for asset in assets:
                    session.add(BookingAsset(booking_id=booking.id, booking_line_id=line.id,
                                             equipment_id=asset.id))


def init_db():
    # First pass creates independent new tables on an existing installation.
    Article.__table__.create(engine, checkfirst=True)
    with engine.begin() as connection:
        tables = inspect(connection).get_table_names()
        if "equipment" in tables:
            columns = _columns(connection, "equipment")
            additions = {
                "image_url": "VARCHAR(500) NOT NULL DEFAULT ''",
                "article_id": "INTEGER REFERENCES articles(id)",
                "storage_location": "VARCHAR(120) NOT NULL DEFAULT ''",
                "health_percent": "INTEGER", "charge_percent": "INTEGER",
            }
            for name, ddl in additions.items():
                if name not in columns:
                    connection.execute(text(f"ALTER TABLE equipment ADD COLUMN {name} {ddl}"))
        if "articles" in tables:
            columns = _columns(connection, "articles")
            for name, size in (("kind", 80), ("brand", 100), ("key_spec", 120)):
                if name not in columns:
                    connection.execute(text(f"ALTER TABLE articles ADD COLUMN {name} VARCHAR({size}) NOT NULL DEFAULT ''"))
            if "composition" not in columns:
                connection.execute(text("ALTER TABLE articles ADD COLUMN composition TEXT NOT NULL DEFAULT ''"))
        if "inspections" in tables:
            columns = _columns(connection, "inspections")
            additions = {"encrypted_photo": "BYTEA", "photo_nonce": "BYTEA", "photo_sha256": "VARCHAR(64)"}
            for name, ddl in additions.items():
                if name not in columns:
                    connection.execute(text(f"ALTER TABLE inspections ADD COLUMN {name} {ddl}"))
        if "bookings" in tables:
            columns = _columns(connection, "bookings")
            additions = {
                "client_request_id": "VARCHAR(36)",
                "identity_status": "VARCHAR(30) NOT NULL DEFAULT 'not_required'",
                "act_signed_at": "TIMESTAMPTZ", "act_signed_by": "BIGINT",
                "returned_at": "TIMESTAMPTZ", "receipt_number": "VARCHAR(20)",
                "human_number": "VARCHAR(32)",
            }
            for name, ddl in additions.items():
                if name not in columns:
                    connection.execute(text(f"ALTER TABLE bookings ADD COLUMN {name} {ddl}"))
        if "customer_identities" in tables:
            columns = _columns(connection, "customer_identities")
            if "review_fields" not in columns:
                connection.execute(text("ALTER TABLE customer_identities ADD COLUMN review_fields TEXT NOT NULL DEFAULT '[]'"))
        if "identity_documents" in tables:
            columns = _columns(connection, "identity_documents")
            for name in ("encrypted_check", "check_nonce"):
                if name not in columns:
                    connection.execute(text(f"ALTER TABLE identity_documents ADD COLUMN {name} BYTEA"))
        if "booking_lines" in tables:
            columns = _columns(connection, "booking_lines")
            if "billable_quantity" not in columns:
                connection.execute(text("ALTER TABLE booking_lines ADD COLUMN billable_quantity INTEGER NOT NULL DEFAULT 0"))
                connection.execute(text("UPDATE booking_lines SET billable_quantity = quantity WHERE billable_quantity = 0"))
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS bookings_customer_request_unique ON bookings (customer_id, client_request_id)"))
        connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS bookings_receipt_number_unique ON bookings (receipt_number)"))
        connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS bookings_human_number_unique ON bookings (human_number)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS equipment_article_idx ON equipment (article_id)"))
    _legacy_backfill()
