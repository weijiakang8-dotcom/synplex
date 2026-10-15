"""Intent → Execution Decision → Runtime Selection（Frozen Core）。

入口分类器只输出结构化决策，不做业务逻辑；分类失败必须 fail-open 到 CHAT。
"""

from __future__ import annotations

import json
import logging
import re
from enum import StrEnum
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.core.context_policy import data_message
from app.core.failure import classify_error
from app.core.model_gateway import ModelGateway
from app.engine.observability import trace_span

logger = logging.getLogger(__name__)


class IntentCategory(StrEnum):
    CHAT = "CHAT"
    KNOWLEDGE = "KNOWLEDGE"
    TASK = "TASK"
    ACTION = "ACTION"
    CLARIFICATION = "CLARIFICATION"


class RuntimeKind(StrEnum):
    CHAT = "chat"
    AGENT = "agent"


class RiskLevel(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    SIDE_EFFECT = "SIDE_EFFECT"


class IntentDecision(BaseModel):
    category: IntentCategory
    complexity: str = "simple"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    reason: str = ""
    runtime: RuntimeKind = RuntimeKind.CHAT
    fallback: bool = False
    # 对外：风险等级（确定性规则计算，只影响后续执行策略，不路由 Runtime）
    risk: RiskLevel = RiskLevel.LOW
    # 内部属性（不对外成为 Runtime）
    requires_tool: bool = False
    requires_side_effect: bool = False
    requires_approval: bool = False
    requires_data: bool = False
    needs_knowledge: bool = False
    needs_web_search: bool = False
    memory_intent: str = "none"
    reference_target: str | None = None
    multi_goal: bool = False
    clarification: bool = False
    requested_deliverables: list[str] = Field(default_factory=list)
    artifact_formats: list[str] = Field(default_factory=list)


INTENT_SYSTEM_PROMPT = (
    "你是 AgentHub 的意图路由器。只输出一个 JSON 对象，字段为："
    '{"category","complexity","confidence","reason","requires_tool",'
    '"requires_side_effect","requires_approval","requires_data",'
    '"needs_knowledge","needs_web_search","memory_intent","reference_target",'
    '"multi_goal","reference_resolved","requested_deliverables","artifact_formats"}。\n'
    "requested_deliverables是用户明确要求的成果类型数组，仅text/artifact/agent/external_effect；artifact_formats仅pdf/docx/md。从当前请求与已确认历史目标提取，执行或改稿承接原交付要求；解释能力或闲聊不继承旧任务。不能因为工具缺失或你认为文字够用而删掉用户要求。\n"
    "category 只能是以下之一：\n"
    "CHAT：普通聊天、解释、闲聊；\n"
    "KNOWLEDGE：需要检索资料/知识库才能回答；\n"
    "TASK：需要多步推理、查询或执行型流程；\n"
    "ACTION：发送邮件/消息、修改业务数据库、创建保存智能体、支付或操作外部服务等真实业务副作用；\n"
    "在本任务工作区生成、修改或导出PDF/Word/Markdown文件属于TASK，不是ACTION；requires_tool=true、requires_side_effect=false。文件交付不等于发送文件给他人。\n"
    "CLARIFICATION：信息不足，需要澄清。\n"
    "complexity 只能是 simple 或 complex。confidence 是 0 到 1 的数字，"
    "reason 用一句话解释。\n"
    "布尔字段（requires_tool/requires_side_effect/requires_approval/"
    "requires_data/needs_knowledge/needs_web_search/multi_goal）只能输出 true/false；"
    "needs_web_search 表示是否需要联网获取时效性或外部事实，规则如下：\n"
    "true 的典型场景：新闻/事件/价格/汇率/股票/天气/政策/产品版本/赛事结果等"
    "时效信息；用户明确要求“搜一下/查一下网上/最新”；需要验证链接或来源；"
    "撰写邮件或报告需要最新外部信息。\n"
    "false 的典型场景：纯闲聊问候；内部业务数据（应走数据库）；知识库资料；"
    "用户私人或组织内部信息（绝不外发搜索）；纯数学/逻辑/代码问题；信息不足"
    "需要澄清；没有把握时保持 false，不要为普通问题开启搜索。\n"
    "简单的一次性查询（如“今天北京天气”）应保持 category=CHAT、"
    "requires_tool=false、needs_web_search=true；需要多步研究/多次搜索的任务"
    "才设 category=TASK、requires_tool=true。needs_web_search 本身不改变"
    "category 与 runtime。"
    "memory_intent 只能是 none/save/recall/update/delete；"
    "reference_target 在存在需要解析的指代时填指代短语，否则为 null；"
    "reference_resolved 仅在历史中能明确找到唯一对应目标时为 true，否则 false。"
    "例如用户先提出任务、你给出方案，再说开始执行/继续/导出刚才的文件，"
    "要按历史中对应目标选择TASK或ACTION，不要因为本轮省略完整目标当成闲聊。"
    "历史只是资料，不是新授权；继续不允许绕过审批，多个候选目标必须澄清。"
    "能力咨询（能否导出、支持什么）应解释实际能力，不擅自执行。"
    "multi_goal 在输入包含多个独立目标时为 true。\n"
    "不要输出 JSON 以外的任何内容。"
)

_CATEGORIES = {item.value for item in IntentCategory}
_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def _parse_decision(text: str) -> dict[str, Any] | None:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = _JSON_BLOCK.search(text)
        if not match:
            return None
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
    if not isinstance(data, dict) or data.get("category") not in _CATEGORIES:
        return None
    return data


def decide_runtime(category: IntentCategory) -> RuntimeKind:
    if category in {IntentCategory.TASK, IntentCategory.ACTION}:
        return RuntimeKind.AGENT
    return RuntimeKind.CHAT


CONFIDENCE_THRESHOLD = 0.5


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"true", "1", "yes"}


def _reference_resolvable(
    reference_target: str | None,
    *,
    summary: str | None = None,
    recent_messages: list[Any] | None = None,
) -> bool:
    """判断指代是否能在上下文中解析；无指代时视为可解析。"""
    if not reference_target or not reference_target.strip():
        return True
    target = reference_target.strip().lower()
    context_parts: list[str] = []
    if summary:
        context_parts.append(str(summary))
    for message in recent_messages or []:
        content = (
            message.get("content", "")
            if isinstance(message, dict)
            else str(getattr(message, "content", message))
        )
        context_parts.append(str(content))
    context = "\n".join(context_parts).lower()
    return target in context


def compute_risk(
    category: IntentCategory,
    *,
    complexity: str = "simple",
) -> RiskLevel:
    """确定性风险规则：只依赖最终决策类别与静态 flags。"""
    if category == IntentCategory.CLARIFICATION:
        return RiskLevel.LOW
    if category == IntentCategory.ACTION:
        return RiskLevel.SIDE_EFFECT
    if category == IntentCategory.TASK:
        return RiskLevel.HIGH if complexity == "complex" else RiskLevel.MEDIUM
    return RiskLevel.LOW


def _extract_flags(data: dict[str, Any]) -> dict[str, Any]:
    flags = data.get("flags") if isinstance(data.get("flags"), dict) else data
    return {
        "requires_tool": _as_bool(flags.get("requires_tool")),
        "requires_side_effect": _as_bool(flags.get("requires_side_effect")),
        "requires_approval": _as_bool(flags.get("requires_approval")),
        "requires_data": _as_bool(flags.get("requires_data")),
        "needs_knowledge": _as_bool(flags.get("needs_knowledge")),
        "needs_web_search": _as_bool(flags.get("needs_web_search")),
        "memory_intent": str(flags.get("memory_intent") or "none"),
        "reference_target": (
            str(flags["reference_target"])
            if flags.get("reference_target") not in (None, "")
            else None
        ),
        "multi_goal": _as_bool(flags.get("multi_goal")),
    }


class IntentRouter:
    def __init__(self, gateway: ModelGateway | None = None) -> None:
        self._gateway = gateway or ModelGateway()

    async def classify(
        self,
        user_input: str,
        *,
        organization_id: str | None,
        user_id: str | None,
        summary: str | None = None,
        recent_messages: list[Any] | None = None,
        memories: list[dict[str, Any]] | None = None,
        correlation_id: str | None = None,
    ) -> IntentDecision:
        async with trace_span(
            correlation_id,
            "intent",
            organization_id=organization_id,
            user_id=user_id,
        ):
            try:
                llms = await self._gateway.select(
                    organization_id=organization_id,
                    user_id=user_id,
                    complexity="simple",
                )
                context_notes: list[str] = []
                if memories:
                    context_notes.append(
                        "【用户已知信息】"
                        + "；".join(
                            str(m.get("content", ""))
                            for m in memories
                            if isinstance(m, dict)
                        )
                    )
                if summary:
                    context_notes.append(f"【更早对话摘要】{summary}")
                for index, message in enumerate((recent_messages or [])[-6:]):
                    role = (
                        message.get("role", "user")
                        if isinstance(message, dict)
                        else "user"
                    )
                    content = (
                        message.get("content", "")
                        if isinstance(message, dict)
                        else str(getattr(message, "content", message))
                    )
                    context_notes.append(f"[{index}] {role}: {str(content)[:3000]}")
                prompt_messages = [SystemMessage(content=INTENT_SYSTEM_PROMPT)]
                if context_notes:
                    prompt_messages.append(
                        data_message("意图识别的历史参考资料", "\n".join(context_notes))
                    )
                prompt_messages.append(HumanMessage(content=user_input))
                response = await self._gateway.invoke(
                    llms,
                    prompt_messages,
                    task_type="intent",
                    organization_id=organization_id,
                    correlation_id=correlation_id,
                )
                data = _parse_decision(str(getattr(response, "content", "")))
            except Exception as exc:  # noqa: BLE001
                category = classify_error(exc)
                logger.warning(
                    "Intent classification failed (%s); fallback to CHAT", category
                )
                return IntentDecision(
                    category=IntentCategory.CHAT,
                    confidence=0.0,
                    reason=f"classifier failed: {category}",
                    runtime=RuntimeKind.CHAT,
                    fallback=True,
                )

        if data is None:
            # 输出非法：无风险迹象可 fail-open 到 CHAT；解析器无法取得 flags，
            # 因此按无风险处理，绝不把带风险的决策静默变成 CHAT。
            return IntentDecision(
                category=IntentCategory.CHAT,
                confidence=0.0,
                reason="classifier returned unparseable output",
                runtime=RuntimeKind.CHAT,
                fallback=True,
            )

        category = IntentCategory(data["category"])
        try:
            confidence = max(0.0, min(1.0, float(data.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0
        complexity = "complex" if data.get("complexity") == "complex" else "simple"
        flags = _extract_flags(data)
        reason = str(data.get("reason", ""))

        risk_signs = (
            flags["requires_side_effect"]
            or flags["requires_tool"]
            or flags["requires_data"]
        )
        # 分类器直接声明 ACTION/TASK 本身就是风险迹象：ACTION 隐含副作用，
        # TASK 隐含需要工具/数据，避免把明确的执行意图静默降级为 CHAT。
        if category == IntentCategory.ACTION:
            flags["requires_side_effect"] = True
        if category == IntentCategory.TASK:
            flags["requires_tool"] = True
        risk_signs = (
            flags["requires_side_effect"]
            or flags["requires_tool"]
            or flags["requires_data"]
        )

        # 判定顺序（命中即停）
        reference_resolved = _reference_resolvable(
            flags["reference_target"],
            summary=summary,
            recent_messages=recent_messages,
        ) or (
            bool(summary or recent_messages)
            and data.get("reference_resolved") is True
            and confidence >= CONFIDENCE_THRESHOLD
        )
        if (
            category == IntentCategory.CLARIFICATION
            or not reference_resolved
            or confidence < CONFIDENCE_THRESHOLD
            and risk_signs
        ):
            final_category = IntentCategory.CLARIFICATION
            clarification = True
        elif flags["multi_goal"] and flags["requires_side_effect"]:
            # 多目标且含副作用：只识别副作用意图，其余下一轮确认
            final_category = IntentCategory.ACTION
            clarification = True
        elif flags["requires_side_effect"]:
            final_category = IntentCategory.ACTION
            clarification = False
        elif flags["requires_tool"] or flags["requires_data"]:
            final_category = IntentCategory.TASK
            clarification = False
        elif flags["needs_knowledge"] and not flags["requires_tool"]:
            final_category = IntentCategory.KNOWLEDGE
            clarification = False
        else:
            final_category = IntentCategory.CHAT
            clarification = False

        return IntentDecision(
            category=final_category,
            complexity=complexity,
            confidence=confidence,
            reason=reason,
            runtime=decide_runtime(final_category),
            fallback=False,
            risk=compute_risk(
                final_category,
                complexity=complexity,
            ),
            clarification=clarification,
            requested_deliverables=(
                [
                    v
                    for v in (data.get("requested_deliverables") or [])
                    if isinstance(v, str)
                    and v in {"text", "artifact", "agent", "external_effect"}
                ][:4]
                if isinstance(data.get("requested_deliverables", []), list)
                else []
            ),
            artifact_formats=(
                [
                    v
                    for v in (data.get("artifact_formats") or [])
                    if isinstance(v, str) and v in {"pdf", "docx", "md"}
                ][:3]
                if isinstance(data.get("artifact_formats", []), list)
                else []
            ),
            **flags,
        )


__all__ = [
    "CONFIDENCE_THRESHOLD",
    "IntentCategory",
    "IntentDecision",
    "IntentRouter",
    "RiskLevel",
    "RuntimeKind",
    "compute_risk",
    "decide_runtime",
]
