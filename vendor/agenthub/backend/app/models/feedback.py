"""用户反馈：仅站主可见（收件邮箱 + 管理员 API），普通用户不可查询。"""

from __future__ import annotations

from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Feedback(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "feedback"

    content: Mapped[str] = mapped_column(Text, nullable=False)
    contact: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    ip_address: Mapped[str] = mapped_column(String(64), nullable=False, default="")


__all__ = ["Feedback"]
