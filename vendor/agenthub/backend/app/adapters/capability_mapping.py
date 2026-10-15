from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict


class LegacyCapabilityMapping(BaseModel):
    model_config = ConfigDict(frozen=True)

    tool_name: str
    classification: str
    capabilities: list[str]
    evidence_level: str
    produces_command: bool = False
    produces_receipt: bool = False
    produces_observation: bool = False


LEGACY_CAPABILITY_MAP: dict[str, LegacyCapabilityMapping] = {
    "search_web": LegacyCapabilityMapping(
        tool_name="search_web",
        classification="PURE",
        capabilities=["retrieve", "extract"],
        evidence_level="L2_SUPPORTED",
    ),
    "search_knowledge": LegacyCapabilityMapping(
        tool_name="search_knowledge",
        classification="PURE",
        capabilities=["retrieve"],
        evidence_level="L2_SUPPORTED",
    ),
    "recall_memory": LegacyCapabilityMapping(
        tool_name="recall_memory",
        classification="PURE",
        capabilities=["retrieve"],
        evidence_level="L2_SUPPORTED",
    ),
    "recall_executions": LegacyCapabilityMapping(
        tool_name="recall_executions",
        classification="PURE",
        capabilities=["retrieve"],
        evidence_level="L2_SUPPORTED",
    ),
    "query_db_internal": LegacyCapabilityMapping(
        tool_name="query_db_internal",
        classification="PURE",
        capabilities=["retrieve"],
        evidence_level="L2_SUPPORTED",
    ),
    "query_db_external": LegacyCapabilityMapping(
        tool_name="query_db_external",
        classification="EFFECTFUL",
        capabilities=["observe"],
        evidence_level="L3_OBSERVED",
        produces_observation=True,
    ),
    "send_email": LegacyCapabilityMapping(
        tool_name="send_email",
        classification="EFFECTFUL",
        capabilities=["mutate"],
        evidence_level="L3_OBSERVED",
        produces_command=True,
        produces_receipt=True,
        produces_observation=False,
    ),
}


BLOCKED_TOOLS: dict[str, str] = {}

_EXTERNAL_FLAGS = {"external", "replica", "live"}


def _is_query_db_external(input_params: dict | None) -> bool:
    if not input_params:
        return False
    keys = {str(key).lower() for key in input_params}
    if keys & _EXTERNAL_FLAGS:
        return True
    source = str(input_params.get("source", "")).lower()
    if source in _EXTERNAL_FLAGS:
        return True
    sql = str(input_params.get("sql", ""))
    return bool(sql and not re.match(r"^\s*SELECT\b", sql, re.IGNORECASE))


def classify_legacy_tool(
    tool_name: str,
    input_params: dict | None = None,
) -> LegacyCapabilityMapping | None:
    """显式白名单映射；无法安全映射返回 None（BLOCKED / 无 fallback）。"""
    name = tool_name.strip().lower()
    if name == "search_web":
        return LEGACY_CAPABILITY_MAP["search_web"]
    if name == "search_knowledge":
        return LEGACY_CAPABILITY_MAP["search_knowledge"]
    if name == "recall_memory":
        return LEGACY_CAPABILITY_MAP["recall_memory"]
    if name == "recall_executions":
        return LEGACY_CAPABILITY_MAP["recall_executions"]
    if name == "query_db":
        if _is_query_db_external(input_params or {}):
            return LEGACY_CAPABILITY_MAP["query_db_external"]
        return LEGACY_CAPABILITY_MAP["query_db_internal"]
    if name == "send_email":
        return LEGACY_CAPABILITY_MAP["send_email"]
    return None


__all__ = [
    "BLOCKED_TOOLS",
    "LEGACY_CAPABILITY_MAP",
    "LegacyCapabilityMapping",
    "classify_legacy_tool",
]
