from __future__ import annotations

import json
import logging
import re
from typing import Any

from langchain_core.messages import SystemMessage

from app.core.context_policy import data_message
from app.core.model_gateway import ModelGateway
from app.database import async_session_factory
from app.models import Execution

logger = logging.getLogger(__name__)


def _extract_json(text: str) -> dict[str, Any]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


async def evaluate_execution(execution_id: str) -> None:
    """LLM-as-Judge：对已完成执行的 final_output 进行三维打分并落库。"""
    async with async_session_factory() as session:
        execution = await session.get(Execution, execution_id)
        if execution is None or not execution.final_output:
            return
        user_input = execution.user_input
        final_output = execution.final_output
        organization_id = (
            str(execution.organization_id) if execution.organization_id else None
        )

    prompt = (
        "你是一名严格的评审专家。请根据用户指令和 Agent 最终输出，"
        "从准确性(accuracy)、完整性(completeness)、逻辑性(logic)三个维度打分，"
        "每个维度 1-10 分，并给出简短评语。只输出 JSON：\n"
        '{"accuracy": 8, "completeness": 7, "logic": 9, "comment": "..."}'
    )

    gateway = ModelGateway()
    llms = await gateway.select(
        organization_id=organization_id,
        complexity="simple",
    )
    try:
        response = await gateway.invoke(
            llms,
            [
                SystemMessage(content=prompt),
                data_message(
                    "用户目标与待评输出", {"用户目标": user_input, "输出": final_output}
                ),
            ],
            task_type="evaluate",
            organization_id=organization_id,
            correlation_id=execution_id,
        )
        result = _extract_json(str(response.content))
    except Exception as exc:  # noqa: BLE001
        logger.warning("evaluation failed: %s", exc)
        result = None

    # Evaluation is another billed model call, including invalid judge outputs.
    from app.core.billing import record_execution_usage

    await record_execution_usage(execution_id)

    if not isinstance(result, dict) or not {
        "accuracy",
        "completeness",
        "logic",
    } <= set(result):
        logger.warning("evaluation skipped for execution %s", execution_id)
        return

    score = round(
        (
            float(result["accuracy"])
            + float(result["completeness"])
            + float(result["logic"])
        )
        / 3,
        2,
    )
    async with async_session_factory() as session:
        execution = await session.get(Execution, execution_id)
        if execution is None:
            return
        execution.eval_score = score
        execution.eval_details = result
        await session.commit()
