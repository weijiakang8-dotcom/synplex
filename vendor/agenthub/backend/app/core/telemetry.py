from __future__ import annotations

import logging
import os

from openinference.instrumentation.langchain import LangChainInstrumentor
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
from opentelemetry.instrumentation.celery import CeleryInstrumentor
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.instrumentation.system_metrics import (
    SystemMetricsInstrumentor,
    _build_default_config,
)
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import (
    DEPLOYMENT_ENVIRONMENT,
    SERVICE_NAME,
    SERVICE_VERSION,
    Resource,
)
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

logger = logging.getLogger(__name__)

resource = Resource.create(
    {
        SERVICE_NAME: os.getenv("OTEL_SERVICE_NAME", "agenthub-backend"),
        SERVICE_VERSION: "1.0.0",
        DEPLOYMENT_ENVIRONMENT: os.getenv("ENVIRONMENT", "development"),
    }
)

_initialized = False


def _system_metrics_config() -> dict:
    config = _build_default_config()
    # macOS 上 psutil.swap_memory() 可能抛 OSError，禁用 swap 指标
    config.pop("system.swap.usage", None)
    config.pop("system.swap.utilization", None)
    return config


def setup_telemetry() -> None:
    """初始化 OpenTelemetry，配置 Traces 和 Metrics 导出到 OTLP Collector。"""
    global _initialized
    if _initialized:
        return
    _initialized = True

    from app.config import settings as _settings

    disabled = bool(_settings.OTEL_SDK_DISABLED) or os.getenv(
        "OTEL_SDK_DISABLED", ""
    ).lower() in {"1", "true", "yes"}
    if disabled:
        logger.info("OpenTelemetry disabled by OTEL_SDK_DISABLED=true")
        return

    otlp_endpoint = os.getenv(
        "OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318/v1/traces"
    )
    metrics_endpoint = os.getenv(
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "http://localhost:4318/v1/metrics"
    )

    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=otlp_endpoint))
    )
    trace.set_tracer_provider(tracer_provider)

    metric_reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(endpoint=metrics_endpoint), export_interval_millis=10000
    )
    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)

    FastAPIInstrumentor().instrument()
    CeleryInstrumentor().instrument()
    AsyncPGInstrumentor().instrument()
    HTTPXClientInstrumentor().instrument()
    RedisInstrumentor().instrument()
    LangChainInstrumentor().instrument()
    SystemMetricsInstrumentor(config=_system_metrics_config()).instrument()

    logger.info(
        "OpenTelemetry initialized -> traces: %s, metrics: %s",
        otlp_endpoint,
        metrics_endpoint,
    )


def get_tracer(name: str = "agenthub"):
    return trace.get_tracer(name)


def get_meter(name: str = "agenthub"):
    return metrics.get_meter(name)
