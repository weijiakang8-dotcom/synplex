from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# 项目根目录（backend/ 的上一级），用于定位根目录下的 .env
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_NAME: str = "AgentHub"
    DEBUG: bool = False
    ENVIRONMENT: str = "development"
    TRUSTED_PROXY_IPS: str = ""
    BUILD_SHA: str = "development"

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5433/agenthub"
    REDIS_URL: str = "redis://localhost:6379/0"
    OPENAI_API_KEY: str = ""
    ADMIN_API_KEY: str = ""
    JWT_SECRET_KEY: str = "change-me-in-production"
    CORS_ORIGINS: str = (
        "http://localhost:5173,http://localhost:8080,"
        "tauri://localhost,http://tauri.localhost,https://tauri.localhost"
    )
    REPLICA_DATABASE_URL: str = ""
    LLM_BASE_URL: str = "https://api.deepseek.com/v1"
    LLM_MODEL: str = "deepseek-flash"
    CONTEXT_UNKNOWN_WINDOW: int = 16384
    CONTEXT_SUMMARY_MAX_CALLS: int = 4
    # 第二供应商（OpenAI）跨厂商回退：默认关闭；密钥未配置/未充值时自动跳过，
    # 绝不阻塞主流程。充值后填入密钥并开启开关即可启用。
    OPENAI_FALLBACK_ENABLED: bool = False
    OPENAI_FALLBACK_API_KEY: str = ""
    OPENAI_FALLBACK_BASE_URL: str = "https://api.openai.com/v1"
    OPENAI_FALLBACK_MODEL: str = "gpt-4o-mini"
    OTEL_SDK_DISABLED: bool = False
    TAVILY_API_KEY: str = ""
    # 租户预算（0 = 不限制）：月度 token / 月度成本（CNY）/ 并发模型调用数
    TENANT_MONTHLY_TOKEN_BUDGET: int = 0
    TENANT_MONTHLY_COST_BUDGET_CNY: float = 0.0
    TENANT_MAX_CONCURRENT_LLM_CALLS: int = 0
    # 记忆默认 TTL（天）；0 = 永不过期
    MEMORY_DEFAULT_TTL_DAYS: int = 0
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""
    RESEND_API_KEY: str = ""
    RESEND_FROM: str = ""
    ALERT_WEBHOOK_URL: str = ""
    FEISHU_WEBHOOK_URL: str = ""
    SHADOW_MODE: bool = False
    REAL_EFFECT_MODE: bool = False
    GENERAL_EXECUTOR_ENABLED: bool = True
    # Server-controlled per-tenant sidecar registry; never accepted from a browser.
    SYNPLEX_CONNECTIONS_FILE: str = ""
    SYNPLEX_EXTENSION_ROOT: str = ""
    MCP_CONNECTORS_JSON: str = "[]"
    PDF_CJK_FONT_PATH: str = ""
    ARTIFACT_ROOT: str = str(PROJECT_ROOT / "data" / "artifacts")
    RUNTIME_MODE: str = "legacy"
    RECONCILE_PENDING_EXECUTION_MINUTES: int = 30
    RECONCILE_TOOLCALL_MINUTES: int = 30
    RECONCILE_APPROVAL_MINUTES: int = 1440
    CHECKPOINT_RETENTION_DAYS: int = 7
    ALERT_DLQ_MIN: int = 5
    ALERT_PENDING_MIN: int = 5
    ALERT_LATENCY_P95_MS: int = 5000
    ALERT_FALLBACK_RATE: float = 0.5
    ALERT_COOLDOWN_MINUTES: int = 15
    EMBEDDING_PROVIDER: str = "ollama"
    EMBEDDING_MODEL: str = "nomic-embed-text:latest"
    EMBEDDING_BASE_URL: str = "http://127.0.0.1:11434"
    EMBEDDING_DIMENSION: int = 768
    BENCHMARK_REPORT_PATH: str = (
        "backend/tests/benchmark/phase1/reports/evaluation_report.json"
    )
    # 可选的用户反馈通知邮箱；未配置时反馈仍会落库。
    FEEDBACK_NOTIFY_EMAIL: str = ""

    @field_validator("RUNTIME_MODE")
    @classmethod
    def _validate_runtime_mode(cls, value: str) -> str:
        if value not in {"legacy", "kernel"}:
            raise ValueError("RUNTIME_MODE must be 'legacy' or 'kernel'")
        return value

    @field_validator("CONTEXT_UNKNOWN_WINDOW")
    @classmethod
    def _validate_context_window(cls, value: int) -> int:
        if value < 8192:
            raise ValueError("CONTEXT_UNKNOWN_WINDOW must be >= 8192")
        return value

    @field_validator("CONTEXT_SUMMARY_MAX_CALLS")
    @classmethod
    def _validate_summary_calls(cls, value: int) -> int:
        if not 1 <= value <= 8:
            raise ValueError("CONTEXT_SUMMARY_MAX_CALLS must be between 1 and 8")
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [
            origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()
        ]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()


if settings.ENVIRONMENT == "production" and (
    settings.JWT_SECRET_KEY in {"", "change-me-in-production"}
    or len(settings.JWT_SECRET_KEY) < 32
):
    raise RuntimeError(
        "JWT_SECRET_KEY must be set to a strong secret (>= 32 chars) in production"
    )
