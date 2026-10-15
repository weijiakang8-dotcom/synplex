import logging
import uuid
from contextlib import asynccontextmanager

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.api import api_router
from app.api.routes.metrics import router as metrics_router
from app.api.websocket import router as websocket_router
from app.config import settings
from app.core.audit import build_audit_details, classify_audit_event
from app.core.rate_limit import rate_limit
from app.core.request_utils import get_client_ip
from app.core.security import decode_token
from app.core.telemetry import setup_telemetry
from app.database import async_session_factory, init_db, master_engine
from app.engine.tasks import celery_app  # noqa: F401  # 加载 Celery 配置
from app.models import AuditLog

logger = logging.getLogger(__name__)

# 必须在创建 FastAPI 实例前调用，FastAPIInstrumentor 会替换 fastapi.FastAPI 类
setup_telemetry()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 开发环境快速建表；生产环境只允许 Alembic 管理 schema。
    if settings.ENVIRONMENT != "production":
        await init_db()
    yield


app = FastAPI(title="AgentHub API", version="0.1.0", lifespan=lifespan)
FastAPIInstrumentor().instrument_app(app)


@app.exception_handler(DBAPIError)
@app.exception_handler(ConnectionRefusedError)
@app.exception_handler(ConnectionResetError)
@app.exception_handler(TimeoutError)
async def database_unavailable_handler(request: Request, exc: Exception):
    """数据库不可用时返回明确的 503，而不是裸 500。"""
    logger.warning(
        "Database unavailable for %s: %s",
        request.url.path,
        exc.__class__.__name__,
    )
    return JSONResponse(status_code=503, content={"detail": "Database unavailable"})


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy", "geolocation=(), microphone=(), camera=()"
    )
    return response


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    path = request.url.path
    if path in {"/health", "/metrics", "/docs", "/openapi.json"} or path.startswith(
        ("/docs", "/openapi.json")
    ):
        return await call_next(request)

    client_ip = get_client_ip(request)
    if not await rate_limit(f"ip:{client_ip}", limit=300, window_seconds=60):
        return JSONResponse(status_code=429, content={"detail": "Too Many Requests"})
    return await call_next(request)


@app.middleware("http")
async def audit_middleware(request: Request, call_next):
    body: bytes | None = None
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        content_type = request.headers.get("content-type", "")
        if "application/json" in content_type:
            content_length = request.headers.get("content-length")
            if content_length and int(content_length) <= 50_000:
                body = await request.body()

    response = await call_next(request)
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        user_id = None
        organization_id = None
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            payload = decode_token(auth.removeprefix("Bearer "))
            if payload and payload.get("sub"):
                try:
                    user_id = uuid.UUID(str(payload["sub"]))
                except (ValueError, TypeError):
                    user_id = None
                org = payload.get("org")
                if org:
                    try:
                        organization_id = uuid.UUID(str(org))
                    except (ValueError, TypeError):
                        organization_id = None

        try:
            action, resource_type, resource_id = classify_audit_event(
                request.method, request.url.path
            )
            async with async_session_factory() as session:
                session.add(
                    AuditLog(
                        user_id=user_id,
                        organization_id=organization_id,
                        action=action,
                        resource_type=resource_type,
                        resource_id=resource_id,
                        ip_address=get_client_ip(request),
                        method=request.method,
                        path=request.url.path,
                        status_code=response.status_code,
                        details=build_audit_details(request, body),
                    )
                )
                await session.commit()
        except Exception:
            logger.exception("Failed to persist audit log for %s", request.url.path)

    return response


app.include_router(api_router)
app.include_router(metrics_router)
app.include_router(websocket_router)


@app.get("/")
async def root():
    return {
        "service": "AgentHub API",
        "docs": "/docs",
        "health": "/health",
        "status": "running",
    }


@app.get("/health/live")
async def liveness():
    return {"status": "ok", "build_sha": settings.BUILD_SHA}


@app.get("/health/ready")
@app.get("/health")
async def health():
    db_ok = redis_ok = llm_ok = False
    try:
        async with master_engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        logger.warning("Database health check failed", exc_info=True)

    try:
        client = aioredis.from_url(settings.REDIS_URL)
        await client.ping()
        await client.aclose()
        redis_ok = True
    except Exception:
        logger.warning("Redis health check failed", exc_info=True)

    try:
        async with httpx.AsyncClient(timeout=3) as client:
            await client.get(settings.LLM_BASE_URL)
        llm_ok = True
    except Exception:
        logger.warning("LLM health check failed", exc_info=True)

    healthy = db_ok and redis_ok
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={
            "status": "ok" if healthy else "degraded",
            "build_sha": settings.BUILD_SHA,
            "database": db_ok,
            "redis": redis_ok,
            "llm": llm_ok,
        },
    )
