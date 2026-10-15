from __future__ import annotations

import uuid

from sqlalchemy import JSON, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class SynplexTask(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Durable tenant/user binding; external runner credentials never enter payloads."""

    __tablename__ = "synplex_tasks"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    connection_id: Mapped[str] = mapped_column(String(100))
    external_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
