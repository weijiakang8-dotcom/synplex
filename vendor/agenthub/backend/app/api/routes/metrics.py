import logging

from fastapi import APIRouter, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app.core.production_alerts import collect_production_metrics
from app.core.production_metrics import update_production_gauges

logger = logging.getLogger(__name__)

router = APIRouter(tags=["metrics"])


@router.get("/metrics")
async def metrics_endpoint() -> Response:
    try:
        update_production_gauges(await collect_production_metrics())
    except Exception:
        logger.warning("Failed to refresh production gauges", exc_info=True)
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
