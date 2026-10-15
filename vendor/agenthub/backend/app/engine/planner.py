"""Task → Planner → Capability/Agent Selection → Execution Graph。"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from app.core.context_policy import data_message
from app.core.model_gateway import ModelGateway
from app.engine.capabilities import CAPABILITIES
from app.engine.observability import trace_span
from app.engine.step_context import INPUT_REFS

logger = logging.getLogger(__name__)

# 粗粒度子目标的上限。步骤变粗后，同样任务需要的步数明显减少：
# 实测把线代课程包拆成 3 个粗子目标一次产出，而切成 6 个细步会在预算内跑不完。
MAX_PLAN_STEPS = 10
PLAN_INVALID = "plan_invalid"
_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)

PLANNER_SYSTEM_PROMPT = (
    "你是任务规划器。把用户目标拆成 1-10 个**粗粒度子目标**，只输出 JSON："
    '{"goal":"<目标>","risk":"<LOW|MEDIUM|HIGH|SIDE_EFFECT>",'
    '"feasibility":{"possible":true,"missing":["缺的工具/权限/资料"],'
    '"continue_with":["补齐后如何继续"]},'
    '"deliverables":[{"type":"text|artifact|agent|external_effect","what":"<交付什么>",'
    '"done_when":"<什么算做完>"}],'
    '"steps":[{"step_id":"step_1","capability":"<能力名>","description":"<这一子目标要产出什么>",'
    '"input_refs":["前序 output_name 或原始输入"],"output_name":"<输出名>",'
    '"depends_on":["step_id"],"condition":"<可选，在 node_outputs 上求值>"}],'
    '"reason":"<一句话>"}。\n'
    "步骤要粗不要细：一个子目标应当是一次能产出完整成果的单元，"
    "不要把同一件事切成'先列提纲''再写第一节''再写第二节'这类细步；"
    "但也不能把互相依赖、需要分别验收的产出并成一步。步骤数由任务本身决定，不要为了看起来完整而堆步骤。\n"
    "先判断可行性：feasibility.possible 为 false 时，missing 必须列出真正缺的外部条件"
    "（工具、连接器、登录身份、用户资料、审批、支付），continue_with 说明补齐后如何继续；"
    "此时仍要规划能完成的部分，不能因为一件事做不到就整体放弃。"
    "不要用'没有相关工具'掩盖其实可以做到的事，也不要声称已完成外部交易。\n"
    "文档步骤添加artifact_formats字符串数组，仅允许pdf/docx/md，准确对应用户要求；可以添加document_title。"
    'input_refs只能引用精确的"user_input"（含用户已提供的全部材料），或前序步骤的step_id/output_name。不得给用户材料新建引用名，例如user_provided_literature。'
    "deliverables按上述对象数组格式输出，准确描述用户要求的成果和验收条件，不能用教程代替文件或已保存的智能体。"
    "根据当前工具能力规划；需要文件交付用 document，创建可保存智能体用 agent_builder，复杂只读任务用 general。无法执行的请求用 general 诊断缺口并交付可完成部分，不得声称已完成外部交易。只能从以下能力中选择："
    + ", ".join(CAPABILITIES)
    + "。side_effect 与 requires_approval 不允许输出，由能力目录静态决定。"
    "复合任务按 Gather（只读）→ Synthesize（analysis）→ Commit（副作用）→ "
    "Verify 的顺序设计。简单任务只输出一个 answer 步骤，不要为了完整而堆步骤。\n"
    "联网搜索边界：只有任务需要时效性或模型知识之外的外部事实时，才选择 "
    "research 或 web_search 能力；如果上下文中已经提供了【联网搜索结果】，"
    "直接把它当证据使用，不要重复添加 research/web_search 步骤，除非需要"
    "多角度补充检索。内部业务数据用 query_db，知识库资料用 knowledge，"
    "普通聊天用 answer；不要为私人或组织内部信息安排联网搜索。涉及 "
    "send_email/execute 时，正文应基于已提供的搜索证据，禁止编造外部事实。"
)


def plan_invalid(reason: str) -> dict[str, Any]:
    """显式的非法计划标记；禁止静默降级为 fallback/answer。"""
    return {"plan_invalid": True, "reason": reason}


def is_plan_invalid(plan: Any) -> bool:
    return isinstance(plan, dict) and bool(plan.get("plan_invalid"))


def _parse_json_object(text: str) -> dict[str, Any] | None:
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
    return data if isinstance(data, dict) else None


def _raw_step_errors(raw_steps):
    if len(raw_steps) > MAX_PLAN_STEPS:
        return "plan exceeds max steps; use bounded general subtasks"
    for item in raw_steps:
        if not isinstance(item, dict):
            return "every plan step must be an object"
        name = str(item.get("capability") or item.get("name") or "").strip()
        if name not in CAPABILITIES:
            return f"unsupported capability: {name}"
        for field in (
            "input_refs",
            "depends_on",
            "acceptance_criteria",
            "required_tools",
            "required_model_capabilities",
            "artifact_formats",
        ):
            value = item.get(field)
            if value is not None and (
                not isinstance(value, list)
                or any(not isinstance(ref, str) for ref in value)
            ):
                return f"{field} must be a string list"
        if any(
            fmt not in {"pdf", "docx", "md"}
            for fmt in item.get("artifact_formats") or []
        ):
            return "unsupported artifact format"
        if item.get("document_title") is not None and not isinstance(
            item["document_title"], str
        ):
            return "document_title must be a string"
        if item.get("output_name") is not None and not isinstance(
            item.get("output_name"), str
        ):
            return "output_name must be a string"
    return None


def _normalize_steps(raw_steps: list[Any]) -> list[dict[str, Any]]:
    """把 Planner 输出规范化为完整 Step Schema；风险字段由能力目录静态决定。"""
    steps: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_steps[:MAX_PLAN_STEPS]):
        if not isinstance(raw, dict):
            continue
        capability = str(raw.get("capability") or raw.get("name") or "").strip()
        if capability not in CAPABILITIES:
            continue
        capability_spec = CAPABILITIES[capability]
        raw_step_id = str(raw.get("step_id") or "").strip()
        step_id = raw_step_id or f"step_{index + 1}"
        steps.append(
            {
                "step_id": step_id,
                "capability": capability,
                "description": str(raw.get("description") or ""),
                "input_refs": list(raw.get("input_refs") or []),
                "output_name": raw.get("output_name") or None,
                "depends_on": list(raw.get("depends_on") or []),
                "condition": raw.get("condition"),
                "agent_id": raw.get("agent_id"),
                "acceptance_criteria": list(raw.get("acceptance_criteria") or []),
                "required_tools": list(raw.get("required_tools") or []),
                "required_model_capabilities": list(
                    raw.get("required_model_capabilities") or []
                ),
                **(
                    {"artifact_formats": list(raw["artifact_formats"])}
                    if raw.get("artifact_formats")
                    else {}
                ),
                **(
                    {"document_title": raw["document_title"]}
                    if raw.get("document_title")
                    else {}
                ),
                # Registry 静态声明，Planner 输出一律不采信
                "side_effect": capability_spec.side_effect,
                "requires_approval": capability_spec.requires_approval,
            }
        )
    producers = {str(step["step_id"]): step["step_id"] for step in steps}
    producers.update(
        {
            step["output_name"]: step["step_id"]
            for step in steps
            if step.get("output_name")
        }
    )
    for step in steps:
        for ref in step["input_refs"]:
            dependency = producers.get(ref)
            if (
                dependency
                and dependency != step["step_id"]
                and dependency not in step["depends_on"]
            ):
                step["depends_on"].append(dependency)
    return steps


def _has_cycle(steps: list[dict[str, Any]], step_ids: list[str]) -> bool:
    edges = {step["step_id"]: list(step.get("depends_on") or []) for step in steps}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(step_id: str) -> bool:
        if step_id in visiting:
            return True
        if step_id in visited:
            return False
        visiting.add(step_id)
        for dependency in edges.get(step_id, []):
            if dependency in edges and visit(dependency):
                return True
        visiting.discard(step_id)
        visited.add(step_id)
        return False

    return any(visit(step_id) for step_id in step_ids)


def normalize_deliverables(raw):
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise TypeError("deliverables must be a list")
    result = []
    for item in raw:
        kind = item.get("type") if isinstance(item, dict) else item
        if not isinstance(kind, str) or kind not in {
            "text",
            "artifact",
            "agent",
            "external_effect",
        }:
            raise ValueError("unknown deliverable type")
        if kind not in result:
            result.append(kind)
    return result


def validate_plan_structure(steps: list[dict[str, Any]]) -> list[str]:
    """校验 Step Schema、Registry 静态声明、依赖存在性与 DAG 无环。"""
    errors: list[str] = []
    if not steps:
        return ["plan has no steps"]
    if len(steps) > MAX_PLAN_STEPS:
        return [f"plan exceeds max steps ({MAX_PLAN_STEPS})"]

    step_ids = [step.get("step_id") for step in steps]
    if any(not step_id for step_id in step_ids):
        errors.append("every step must have step_id")
    if len(set(step_ids)) != len(step_ids):
        errors.append("duplicate step_id")

    for step in steps:
        capability = str(step.get("capability") or "")
        spec = CAPABILITIES.get(capability)
        if spec is None:
            errors.append(f"unknown capability: {capability}")
            continue
        if bool(step.get("side_effect")) != spec.side_effect:
            errors.append(
                f"side_effect for {capability} must come from Registry "
                f"({spec.side_effect})"
            )
        if bool(step.get("requires_approval")) != spec.requires_approval:
            errors.append(
                f"requires_approval for {capability} must come from Registry "
                f"({spec.requires_approval})"
            )
        for dependency in step.get("depends_on") or []:
            if dependency not in step_ids:
                errors.append(f"dependency {dependency} not found")

    outputs = [step.get("output_name") for step in steps if step.get("output_name")]
    if len(set(outputs)) != len(outputs):
        errors.append("duplicate output_name")
    for step in steps:
        output = step.get("output_name")
        if output in step_ids and output != step.get("step_id"):
            errors.append("output_name conflicts with step_id")
    producers = {step["step_id"]: step["step_id"] for step in steps}
    producers.update(
        {
            step["output_name"]: step["step_id"]
            for step in steps
            if step.get("output_name")
        }
    )
    seen = set()
    for step in steps:
        for ref in step.get("input_refs") or []:
            if ref not in INPUT_REFS and producers.get(ref) not in seen:
                errors.append(
                    f"input_ref {ref} must reference user_input or a preceding output"
                )
        for dependency in step.get("depends_on") or []:
            if dependency not in seen:
                errors.append(f"dependency {dependency} must precede {step['step_id']}")
        seen.add(step["step_id"])
    if _has_cycle(steps, step_ids):
        errors.append("dependency cycle detected")
    return errors


def compute_plan_risk(steps: list[dict[str, Any]]) -> str:
    """计划风险确定性推导：副作用 > 多步 > 单步。"""
    if any(bool(step.get("side_effect")) for step in steps):
        return "SIDE_EFFECT"
    if len(steps) >= 3:
        return "HIGH"
    if len(steps) > 1:
        return "MEDIUM"
    return "LOW"


def validate_plan(plan: dict[str, Any]) -> tuple[bool, list[str]]:
    """完整 Plan 校验（Executor 闸门复用）。"""
    if is_plan_invalid(plan):
        return False, [str(plan.get("reason") or "plan_invalid")]
    if not isinstance(plan.get("steps"), list):
        return False, ["plan must contain steps"]
    errors = validate_plan_structure(plan["steps"])
    if errors:
        return False, errors
    if not str(plan.get("goal") or "").strip():
        return False, ["plan must contain goal"]
    if str(plan.get("risk") or "").strip() not in {
        "LOW",
        "MEDIUM",
        "HIGH",
        "SIDE_EFFECT",
    }:
        return False, ["plan must contain valid risk"]
    if "side_effect_proposals" in plan and not isinstance(
        plan.get("side_effect_proposals"), list
    ):
        return False, ["side_effect_proposals must be a list"]
    return True, []


def _normalize_feasibility(raw: Any) -> dict[str, Any]:
    """规范化可行性判断；缺失时按"未评估"处理，不假装可行。"""
    if not isinstance(raw, dict):
        return {"possible": None, "missing": [], "continue_with": []}

    def _list(value: Any) -> list[str]:
        if isinstance(value, str):
            return [value.strip()] if value.strip() else []
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        return []

    possible = raw.get("possible")
    return {
        "possible": possible if isinstance(possible, bool) else None,
        "missing": _list(raw.get("missing")),
        "continue_with": _list(raw.get("continue_with")),
    }


def parse_plan(text: str) -> dict[str, Any]:
    try:
        data = _parse_json_object(text)
    except Exception:  # noqa: BLE001
        data = None
    if data is None:
        return plan_invalid("unparseable planner output")
    if not isinstance(data.get("steps"), list):
        return plan_invalid("planner output missing steps")
    raw_error = _raw_step_errors(data["steps"])
    if raw_error:
        return plan_invalid(raw_error)
    steps = _normalize_steps(data["steps"])
    errors = validate_plan_structure(steps)
    if errors:
        return plan_invalid("; ".join(errors))
    try:
        deliverables = normalize_deliverables(data.get("deliverables"))
    except (TypeError, ValueError) as exc:
        return plan_invalid(str(exc))
    return {
        "goal": str(data.get("goal") or ""),
        "risk": str(data.get("risk") or "") or compute_plan_risk(steps),
        "steps": steps,
        "reason": str(data.get("reason") or ""),
        "side_effect_proposals": list(data.get("side_effect_proposals") or []),
        "deliverables": deliverables,
        "feasibility": _normalize_feasibility(data.get("feasibility")),
    }


def normalize_plan(plan: dict[str, Any] | list[Any]) -> dict[str, Any]:
    """把 legacy 计划（workflow 派生/旧格式步骤列表）规范化为完整 Schema。"""
    if isinstance(plan, dict) and is_plan_invalid(plan):
        return plan
    if isinstance(plan, dict) and isinstance(plan.get("steps"), list):
        raw_steps = plan["steps"]
        goal = str(plan.get("goal") or "")
        risk = str(plan.get("risk") or "")
        reason = str(plan.get("reason") or "")
    elif isinstance(plan, list):
        raw_steps = plan
        goal = ""
        risk = ""
        reason = ""
    else:
        return plan_invalid("plan must be a dict or a step list")
    raw_error = _raw_step_errors(raw_steps)
    if raw_error:
        return plan_invalid(raw_error)
    steps = _normalize_steps(raw_steps)
    errors = validate_plan_structure(steps)
    if errors:
        return plan_invalid("; ".join(errors))
    try:
        deliverables = normalize_deliverables(
            plan.get("deliverables") if isinstance(plan, dict) else None
        )
    except (TypeError, ValueError) as exc:
        return plan_invalid(str(exc))
    return {
        "goal": goal,
        "risk": risk or compute_plan_risk(steps),
        "steps": steps,
        "reason": reason,
        "deliverables": deliverables,
        "side_effect_proposals": (
            list(plan.get("side_effect_proposals") or [])
            if isinstance(plan, dict)
            else []
        ),
        "feasibility": _normalize_feasibility(
            plan.get("feasibility") if isinstance(plan, dict) else None
        ),
    }


def side_effect_step_ids(plan: dict[str, Any]) -> tuple[str, ...]:
    """已批准/待审批的副作用步骤集合（冻结语义的基础）。"""
    steps = plan.get("steps") or []
    return tuple(
        str(step["step_id"]) for step in steps if bool(step.get("side_effect"))
    )


def compute_plan_hash(plan: dict[str, Any]) -> str:
    """plan_hash：对副作用步骤集合 + 冻结提案的不可变摘要。"""
    side_effects = [
        {
            "step_id": step["step_id"],
            "capability": step["capability"],
            "requires_approval": step["requires_approval"],
        }
        for step in plan.get("steps") or []
        if bool(step.get("side_effect"))
    ]
    proposals = [
        {
            "step_id": item.get("step_id"),
            "tool": item.get("tool"),
            "params_canonical": item.get("params_canonical"),
        }
        for item in plan.get("side_effect_proposals") or []
    ]
    payload = json.dumps(
        {
            "goal": plan.get("goal"),
            "side_effects": side_effects,
            "side_effect_proposals": proposals,
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def fallback_plan(user_input: str) -> dict[str, Any]:
    # 保留给旧调用；Phase 2 起非法计划一律走 plan_invalid，不再静默降级
    return {
        "steps": [{"capability": "answer", "description": user_input}],
        "reason": "planner fallback",
    }


class Planner:
    def __init__(self, gateway: ModelGateway | None = None) -> None:
        self._gateway = gateway or ModelGateway()

    async def _specialists(self, organization_id):
        import uuid

        from sqlalchemy import select

        from app.database import async_session_factory
        from app.models import Agent
        from app.models.enums import AgentStatus

        try:
            async with async_session_factory() as session:
                rows = (
                    (
                        await session.execute(
                            select(Agent)
                            .where(
                                Agent.organization_id
                                == (
                                    uuid.UUID(str(organization_id))
                                    if organization_id
                                    else None
                                ),
                                Agent.status == AgentStatus.ACTIVE,
                            )
                            .limit(30)
                        )
                    )
                    .scalars()
                    .all()
                )
                return [
                    {
                        "id": str(a.id),
                        "name": a.name,
                        "description": a.description,
                        "tools": a.tools,
                    }
                    for a in rows
                ]
        except Exception:
            logger.warning("Specialist catalog unavailable", exc_info=True)
            return []

    async def plan(
        self,
        user_input: str,
        *,
        organization_id: str | None,
        user_id: str | None,
        correlation_id: str | None = None,
        context: str | None = None,
    ) -> dict[str, Any]:
        async with trace_span(
            correlation_id,
            "plan",
            organization_id=organization_id,
            user_id=user_id,
        ):
            try:
                llms = await self._gateway.select(
                    organization_id=organization_id,
                    user_id=user_id,
                    complexity="complex",
                )
                messages = [SystemMessage(content=PLANNER_SYSTEM_PROMPT)]
                if context:
                    messages.append(data_message("规划参考资料与历史结果", context))
                specialists = await self._specialists(organization_id)
                if specialists:
                    messages.append(
                        data_message(
                            "可选保存的专业Agent目录（匹配时使用general并设置目录中的agent_id）",
                            specialists,
                        )
                    )
                messages.append(HumanMessage(content=user_input))
                response = await self._gateway.invoke(
                    llms,
                    messages,
                    task_type="plan",
                    organization_id=organization_id,
                    correlation_id=correlation_id,
                )
                plan = parse_plan(str(getattr(response, "content", "")))
                if is_plan_invalid(plan):
                    # Repair only before approval/effects, once; preserve the goal and trust boundary.
                    messages.extend(
                        [
                            data_message(
                                "无效规划输出及协议校验错误",
                                {
                                    "output": str(response.content),
                                    "error": plan["reason"],
                                },
                            ),
                            HumanMessage(
                                content="修正上述协议错误，保持原用户目标，返回完整合法JSON。只允许引用user_input或前序产物；不要执行任何工具。"
                            ),
                        ]
                    )
                    repair_llms = await self._gateway.select(
                        organization_id=organization_id,
                        user_id=user_id,
                        complexity="simple",
                    )
                    repaired = await self._gateway.invoke(
                        repair_llms,
                        messages,
                        task_type="plan:repair",
                        organization_id=organization_id,
                        correlation_id=correlation_id,
                    )
                    plan = parse_plan(str(getattr(repaired, "content", "")))
            except Exception as exc:
                from app.engine.delivery import blocker_for

                logger.warning("Planning failed; plan_invalid", exc_info=True)
                plan = {**plan_invalid("planner failed"), "blocker": blocker_for(exc)}
            return plan


__all__ = [
    "MAX_PLAN_STEPS",
    "PLAN_INVALID",
    "Planner",
    "compute_plan_hash",
    "compute_plan_risk",
    "fallback_plan",
    "is_plan_invalid",
    "normalize_plan",
    "parse_plan",
    "plan_invalid",
    "side_effect_step_ids",
    "validate_plan",
    "validate_plan_structure",
]
