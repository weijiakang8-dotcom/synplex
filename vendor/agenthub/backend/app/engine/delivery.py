"""用户交付说明独立于运行生命周期。失败保留已完成工作，诊断不泄露密钥。"""

from __future__ import annotations

from typing import Any


def blocker_for(error: Any) -> dict[str, Any]:
    if getattr(error, "delivery_blocker", None):
        return dict(error.delivery_blocker)
    text = str(error).lower()
    if "no model satisfies" in text:
        code, reason, actions = (
            "model_capability",
            "已配置模型不具备当前任务所需的能力。",
            ["配置支持所需工具调用、视觉、结构化输出或上下文长度的模型后继续。"],
        )
    elif "401" in text or "api key" in text or "authentication" in text:
        code, reason, actions = (
            "model_auth",
            "模型或工具服务认证失败。",
            ["检查对应服务的密钥是否有效、是否有调用权限，再继续。"],
        )
    elif "disabled" in text:
        code, reason, actions = (
            "capability_disabled",
            "所需执行能力尚未启用。",
            ["请管理员启用执行器或接入相应连接器后继续。"],
        )
    elif "timeout" in text or "timed out" in text:
        code, reason, actions = (
            "timeout",
            "执行依赖的服务在等待时间内没有响应。",
            ["检查服务连通性；保留已有结果，稍后继续该步骤。"],
        )
    elif (
        "already exists" in text
        or "name unavailable" in text
        or "已被占用" in text
        or "重名" in text
    ):
        code, reason, actions = (
            "name_conflict",
            "目标名称已被占用，本次保存没有成功。",
            [
                "换一个名称后重试；如果已有同名对象就是要用的那个，直接复用它，不要重复创建。"
            ],
        )
    elif "budget" in text or "quota" in text:
        code, reason, actions = (
            "budget",
            "本次可用预算或配额已用尽。",
            ["缩小任务范围，或提高预算后继续。"],
        )
    elif "approval" in text or "rejected" in text:
        code, reason, actions = (
            "approval",
            "操作尚未获得有效批准。",
            ["核对具体操作参数，再批准新的提案。"],
        )
    elif "unknown" in text and ("effect" in text or "in_flight" in text):
        code, reason, actions = (
            "uncertain_commit",
            "外部操作是否成功尚未确认。",
            ["先核对外部状态，避免重复提交。"],
        )
    elif "plan" in text or "capability" in text:
        code, reason, actions = (
            "planning",
            "无法形成覆盖全部目标的有效执行计划。",
            ["补充目标、必要资料或所需业务连接；可先完成已支持的部分。"],
        )
    elif "permission" in text or "forbidden" in text or "403" in text:
        code, reason, actions = (
            "permission",
            "当前身份缺少所需权限。",
            ["请管理员授予相应资源或连接器权限后继续。"],
        )
    elif "缺少前置" in text:
        code, reason, actions = (
            "dependency",
            "当前子任务缺少前置成果。",
            ["先完成缺失的前置任务，再继续下游任务。"],
        )
    else:
        code, reason, actions = (
            "service",
            "执行依赖的服务未能返回可用结果。",
            ["检查模型或工具连接配置后继续；已完成的结果已保留。"],
        )
    return {"code": code, "reason": reason, "next_actions": actions}


def delivery_for(state: dict, error: Any = None) -> dict:
    existing = dict(state.get("delivery") or {})
    blockers = list(existing.get("blockers") or [])
    artifacts = [
        a
        for a in state.get("artifacts") or []
        if isinstance(a, dict)
        and a.get("verified") is True
        and a.get("id")
        and a.get("sha256")
        and a.get("download_url")
    ]
    if error:
        blocker = blocker_for(error)
        if blocker["code"] == "budget" and state.get("budget_stop_reason"):
            blocker["reason"] = "本次执行达到安全预算限制：" + str(
                state["budget_stop_reason"]
            )
        blockers.append(blocker)
    outputs = state.get("node_outputs") or {}
    # Legacy plans have no step_id; the executor stores them as step_N.
    plan = [
        {**step, "step_id": step.get("step_id") or f"step_{index + 1}"}
        for index, step in enumerate(state.get("plan") or [])
    ]

    def has_result(step):
        key = step["step_id"]
        if key not in outputs:
            return False
        value = outputs[key]
        return not (
            isinstance(value, dict)
            and value.get("status")
            in {"failed", "error", "unknown", "in_flight", "IN_FLIGHT", "UNKNOWN"}
        )

    completed = [
        {"step_id": step.get("step_id"), "description": step.get("description")}
        for step in plan
        if has_result(step)
    ]
    requirements = ((state.get("plan_meta") or {}).get("plan") or {}).get(
        "deliverables"
    ) or []
    requirements = list(requirements) + list(
        (state.get("intent") or {}).get("requested_deliverables") or []
    )
    # Accept historical object-shaped plans as well as the canonical string protocol.
    types = {
        item.get("type") if isinstance(item, dict) else item for item in requirements
    }
    needs_artifact = "artifact" in types or any(
        step.get("capability") == "document" for step in plan
    )
    if needs_artifact and not artifacts:
        blockers.append(
            {
                "code": "missing_artifact",
                "reason": "所需文件尚未成功生成，文字回答不能代替可下载成果。",
                "next_actions": ["保留源稿，完成文档导出后再交付。"],
            }
        )

    requested_formats = set((state.get("intent") or {}).get("artifact_formats") or [])
    missing_formats = requested_formats - {a.get("format") for a in artifacts}
    if missing_formats:
        blockers.append(
            {
                "code": "missing_format",
                "reason": "所需文件格式尚未交付：" + "、".join(sorted(missing_formats)),
                "next_actions": ["保留已有成果，补齐指定格式的真实文件后再交付。"],
            }
        )

    def successful_effect(value):
        return isinstance(value, dict) and value.get("status") in {
            "success",
            "duplicate",
        }

    if "agent" in types and not any(
        successful_effect(value)
        and isinstance(value.get("data"), dict)
        and value["data"].get("agent_id")
        for value in outputs.values()
    ):
        blockers.append(
            {
                "code": "missing_agent",
                "reason": "智能体尚未保存成功。",
                "next_actions": ["核对配置与权限，批准创建提案后继续。"],
            }
        )
    effects = [step for step in plan if step.get("side_effect")]
    if "external_effect" in types and (
        not effects
        or not all(
            successful_effect(outputs.get(step.get("step_id"))) for step in effects
        )
    ):
        blockers.append(
            {
                "code": "missing_effect",
                "reason": "所需外部操作尚未取得成功凭据。",
                "next_actions": ["接入相应业务连接器、完成授权并批准明确的操作提案。"],
            }
        )
    pending = [
        {
            "step_id": s.get("step_id"),
            "description": s.get("description"),
            "depends_on": s.get("depends_on") or [],
            "acceptance_criteria": s.get("acceptance_criteria") or [],
        }
        for s in plan
        if not has_result(s)
    ]
    if pending:
        blockers.append(
            {
                "code": "incomplete_steps",
                "reason": "部分计划步骤尚未产出结果。",
                "next_actions": [
                    "从未完成步骤继续，并核对前置成果；不重复已确认的外部操作。"
                ],
            }
        )
    verification = state.get("verification_status") or "UNKNOWN"
    status = (
        "partial"
        if blockers and (completed or artifacts)
        else (
            "blocked"
            if blockers
            else (
                "partial"
                if verification == "FAIL"
                else "completed" if verification == "PASS" else "unverified"
            )
        )
    )
    if verification == "FAIL" and not blockers:
        blockers.append(
            {
                "code": "verification",
                "reason": "输出尚未满足验收条件。",
                "next_actions": ["核对已生成结果并补充未满足的条件。"],
            }
        )
    return {
        "status": status,
        "verification": verification,
        "completed_steps": completed,
        "blockers": blockers,
        "artifacts": artifacts,
        "feasibility": (
            ((state.get("plan_meta") or {}).get("plan") or {}).get("feasibility")
            or None
        ),
        "continuation": {
            "goal": state.get("user_input") or "",
            "current_step": state.get("current_step", 0),
            "completed_steps": completed,
            "pending_steps": pending,
            "deliverables": requirements,
            "budget_used": state.get("budget_used") or {},
            "resume_policy": "checkpoint_only; reconcile uncertain effects before retry",
        },
    }


def delivery_output(state: dict, delivery: dict) -> str:
    text = str(state.get("final_output") or "").strip()
    outputs = state.get("node_outputs") or {}
    # 规划阶段就判定做不到时，先把结论和补齐条件说在最前面，
    # 不让用户读完一大段成果才发现关键动作没做。
    feasibility = delivery.get("feasibility") or {}
    if feasibility.get("possible") is False:
        missing = [str(item) for item in feasibility.get("missing") or []]
        continue_with = [str(item) for item in feasibility.get("continue_with") or []]
        head = ["这件事当前做不到，先说明原因和继续条件。"]
        if missing:
            head.append("缺少：" + "；".join(missing))
        if continue_with:
            head.append("补齐后可以继续：" + "；".join(continue_with))
        text = "\n".join([*head, "", text]).strip()
    if delivery["blockers"]:
        seen = set()
        preserved = []
        for step in state.get("plan") or []:
            value = str(outputs.get(step.get("step_id")) or "").strip()
            if value and value != text and value not in seen:
                preserved.append(value)
                seen.add(value)
        if preserved:
            text = "\n\n".join([*preserved, text]).strip()
        notes = []
        for item in delivery["blockers"]:
            notes.append(item["reason"])
            notes.extend(item.get("next_actions") or [])
        text += "\n\n未完成部分：\n" + "\n".join(f"- {note}" for note in notes)
    elif delivery["status"] == "unverified":
        text += "\n\n本次未取得独立验证结果。"
    return text.strip() or "尚未生成可交付结果，请补充目标与必要条件后继续。"


def delivery_snapshot(state: dict, error: Any = None) -> tuple[str, dict]:
    delivery = delivery_for(state, error)
    return delivery_output(state, delivery), {
        "llm_usage": state.get("llm_usage") or [],
        "delivery": delivery,
        "node_outputs": state.get("node_outputs") or {},
        "continuation": delivery["continuation"],
        "plan": state.get("plan") or [],
        "plan_meta": state.get("plan_meta") or {},
        "budget_used": state.get("budget_used") or {},
        "artifacts": delivery["artifacts"],
    }
