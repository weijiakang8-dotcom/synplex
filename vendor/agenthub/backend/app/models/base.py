from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import DateTime, Uuid, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    """返回带时区信息的 UTC 当前时间（aware datetime）。

    不使用 datetime.utcnow()：它返回 naive datetime，且 Python 3.12 起已弃用。
    PostgreSQL 的 TIMESTAMPTZ 需要 aware datetime。
    """
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    """所有模型的声明式基类。"""


class UUIDPrimaryKeyMixin:
    """UUID 主键。"""

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)


class TimestampMixin:
    """created_at / updated_at 时间戳。"""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
        server_default=func.now(),
        nullable=False,
    )
