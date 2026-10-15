from __future__ import annotations

import asyncio
import ipaddress
import socket
import uuid
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.core.security import encrypt_secret
from app.models import UserApiKey

router = APIRouter(prefix="/user-api-keys", tags=["user-api-keys"])


class UserApiKeyCreate(BaseModel):
    provider: str = Field(..., min_length=1, max_length=40)
    model: str = Field(..., min_length=1, max_length=100)
    base_url: str = Field(..., min_length=1, max_length=255)
    api_key: str = Field(..., min_length=1)
    api_mode: str = Field(
        default="chat_completions", pattern="^(chat_completions|responses)$"
    )


class UserApiKeyUpdate(BaseModel):
    is_active: bool


class UserApiKeyRotate(BaseModel):
    api_key: str = Field(..., min_length=1)


class ModelDiscoveryRequest(BaseModel):
    base_url: str = Field(..., min_length=1, max_length=255)
    api_key: str = Field(..., min_length=1)


class ModelConnectionTestRequest(ModelDiscoveryRequest):
    model: str = Field(..., min_length=1, max_length=100)
    api_mode: str = Field(default="auto", pattern="^(auto|chat_completions|responses)$")


def _normalize_base_url(value: str) -> str:
    raw = value.strip().rstrip("/")
    try:
        parsed = urlsplit(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Base URL 格式无效") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(status_code=422, detail="Base URL 必须是 http/https 地址")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HTTPException(
            status_code=422, detail="Base URL 不能包含账号、查询参数或片段"
        )

    path = parsed.path.rstrip("/")
    for suffix in ("/chat/completions", "/responses", "/models"):
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    return urlunsplit((parsed.scheme, parsed.netloc, path.rstrip("/"), "", ""))


def _model_endpoint_candidates(base_url: str) -> list[str]:
    parsed = urlsplit(base_url)
    path = parsed.path.rstrip("/")
    candidates = [f"{base_url}/models"]
    if not path.endswith("/v1"):
        candidates.append(f"{base_url}/v1/models")
    return list(dict.fromkeys(candidates))


_NON_CHAT_MODEL_MARKERS = (
    "audio",
    "babbage",
    "dall-e",
    "embedding",
    "image",
    "moderation",
    "realtime",
    "search-preview",
    "transcribe",
    "tts",
    "whisper",
)


def _chat_model_ids(models: list[str]) -> list[str]:
    return [
        model
        for model in models
        if not any(marker in model.lower() for marker in _NON_CHAT_MODEL_MARKERS)
    ]


def _is_openai_official(base_url: str) -> bool:
    host = (urlsplit(base_url).hostname or "").lower()
    return host == "api.openai.com" or host.endswith(".api.openai.com")


def _stored_provider(provider: str, api_mode: str) -> str:
    clean = provider.removesuffix(":responses")
    return f"{clean}:responses" if api_mode == "responses" else clean


def _provider_api_mode(provider: str, base_url: str) -> str:
    if provider.endswith(":responses") or _is_openai_official(base_url):
        return "responses"
    return "chat_completions"


def _is_public_ip(value: str) -> bool:
    address = ipaddress.ip_address(value.split("%", 1)[0])
    return bool(address.is_global)


async def _validate_public_url(url: str) -> None:
    parsed = urlsplit(url)
    host = parsed.hostname
    if parsed.scheme not in {"http", "https"} or not host:
        raise HTTPException(status_code=422, detail="模型服务地址无效")
    try:
        address = ipaddress.ip_address(host)
        addresses = [str(address)]
    except ValueError:
        try:
            records = await asyncio.to_thread(
                socket.getaddrinfo,
                host,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except socket.gaierror as exc:
            raise HTTPException(
                status_code=422, detail="模型服务域名无法解析，请检查 Base URL"
            ) from exc
        addresses = list({record[4][0] for record in records})
    if not addresses or any(not _is_public_ip(item) for item in addresses):
        raise HTTPException(status_code=422, detail="Base URL 不允许访问本机或私有网络")


async def _request_public(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    **kwargs,
) -> httpx.Response:
    current_url = url
    for _ in range(4):
        await _validate_public_url(current_url)
        response = await client.request(method, current_url, **kwargs)
        if not response.is_redirect:
            return response
        location = response.headers.get("location")
        if not location:
            return response
        redirect_url = str(response.url.join(location))
        current_origin = urlsplit(current_url)
        redirect_origin = urlsplit(redirect_url)
        if (
            current_origin.scheme,
            current_origin.hostname,
            current_origin.port,
        ) != (
            redirect_origin.scheme,
            redirect_origin.hostname,
            redirect_origin.port,
        ):
            raise HTTPException(
                status_code=422,
                detail="模型服务不能重定向到其他域名，请直接填写最终 API 地址",
            )
        current_url = redirect_url
    raise HTTPException(status_code=422, detail="模型服务重定向次数过多")


def _upstream_error(response: httpx.Response, *, model: str | None = None) -> str:
    try:
        payload = response.json()
        message = str((payload.get("error") or {}).get("message") or "")
    except Exception:  # noqa: BLE001
        message = ""
    if model:
        return f"模型 {model} 暂不可用（上游 HTTP {response.status_code}）" + (
            f"：{message}" if message else "，请换一个模型重试"
        )
    return f"模型服务连接失败（HTTP {response.status_code}）" + (
        f"：{message}" if message else ""
    )


def _connection_error(exc: httpx.HTTPError, *, action: str) -> str:
    if isinstance(exc, httpx.TimeoutException):
        reason = "连接超时"
    elif isinstance(exc, httpx.ConnectError):
        reason = "DNS、TLS 或网络连接失败"
    else:
        reason = type(exc).__name__
    return f"{action}失败：{reason}。请检查服务地址、/v1 路径和服务器网络限制"


def _should_try_responses(response: httpx.Response) -> bool:
    if response.status_code in {404, 405}:
        return True
    if response.status_code not in {400, 422}:
        return False
    try:
        message = str((response.json().get("error") or {}).get("message") or "").lower()
    except Exception:  # noqa: BLE001
        return False
    return any(
        marker in message
        for marker in ("responses", "chat completions", "not supported", "unsupported")
    )


async def _test_with_mode(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    api_key: str,
    model: str,
    api_mode: str,
) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if api_mode == "responses":
        return await _request_public(
            client,
            "POST",
            f"{base_url}/responses",
            headers=headers,
            json={
                "model": model,
                "input": "Reply with exactly OK",
                "max_output_tokens": 64,
            },
        )
    return await _request_public(
        client,
        "POST",
        f"{base_url}/chat/completions",
        headers=headers,
        json={
            "model": model,
            "messages": [{"role": "user", "content": "只回复 OK"}],
            "stream": False,
        },
    )


def _response_preview(response: httpx.Response, api_mode: str) -> str:
    data = response.json()
    if api_mode == "chat_completions":
        return str(
            (((data.get("choices") or [{}])[0].get("message") or {}).get("content"))
            or ""
        )[:120]
    if data.get("output_text"):
        return str(data["output_text"])[:120]
    for output in data.get("output") or []:
        for content in output.get("content") or []:
            if content.get("text"):
                return str(content["text"])[:120]
    return ""


def _serialize(key: UserApiKey) -> dict:
    return {
        "id": str(key.id),
        "provider": key.provider.removesuffix(":responses"),
        "api_mode": _provider_api_mode(key.provider, key.base_url),
        "model": key.model,
        "base_url": key.base_url,
        "api_key_masked": f"****{key.api_key_hint}",
        "is_active": key.is_active,
        "created_at": key.created_at,
    }


@router.post("/discover-models")
async def discover_models(
    payload: ModelDiscoveryRequest,
    _user: CurrentUserDep,
) -> dict:
    """读取 OpenAI 兼容服务的模型列表，并返回规范化 API root。"""
    submitted_url = _normalize_base_url(payload.base_url)
    last_response: httpx.Response | None = None
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            for endpoint in _model_endpoint_candidates(submitted_url):
                response = await _request_public(
                    client,
                    "GET",
                    endpoint,
                    headers={"Authorization": f"Bearer {payload.api_key}"},
                )
                last_response = response
                if response.is_success:
                    base_url = endpoint.removesuffix("/models")
                    break
                if response.status_code not in {404, 405}:
                    raise HTTPException(
                        status_code=422, detail=_upstream_error(response)
                    )
            else:
                assert last_response is not None
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "未找到 OpenAI 兼容的 /models 接口；请填写供应商 API 根地址，"
                        "例如 https://example.com/v1"
                    ),
                )
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=422,
            detail=_connection_error(exc, action="模型列表检测"),
        ) from exc

    try:
        data = response.json()
        models = sorted(
            {
                str(item.get("id"))
                for item in data.get("data", [])
                if isinstance(item, dict) and item.get("id")
            }
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail="模型列表响应格式无效") from exc
    if not models:
        raise HTTPException(status_code=422, detail="服务未返回任何模型")
    chat_models = _chat_model_ids(models)
    if not chat_models:
        raise HTTPException(status_code=422, detail="服务未返回可用于 Agent 对话的模型")
    return {
        "base_url": base_url,
        "models": models,
        "chat_models": chat_models,
        "api_mode": (
            "responses" if _is_openai_official(base_url) else "chat_completions"
        ),
    }


@router.post("/test-connection")
async def test_connection(
    payload: ModelConnectionTestRequest,
    _user: CurrentUserDep,
) -> dict:
    """用用户选定的模型发一次最小聊天请求。"""
    base_url = _normalize_base_url(payload.base_url)
    api_mode = payload.api_mode
    if api_mode == "auto":
        api_mode = "responses" if _is_openai_official(base_url) else "chat_completions"
    try:
        async with httpx.AsyncClient(timeout=90, follow_redirects=False) as client:
            response = await _test_with_mode(
                client,
                base_url=base_url,
                api_key=payload.api_key,
                model=payload.model,
                api_mode=api_mode,
            )
            if (
                api_mode == "chat_completions"
                and not response.is_success
                and _should_try_responses(response)
            ):
                response = await _test_with_mode(
                    client,
                    base_url=base_url,
                    api_key=payload.api_key,
                    model=payload.model,
                    api_mode="responses",
                )
                api_mode = "responses"
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=422,
            detail=_connection_error(exc, action="模型连接"),
        ) from exc
    if not response.is_success:
        raise HTTPException(
            status_code=422,
            detail=_upstream_error(response, model=payload.model),
        )
    try:
        preview = _response_preview(response, api_mode)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="模型响应格式无效") from exc
    return {
        "ok": True,
        "model": payload.model,
        "preview": preview,
        "api_mode": api_mode,
    }


@router.get("")
async def list_keys(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    result = await session.execute(
        select(UserApiKey)
        .where(UserApiKey.user_id == user.id)
        .order_by(UserApiKey.created_at)
    )
    return [_serialize(key) for key in result.scalars().all()]


@router.post("", status_code=201)
async def create_key(
    payload: UserApiKeyCreate, session: SessionDep, user: CurrentUserDep
) -> dict:
    base_url = _normalize_base_url(payload.base_url)
    await _validate_public_url(base_url)
    key = UserApiKey(
        user_id=user.id,
        provider=_stored_provider(payload.provider, payload.api_mode),
        model=payload.model,
        base_url=base_url,
        api_key_encrypted=encrypt_secret(payload.api_key),
        api_key_hint=payload.api_key[-4:],
        is_active=True,
    )
    session.add(key)
    await session.commit()
    await session.refresh(key)
    return _serialize(key)


@router.put("/{key_id}")
async def update_key(
    key_id: uuid.UUID,
    payload: UserApiKeyUpdate,
    session: SessionDep,
    user: CurrentUserDep,
) -> dict:
    key = await session.get(UserApiKey, key_id)
    if key is None or key.user_id != user.id:
        raise HTTPException(status_code=404, detail="API key not found")
    key.is_active = payload.is_active
    await session.commit()
    await session.refresh(key)
    return _serialize(key)


@router.post("/{key_id}/rotate")
async def rotate_key(
    key_id: uuid.UUID,
    payload: UserApiKeyRotate,
    session: SessionDep,
    user: CurrentUserDep,
) -> dict:
    """轮换密钥：立即失效旧 secret，替换为新的加密 secret（保持同一行）。"""
    key = await session.get(UserApiKey, key_id)
    if key is None or key.user_id != user.id:
        raise HTTPException(status_code=404, detail="API key not found")
    key.api_key_encrypted = encrypt_secret(payload.api_key)
    key.api_key_hint = payload.api_key[-4:]
    key.is_active = True
    await session.commit()
    await session.refresh(key)
    return _serialize(key)


@router.delete("/{key_id}", status_code=204)
async def delete_key(
    key_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> None:
    key = await session.get(UserApiKey, key_id)
    if key is None or key.user_id != user.id:
        raise HTTPException(status_code=404, detail="API key not found")
    await session.delete(key)
    await session.commit()
