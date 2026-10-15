from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update

from app.core.security import create_refresh_token, decode_token_checked
from app.models import RefreshSession, User, utcnow


class RefreshSessionError(ValueError):
    pass


class RefreshTokenReplayError(RefreshSessionError):
    pass


def hash_jti(jti: str) -> str:
    return hashlib.sha256(jti.encode("utf-8")).hexdigest()


def _expires_at(payload: dict) -> datetime:
    return datetime.fromtimestamp(float(payload["exp"]), tz=timezone.utc)


async def issue_refresh_session(session, user: User) -> str:
    token = create_refresh_token(user.id, user.organization_id)
    payload = decode_token_checked(token)
    session.add(
        RefreshSession(
            user_id=user.id,
            family_id=uuid.UUID(payload["family"]),
            jti_hash=hash_jti(payload["jti"]),
            expires_at=_expires_at(payload),
        )
    )
    await session.flush()
    return token


async def revoke_family(session, family_id: uuid.UUID) -> None:
    await session.execute(
        update(RefreshSession)
        .where(
            RefreshSession.family_id == family_id,
            RefreshSession.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow())
    )


async def revoke_user_sessions(session, user_id: uuid.UUID) -> None:
    await session.execute(
        update(RefreshSession)
        .where(
            RefreshSession.user_id == user_id,
            RefreshSession.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow())
    )


async def rotate_refresh_session(session, token: str) -> tuple[str, User]:
    payload = decode_token_checked(token)
    if (
        payload.get("type") != "refresh"
        or not payload.get("jti")
        or not payload.get("family")
    ):
        raise RefreshSessionError("invalid refresh token")

    try:
        user_id = uuid.UUID(str(payload["sub"]))
        family_id = uuid.UUID(str(payload["family"]))
    except (TypeError, ValueError) as exc:
        raise RefreshSessionError("invalid refresh token") from exc

    row = (
        await session.execute(
            select(RefreshSession)
            .where(RefreshSession.jti_hash == hash_jti(payload["jti"]))
            .with_for_update()
        )
    ).scalar_one_or_none()
    if row is None or row.user_id != user_id or row.family_id != family_id:
        raise RefreshSessionError("invalid refresh token")
    if row.used_at is not None:
        await revoke_family(session, family_id)
        await session.commit()
        raise RefreshTokenReplayError("refresh token replay detected")
    if row.revoked_at is not None or row.expires_at <= utcnow():
        raise RefreshSessionError("refresh token revoked or expired")

    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        await revoke_family(session, family_id)
        await session.commit()
        raise RefreshSessionError("user unavailable")
    issued_at = datetime.fromtimestamp(float(payload["iat"]), tz=timezone.utc)
    if user.password_changed_at is not None and issued_at < user.password_changed_at:
        await revoke_family(session, family_id)
        await session.commit()
        raise RefreshSessionError("refresh token predates password change")

    replacement = create_refresh_token(
        user.id,
        user.organization_id,
        family_id=family_id,
    )
    replacement_payload = decode_token_checked(replacement)
    replacement_hash = hash_jti(replacement_payload["jti"])
    row.used_at = utcnow()
    row.replaced_by_hash = replacement_hash
    session.add(
        RefreshSession(
            user_id=user.id,
            family_id=family_id,
            jti_hash=replacement_hash,
            expires_at=_expires_at(replacement_payload),
        )
    )
    await session.flush()
    return replacement, user
