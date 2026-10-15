import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from app.config import settings
from app.models import Base

_POOL_SIZE = (os.cpu_count() or 4) * 2 + 1


def _engine(url: str) -> AsyncEngine:
    return create_async_engine(
        url,
        echo=settings.DEBUG,
        poolclass=NullPool,
        pool_recycle=3600,
        pool_pre_ping=True,
    )


master_engine = _engine(settings.DATABASE_URL)
replica_engine = _engine(settings.REPLICA_DATABASE_URL or settings.DATABASE_URL)

# 兼容旧代码引用
engine = master_engine

master_session_factory = async_sessionmaker(
    master_engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
)
replica_session_factory = async_sessionmaker(
    replica_engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
)
async_session_factory = master_session_factory


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI 依赖：提供异步会话，请求结束后自动关闭。"""
    async with async_session_factory() as session:
        yield session


async def get_read_db() -> AsyncGenerator[AsyncSession, None]:
    """只读副本会话，供 GET 列表/详情接口使用。"""
    async with replica_session_factory() as session:
        yield session


async def init_db() -> None:
    """创建所有表。仅用于测试/开发环境，生产环境使用 Alembic 迁移。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
