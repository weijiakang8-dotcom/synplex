"""用户反馈 API：提交（公开）+ 站主查看（仅 ADMIN_API_KEY）。

- 提交：任何人都可反馈，落库 + 即时邮件通知站主邮箱（FEEDBACK_NOTIFY_EMAIL）；
- 可见性：反馈只有站主可见（邮件 + 管理员 API），普通用户/租户无法查询；
- 防滥用：全局 IP 限流中间件（300/分钟）已覆盖本路由。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import SessionDep, get_admin_api_key_user
from app.config import settings
from app.core.email import send_email
from app.core.request_utils import get_client_ip
from app.database import async_session_factory
from app.models import Feedback, User

router = APIRouter(prefix="/feedback", tags=["feedback"])
logger = logging.getLogger(__name__)

AdminUserDep = Annotated[User, Depends(get_admin_api_key_user)]


class FeedbackCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)
    contact: str = Field(default="", max_length=200)


@router.post("", status_code=201)
async def submit_feedback(payload: FeedbackCreate, request: Request) -> dict:
    """提交反馈：落库（站主可见）+ 邮件通知站主，两者均不影响返回。"""
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="content must not be empty")
    contact = payload.contact.strip()
    ip_address = get_client_ip(request)

    async with async_session_factory() as session:
        session.add(Feedback(content=content, contact=contact, ip_address=ip_address))
        await session.commit()

    email_result = {"ok": False, "error": "feedback email is not configured"}
    if settings.FEEDBACK_NOTIFY_EMAIL:
        try:
            email_result = await send_email(
                to=settings.FEEDBACK_NOTIFY_EMAIL,
                subject="【AgentHub 用户反馈】新的反馈来啦",
                text=(
                    f"收到一条新的用户反馈：\n\n"
                    f"{content}\n\n"
                    f"联系方式：{contact or '（未填写）'}\n"
                    f"IP：{ip_address}\n"
                    f"时间：{datetime.now(timezone.utc).isoformat()}"
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("feedback email failed: %s", exc)
            email_result = {"ok": False, "error": str(exc)}
    logger.info(
        "feedback submitted (email=%s): %s",
        email_result.get("ok"),
        content[:80],
    )
    return {"ok": True, "notified": bool(email_result.get("ok"))}


@router.get("")
async def list_feedback(
    session: SessionDep,
    _admin: AdminUserDep,
    limit: int = 50,
) -> list[dict]:
    """仅站主（ADMIN_API_KEY）可查看全部反馈。"""
    result = await session.execute(
        select(Feedback).order_by(Feedback.created_at.desc()).limit(min(limit, 200))
    )
    return [
        {
            "id": str(row.id),
            "content": row.content,
            "contact": row.contact,
            "ip_address": row.ip_address,
            "created_at": row.created_at.isoformat(),
        }
        for row in result.scalars().all()
    ]
