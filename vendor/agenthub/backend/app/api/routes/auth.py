from __future__ import annotations

import base64
import hashlib
import json
import random
import re
import secrets
import uuid
from typing import Literal

import redis.asyncio as aioredis
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from app.api.deps import CurrentUserDep
from app.config import settings
from app.core.email import send_email
from app.core.rate_limit import rate_limit
from app.core.refresh_sessions import (
    RefreshSessionError,
    RefreshTokenReplayError,
    issue_refresh_session,
    revoke_family,
    revoke_user_sessions,
    rotate_refresh_session,
)
from app.core.request_utils import get_client_ip
from app.core.security import (
    REFRESH_TOKEN_EXPIRE,
    TokenExpiredError,
    TokenInvalidError,
    create_access_token,
    decode_token_checked,
    hash_password,
    verify_password,
)
from app.database import master_session_factory
from app.models import Organization, User, utcnow

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    email: str
    password: str
    full_name: str = ""
    code: str = ""


class LoginRequest(BaseModel):
    email: str
    password: str
    # 兼容历史客户端：登录不再使用验证码，该字段保留但被忽略。
    code: str = ""


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    role: str
    is_active: bool
    organization_id: uuid.UUID | None


class OrganizationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str
    settings: dict


class AuthResponse(BaseModel):
    user: UserRead
    organization: OrganizationRead
    access_token: str
    refresh_token: str | None = None


class RefreshResponse(BaseModel):
    access_token: str
    refresh_token: str | None = None


class DesktopAuthorizeRequest(LoginRequest):
    code_challenge: str
    code_challenge_method: Literal["S256"] = "S256"


class DesktopAuthorizeResponse(BaseModel):
    authorization_code: str
    expires_in: int


class DesktopExchangeRequest(BaseModel):
    authorization_code: str
    code_verifier: str


class DesktopTokenRequest(BaseModel):
    refresh_token: str


class SendCodeRequest(BaseModel):
    email: str
    mode: Literal["login", "register"] | None = None


class ForgotPasswordRequest(BaseModel):
    email: str


class VerifyResetCodeRequest(BaseModel):
    email: str
    code: str


class ResetPasswordRequest(BaseModel):
    email: str
    code: str
    new_password: str


_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
CODE_TTL = 300
CODE_MAX_ATTEMPTS = 5
RESET_CODE_TTL = 600
RESET_MAX_ATTEMPTS = 5
REFRESH_COOKIE_NAME = "agenthub_refresh"
DESKTOP_AUTH_CODE_TTL = 120
_PKCE_VALUE_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


def _desktop_code_key(code: str) -> str:
    return f"auth:desktop-code:{hashlib.sha256(code.encode()).hexdigest()}"


def _validate_pkce_value(value: str, field: str) -> str:
    if not _PKCE_VALUE_RE.fullmatch(value):
        raise auth_error(422, "INVALID_PKCE", f"{field}格式无效")
    return value


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        REFRESH_COOKIE_NAME,
        token,
        max_age=int(REFRESH_TOKEN_EXPIRE.total_seconds()),
        httponly=True,
        secure=settings.ENVIRONMENT in {"staging", "production"},
        samesite="lax",
        path="/api/auth",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        REFRESH_COOKIE_NAME,
        httponly=True,
        secure=settings.ENVIRONMENT in {"staging", "production"},
        samesite="lax",
        path="/api/auth",
    )


def _validate_cookie_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin not in settings.cors_origin_list:
        raise auth_error(403, "CSRF_ORIGIN_REJECTED", "请求来源无效")


def auth_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


def _validate_email(email: str) -> str:
    normalized = email.strip().lower()
    if not _EMAIL_RE.match(normalized):
        raise auth_error(422, "AUTH_001", "邮箱格式不正确")
    return normalized


def _code_key(email: str, mode: str = "") -> str:
    if mode in {"login", "register"}:
        return f"auth:code:{mode}:{email}"
    return f"auth:code:{email}"


def _code_attempt_key(email: str, mode: str = "") -> str:
    return f"auth:code-attempt:{mode or 'legacy'}:{email}"


async def _verify_code(email: str, code: str, mode: str = "") -> bool:
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        key = _code_key(email, mode)
        stored = await client.get(key)
        if not stored or stored != code:
            attempt_key = _code_attempt_key(email, mode)
            attempts = await client.incr(attempt_key)
            if attempts == 1:
                await client.expire(attempt_key, CODE_TTL)
            if attempts >= CODE_MAX_ATTEMPTS:
                await client.delete(key)
                await client.delete(attempt_key)
            return False
        await client.delete(key)
        await client.delete(_code_attempt_key(email, mode))
        return True
    finally:
        await client.aclose()


async def _send_code(email: str, mode: str = "") -> dict:
    code = f"{random.randint(0, 999999):06d}"
    key = _code_key(email, mode)
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await client.set(key, code, ex=CODE_TTL)
    finally:
        await client.aclose()
    result = await send_email(
        email,
        "AgentHub 登录验证码",
        f"你的验证码是：{code}，5 分钟内有效。",
    )
    if not result.get("ok"):
        cleanup = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        try:
            await cleanup.delete(key)
        finally:
            await cleanup.aclose()
    return result


async def _email_exists(email: str) -> bool:
    async with master_session_factory() as session:
        existing = (
            await session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        return existing is not None


def _reset_code_key(email: str) -> str:
    return f"auth:reset-code:{email}"


def _reset_attempt_key(email: str) -> str:
    return f"auth:reset-attempt:{email}"


async def _save_reset_code(email: str, code: str) -> None:
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await client.set(_reset_code_key(email), code, ex=RESET_CODE_TTL)
        await client.delete(_reset_attempt_key(email))
    finally:
        await client.aclose()


async def _verify_reset_code(email: str, code: str, consume: bool = False) -> bool:
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        stored = await client.get(_reset_code_key(email))
        if stored is None or stored != code:
            attempts = await client.incr(_reset_attempt_key(email))
            if attempts == 1:
                await client.expire(_reset_attempt_key(email), RESET_CODE_TTL)
            if attempts >= RESET_MAX_ATTEMPTS:
                await client.delete(_reset_code_key(email))
                await client.delete(_reset_attempt_key(email))
            return False
        if consume:
            await client.delete(_reset_code_key(email))
            await client.delete(_reset_attempt_key(email))
        return True
    finally:
        await client.aclose()


async def _send_reset_code(email: str) -> dict:
    code = f"{random.randint(0, 999999):06d}"
    await _save_reset_code(email, code)
    result = await send_email(
        email,
        "AgentHub 重置密码验证码",
        f"你的验证码是：{code}，10 分钟内有效。",
    )
    if not result.get("ok"):
        client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        try:
            await client.delete(_reset_code_key(email))
            await client.delete(_reset_attempt_key(email))
        finally:
            await client.aclose()
    return result


async def _set_user_password(email: str, new_password: str) -> bool:
    async with master_session_factory() as session:
        user = (
            await session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None:
            return False
        user.password_hash = hash_password(new_password)
        user.password_changed_at = utcnow()
        await revoke_user_sessions(session, user.id)
        await session.commit()
        return True


@router.post("/send-code")
async def send_code(payload: SendCodeRequest, request: Request) -> dict:
    email = _validate_email(payload.email)
    client_ip = get_client_ip(request)
    mode = payload.mode or ""

    if not await rate_limit(f"send-code:email:{email}", limit=1, window_seconds=60):
        raise auth_error(429, "AUTH_001", "验证码请求过于频繁，请稍后再试")
    if not await rate_limit(f"send-code:ip:{client_ip}", limit=10, window_seconds=60):
        raise auth_error(429, "AUTH_001", "验证码请求过于频繁，请稍后再试")

    if mode == "register":
        if await _email_exists(email):
            raise auth_error(
                409, "EMAIL_ALREADY_EXISTS", "邮箱已被注册，请直接登录或找回密码"
            )
        result = await _send_code(email, mode)
        if not result.get("ok"):
            raise auth_error(502, "AUTH_001", "验证码发送失败，请稍后再试")
    elif mode == "login":
        # 登录已移除邮箱验证码（仅账号+密码）；该分支为兼容旧调用方保留，
        # 不再真实发送验证码，也不暴露邮箱是否注册。
        return {"status": "ok", "note": "login does not require an email code"}
    else:
        # 兼容未携带 mode 的旧调用方。
        result = await _send_code(email, mode)
        if not result.get("ok"):
            raise auth_error(502, "AUTH_001", "验证码发送失败，请稍后再试")
    return {"status": "ok"}


@router.post("/register", response_model=AuthResponse, status_code=201)
async def register(
    payload: RegisterRequest, response: Response, request: Request = None
) -> AuthResponse:
    email = _validate_email(payload.email)
    if len(payload.password) < 8:
        raise auth_error(422, "INVALID_PASSWORD", "密码长度不足，请输入至少8位密码")

    if await _email_exists(email):
        raise auth_error(
            409, "EMAIL_ALREADY_EXISTS", "邮箱已被注册，请直接登录或找回密码"
        )

    if not await _verify_code(email, payload.code, "register"):
        raise auth_error(401, "INVALID_VERIFY_CODE", "验证码错误，请重新输入")

    async with master_session_factory() as session:
        organization = Organization(
            name=payload.full_name or email,
            slug=f"org-{uuid.uuid4().hex[:10]}",
        )
        session.add(organization)
        await session.flush()

        user = User(
            email=email,
            password_hash=hash_password(payload.password),
            full_name=payload.full_name or email,
            organization_id=organization.id,
            role="admin",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        await session.refresh(organization)
        refresh_token = await issue_refresh_session(session, user)
        await session.commit()

        _set_refresh_cookie(response, refresh_token)
        return AuthResponse(
            user=UserRead.model_validate(user),
            organization=OrganizationRead.model_validate(organization),
            access_token=create_access_token(user.id, organization.id),
            refresh_token=None,
        )


@router.post("/login", response_model=AuthResponse)
async def login(
    payload: LoginRequest, response: Response, request: Request = None
) -> AuthResponse:
    email = _validate_email(payload.email)
    # 登录流程已移除邮箱验证码校验，仅保留账号 + 密码。
    if request is not None:
        client_ip = get_client_ip(request)
        if not await rate_limit(f"login:email:{email}", limit=5, window_seconds=300):
            raise auth_error(429, "AUTH_001", "登录尝试过于频繁，请稍后再试")
        if not await rate_limit(f"login:ip:{client_ip}", limit=30, window_seconds=300):
            raise auth_error(429, "AUTH_001", "登录尝试过于频繁，请稍后再试")
    async with master_session_factory() as session:
        user = (
            await session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None or not verify_password(payload.password, user.password_hash):
            raise auth_error(401, "INVALID_PASSWORD", "账号或密码错误，请检查后重试")
        if not user.is_active:
            raise auth_error(403, "AUTH_001", "账号已停用，请联系管理员")

        user.last_login = utcnow()
        await session.commit()

        if user.organization_id is None:
            raise auth_error(500, "AUTH_001", "登录失败，请稍后再试")
        organization = await session.get(Organization, user.organization_id)
        if organization is None:
            raise auth_error(500, "AUTH_001", "登录失败，请稍后再试")

        refresh_token = await issue_refresh_session(session, user)
        await session.commit()
        _set_refresh_cookie(response, refresh_token)
        return AuthResponse(
            user=UserRead.model_validate(user),
            organization=OrganizationRead.model_validate(organization),
            access_token=create_access_token(user.id, user.organization_id),
            refresh_token=None,
        )


@router.post("/desktop/authorize", response_model=DesktopAuthorizeResponse)
async def desktop_authorize(
    payload: DesktopAuthorizeRequest, request: Request
) -> DesktopAuthorizeResponse:
    email = _validate_email(payload.email)
    challenge = _validate_pkce_value(payload.code_challenge, "code_challenge")
    client_ip = get_client_ip(request)
    if not await rate_limit(f"desktop-login:email:{email}", 5, 300):
        raise auth_error(429, "AUTH_001", "登录尝试过于频繁，请稍后再试")
    if not await rate_limit(f"desktop-login:ip:{client_ip}", 30, 300):
        raise auth_error(429, "AUTH_001", "登录尝试过于频繁，请稍后再试")

    async with master_session_factory() as session:
        user = (
            await session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None or not verify_password(payload.password, user.password_hash):
            raise auth_error(401, "INVALID_PASSWORD", "账号或密码错误，请检查后重试")
        if not user.is_active or user.organization_id is None:
            raise auth_error(403, "AUTH_001", "账号不可用，请联系管理员")

    code = secrets.token_urlsafe(32)
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await client.set(
            _desktop_code_key(code),
            json.dumps({"user_id": str(user.id), "challenge": challenge}),
            ex=DESKTOP_AUTH_CODE_TTL,
        )
    finally:
        await client.aclose()
    return DesktopAuthorizeResponse(
        authorization_code=code, expires_in=DESKTOP_AUTH_CODE_TTL
    )


@router.post("/desktop/exchange", response_model=RefreshResponse)
async def desktop_exchange(payload: DesktopExchangeRequest) -> RefreshResponse:
    verifier = _validate_pkce_value(payload.code_verifier, "code_verifier")
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        raw = await client.getdel(_desktop_code_key(payload.authorization_code))
    finally:
        await client.aclose()
    if not raw:
        raise auth_error(401, "INVALID_AUTHORIZATION_CODE", "授权码无效或已过期")
    try:
        grant = json.loads(raw)
        user_id = uuid.UUID(grant["user_id"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        raise auth_error(401, "INVALID_AUTHORIZATION_CODE", "授权码无效或已过期")
    if not secrets.compare_digest(
        _pkce_challenge(verifier), grant.get("challenge", "")
    ):
        raise auth_error(401, "PKCE_VERIFICATION_FAILED", "PKCE验证失败")

    async with master_session_factory() as session:
        user = await session.get(User, user_id)
        if user is None or not user.is_active or user.organization_id is None:
            raise auth_error(401, "INVALID_AUTHORIZATION_CODE", "授权码无效或已过期")
        refresh_token = await issue_refresh_session(session, user)
        await session.commit()
    return RefreshResponse(
        access_token=create_access_token(user.id, user.organization_id),
        refresh_token=refresh_token,
    )


@router.post("/forgot-password")
async def forgot_password(payload: ForgotPasswordRequest, request: Request) -> dict:
    email = _validate_email(payload.email)
    client_ip = get_client_ip(request)

    if not await rate_limit(
        f"forgot-password:email:{email}", limit=1, window_seconds=60
    ):
        raise auth_error(429, "AUTH_001", "请求过于频繁，请稍后再试")
    if not await rate_limit(
        f"forgot-password:ip:{client_ip}", limit=10, window_seconds=60
    ):
        raise auth_error(429, "AUTH_001", "请求过于频繁，请稍后再试")

    # 无论邮箱是否注册都返回相同提示，避免邮箱枚举。
    if await _email_exists(email):
        result = await _send_reset_code(email)
        if not result.get("ok"):
            # 邮件发送失败也保持通用提示，避免暴露内部状态。
            return {"success": True, "message": "如果该邮箱已注册，我们会发送验证码"}

    return {"success": True, "message": "如果该邮箱已注册，我们会发送验证码"}


@router.post("/verify-reset-code")
async def verify_reset_code(payload: VerifyResetCodeRequest) -> dict:
    email = _validate_email(payload.email)
    ok = await _verify_reset_code(email, payload.code, consume=False)
    if ok:
        return {"success": True, "message": "验证码正确"}
    return {"success": False, "message": "验证码错误或已过期"}


@router.post("/reset-password")
async def reset_password(payload: ResetPasswordRequest) -> dict:
    email = _validate_email(payload.email)
    if len(payload.new_password) < 8:
        raise auth_error(422, "INVALID_PASSWORD", "密码长度不足，请输入至少8位密码")

    if not await _verify_reset_code(email, payload.code, consume=True):
        raise auth_error(401, "INVALID_VERIFY_CODE", "验证码错误或已过期")

    updated = await _set_user_password(email, payload.new_password)
    if not updated:
        raise auth_error(400, "PASSWORD_RESET_FAILED", "密码重置失败，请稍后再试")

    return {"success": True, "message": "密码修改成功，请重新登录"}


@router.post("/refresh", response_model=RefreshResponse)
async def refresh(
    request: Request,
    response: Response,
) -> RefreshResponse:
    _validate_cookie_origin(request)
    token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not token:
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "缺少刷新令牌")
    try:
        payload = decode_token_checked(token)
    except TokenExpiredError:
        raise auth_error(401, "REFRESH_TOKEN_EXPIRED", "刷新令牌已过期，请重新登录")
    except TokenInvalidError:
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "刷新令牌无效")

    if payload.get("type") != "refresh":
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "刷新令牌无效")

    try:
        uuid.UUID(str(payload.get("sub")))
    except (ValueError, TypeError):
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "刷新令牌无效")

    async with master_session_factory() as session:
        try:
            replacement, user = await rotate_refresh_session(session, token)
        except RefreshTokenReplayError:
            raise auth_error(
                401,
                "REFRESH_TOKEN_REPLAYED",
                "检测到刷新令牌重放，当前会话已撤销",
            )
        except RefreshSessionError:
            raise auth_error(401, "INVALID_REFRESH_TOKEN", "刷新令牌无效或已撤销")
        await session.commit()
        _set_refresh_cookie(response, replacement)
        return RefreshResponse(
            access_token=create_access_token(user.id, user.organization_id),
            refresh_token=None,
        )


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict:
    _validate_cookie_origin(request)
    token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not token:
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "缺少刷新令牌")
    try:
        payload = decode_token_checked(token)
        family_id = uuid.UUID(str(payload.get("family")))
    except (TokenExpiredError, TokenInvalidError, TypeError, ValueError):
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "刷新令牌无效")
    if payload.get("type") != "refresh":
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "刷新令牌无效")
    async with master_session_factory() as session:
        await revoke_family(session, family_id)
        await session.commit()
    _clear_refresh_cookie(response)
    return {"status": "ok"}


@router.post("/desktop/refresh", response_model=RefreshResponse)
async def desktop_refresh(payload: DesktopTokenRequest) -> RefreshResponse:
    try:
        replacement, user = await _rotate_desktop_token(payload.refresh_token)
    except RefreshTokenReplayError:
        raise auth_error(
            401,
            "REFRESH_TOKEN_REPLAYED",
            "检测到刷新令牌重放，当前会话已撤销",
        )
    except (RefreshSessionError, TokenExpiredError, TokenInvalidError):
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "刷新令牌无效或已撤销")
    return RefreshResponse(
        access_token=create_access_token(user.id, user.organization_id),
        refresh_token=replacement,
    )


async def _rotate_desktop_token(token: str):
    payload = decode_token_checked(token)
    if payload.get("type") != "refresh":
        raise TokenInvalidError("not a refresh token")
    async with master_session_factory() as session:
        replacement, user = await rotate_refresh_session(session, token)
        await session.commit()
        return replacement, user


@router.post("/desktop/logout")
async def desktop_logout(payload: DesktopTokenRequest) -> dict:
    try:
        token_payload = decode_token_checked(payload.refresh_token)
        family_id = uuid.UUID(str(token_payload.get("family")))
    except (TokenExpiredError, TokenInvalidError, TypeError, ValueError):
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "刷新令牌无效")
    if token_payload.get("type") != "refresh":
        raise auth_error(401, "INVALID_REFRESH_TOKEN", "刷新令牌无效")
    async with master_session_factory() as session:
        await revoke_family(session, family_id)
        await session.commit()
    return {"status": "ok"}


@router.get("/me", response_model=UserRead)
async def me(user: CurrentUserDep) -> UserRead:
    return UserRead.model_validate(user)
