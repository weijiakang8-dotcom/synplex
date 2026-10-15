"""确定性执行闸门（Phase 2 Contract 03/04）。

顺序：Plan Validator → Risk/Budget Validator → (ACTION: Approval) → Execution
  → Checkpoint → Verify → Respond。

本模块是 Agent Runtime 的确定性闸门，步骤执行由调用方注入（LangGraph 节点或
测试替身），保证安全策略不被绕过：plan_invalid 显式返回、只读预算优雅终止、
副作用预算硬终止、副作用失败终止+审计、副作用步骤串行、replan ≤1 且只读。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from app.database import async_session_factory
from app.engine.approval import (
    same_side_effect_proposals,
    validate_proposals,
)
from app.engine.observability import record_span
from app.engine.planner import (
    compute_plan_hash,
    is_plan_invalid,
    side_effect_step_ids,
    validate_plan,
)
from app.models import AuditLog

logger = logging.getLogger(__name__)

MAX_SIDE_EFFECT_PARALLELISM = 1


class PlanInvalidError(RuntimeError):
    """非法计划：禁止静默降级，必须显式失败并审计。"""

    def __init__(self, reason: str, *, blocker: dict | None = None):
        super().__init__(reason)
        self.delivery_blocker = blocker


@dataclass(frozen=True)
class BudgetLimits:
    max_steps: int = 6
    max_replans: int = 1
    max_verifies: int = 1
    wall_clock_seconds: float = 300.0
    max_tokens: int = 100_000
    max_cost: float = 10.0


@dataclass
class ExecutionBudget:
    limits: BudgetLimits = field(default_factory=BudgetLimits)
    steps_executed: int = 0
    replans: int = 0
    verifies: int = 0
    tokens: int = 0
    cost: float = 0.0
    started_at: float = field(default_factory=time.monotonic)

    def register_step(self, step_result: dict[str, Any] | None = None) -> None:
        step_result = step_result or {}
        self.steps_executed += 1
        self.tokens += int(step_result.get("tokens") or 0)
        self.cost += float(step_result.get("cost") or 0.0)

    def exceeded(self) -> str | None:
        elapsed = time.monotonic() - self.started_at
        if elapsed > self.limits.wall_clock_seconds:
            return (
                f"wall-clock {elapsed:.1f}s exceeds "
                f"{self.limits.wall_clock_seconds:.1f}s"
            )
        if self.tokens > self.limits.max_tokens:
            return f"tokens {self.tokens} exceed {self.limits.max_tokens}"
        if self.cost > self.limits.max_cost:
            return f"cost {self.cost:.4f} exceeds {self.limits.max_cost:.4f}"
        if self.steps_executed >= self.limits.max_steps:
            return f"steps exceed {self.limits.max_steps}"
        return None


@dataclass(frozen=True)
class Approval:
    """计划级审批：冻结副作用集合，plan_hash 为不可变摘要。"""

    plan_hash: str
    approval_id: str
    approved_side_effect_set: tuple[str, ...]
    approved_proposals: tuple[dict[str, Any], ...] = ()
    approved: bool = True


@dataclass
class ExecutionResult:
    status: str = "completed"
    plan_invalid: bool = False
    invalid_reason: str = ""
    budget_exceeded: bool = False
    hard_stop: bool = False
    approval_required: bool = False
    approval_id: str | None = None
    plan_hash: str = ""
    partial_result: dict[str, Any] = field(default_factory=dict)
    final_output: str | None = None
    verify_result: str | None = None
    replanned: bool = False
    node_outputs: dict[str, Any] = field(default_factory=dict)
    executed_step_ids: list[str] = field(default_factory=list)
    max_active_steps: int = 1


def has_side_effects(plan: dict[str, Any]) -> bool:
    return bool(side_effect_step_ids(plan))


def should_verify(intent_category: str, plan: dict[str, Any]) -> bool:
    """Verify 风险策略：CHAT/KNOWLEDGE 与 LOW/MEDIUM TASK 不 Verify。"""
    if intent_category in {"CHAT", "KNOWLEDGE"}:
        return False
    if intent_category == "ACTION":
        return True
    return str(plan.get("risk") or "") == "HIGH"


def replan_read_only(
    original: dict[str, Any], candidate: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Replan 只能重排/降级只读步骤；副作用集合不可变且必须重过验证。"""
    if candidate is None or is_plan_invalid(candidate):
        return None
    if side_effect_step_ids(original) != side_effect_step_ids(candidate):
        return None
    original_proposals = original.get("side_effect_proposals") or []
    candidate_proposals = candidate.get("side_effect_proposals") or []
    if candidate_proposals and not same_side_effect_proposals(
        original_proposals, candidate_proposals
    ):
        # 任何 side_effect_proposals 字段变化 → 新 plan + 新 approval
        return None
    # 只读 replan：goal/risk 与冻结提案保持不变（plan_hash 稳定，避免误触发新审批）
    candidate = {
        **candidate,
        "goal": original.get("goal"),
        "risk": original.get("risk"),
        "side_effect_proposals": list(original_proposals),
    }
    valid, _errors = validate_plan(candidate)
    if not valid:
        return None
    return candidate


def validate_before_approval(
    plan: dict[str, Any], *, intent_category: str
) -> tuple[bool, list[str]]:
    """验证必须先于审批：非法计划绝不允许进入审批。"""
    valid, errors = validate_plan(plan)
    if not valid:
        return False, errors
    if intent_category == "ACTION" and not has_side_effects(plan):
        return False, ["ACTION plan must contain side-effect steps"]
    proposal_errors = validate_proposals(plan)
    if proposal_errors:
        return False, proposal_errors
    return True, []


async def audit_execution_event(
    *,
    execution_id: str,
    action: str,
    organization_id: Any = None,
    user_id: Any = None,
    details: dict[str, Any] | None = None,
) -> None:
    """执行层审计：plan_invalid / budget_exceeded / side_effect_failure 等。"""
    try:
        async with async_session_factory() as session:
            session.add(
                AuditLog(
                    organization_id=organization_id,
                    user_id=user_id,
                    method="EXEC",
                    path=f"/executions/{execution_id}",
                    status_code=0,
                    action=action,
                    resource_type="execution",
                    resource_id=str(execution_id),
                    details=details or {},
                )
            )
            await session.commit()
    except Exception:
        logger.warning("Failed to persist execution audit: %s", action, exc_info=True)


async def execute_with_gates(
    plan: dict[str, Any],
    *,
    intent_category: str,
    approval: Approval | None = None,
    limits: BudgetLimits | None = None,
    execution_id: str | None = None,
    trace_id: str | None = None,
    run_step: Callable[[dict[str, Any], dict[str, Any]], Awaitable[dict[str, Any]]],
    checkpoint: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    audit: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    replan: (
        Callable[[dict[str, Any], str], Awaitable[dict[str, Any] | None]] | None
    ) = None,
    verify: Callable[[str, dict[str, Any]], Awaitable[str]] | None = None,
) -> ExecutionResult:
    """完整执行闸门。run_step 返回 dict，至少含 status: success|failed。"""
    budget = ExecutionBudget(limits=limits or BudgetLimits())
    span_trace_id = trace_id or execution_id

    async def _audit(action: str, **details: Any) -> None:
        if audit is not None:
            await audit({"action": action, "execution_id": execution_id, **details})
        else:
            await audit_execution_event(
                execution_id=execution_id or "unknown",
                action=action,
                details=details,
            )

    # 1) Plan Validator
    valid, errors = validate_before_approval(plan, intent_category=intent_category)
    if not valid:
        await _audit("plan_invalid", reason="; ".join(errors))
        return ExecutionResult(
            status="plan_invalid",
            plan_invalid=True,
            invalid_reason="; ".join(errors),
        )

    plan_hash = compute_plan_hash(plan)
    side_effects = side_effect_step_ids(plan)
    proposals = plan.get("side_effect_proposals") or []
    requires_approval = intent_category == "ACTION" or bool(side_effects)

    # 2) Approval（验证已通过后才允许）
    if requires_approval:
        if approval is None:
            return ExecutionResult(
                status="approval_required",
                approval_required=True,
                plan_hash=plan_hash,
            )
        if approval.approved is False:
            return ExecutionResult(status="failed", invalid_reason="approval rejected")
        if (
            approval.plan_hash != plan_hash
            or tuple(approval.approved_side_effect_set) != side_effects
            or not approval.approval_id
            or not same_side_effect_proposals(
                tuple(approval.approved_proposals), proposals
            )
        ):
            await _audit(
                "approval_mismatch",
                expected_hash=approval.plan_hash,
                actual_hash=plan_hash,
            )
            return ExecutionResult(
                status="plan_invalid",
                plan_invalid=True,
                invalid_reason="approval does not match plan side-effect set",
            )

    current_plan = plan
    node_outputs: dict[str, Any] = {}
    executed_ids: list[str] = []
    max_active_steps = 0
    active_steps = 0

    while True:
        restart = False
        for step in current_plan["steps"]:
            if step["step_id"] in executed_ids:
                continue
            reason = budget.exceeded()
            if reason is not None:
                hard = has_side_effects(current_plan)
                await _audit(
                    "budget_exceeded",
                    reason=reason,
                    hard=hard,
                    executed_step_ids=list(executed_ids),
                )
                return ExecutionResult(
                    status="budget_exceeded",
                    budget_exceeded=True,
                    hard_stop=hard,
                    plan_hash=plan_hash,
                    partial_result=node_outputs,
                    node_outputs=node_outputs,
                    executed_step_ids=executed_ids,
                )

            active_steps += 1
            max_active_steps = max(max_active_steps, active_steps)
            step_start = time.perf_counter()
            try:
                result = await run_step(step, dict(node_outputs))
            except Exception as exc:  # noqa: BLE001
                result = {"status": "failed", "error": str(exc)}
            finally:
                active_steps -= 1

            status = str(result.get("status") or "failed")
            await record_span(
                trace_id=span_trace_id,
                name="step",
                start=step_start,
                end=time.perf_counter(),
                status="ok" if status == "success" else "error",
                tokens=result.get("tokens"),
                cost=result.get("cost"),
                model=result.get("model"),
                attempt=result.get("attempt"),
                error=result.get("error"),
                details={
                    "step_id": step["step_id"],
                    "capability": step["capability"],
                    "side_effect": bool(step.get("side_effect")),
                },
            )
            if step.get("side_effect") and status != "success":
                audit_action = (
                    "side_effect_unknown"
                    if status == "unknown"
                    else "side_effect_failure"
                )
                await _audit(
                    audit_action,
                    step_id=step["step_id"],
                    capability=step["capability"],
                    error=result.get("error"),
                )
                return ExecutionResult(
                    status="failed",
                    hard_stop=True,
                    invalid_reason=(
                        f"side-effect step {step['step_id']} "
                        f"{'unknown' if status == 'unknown' else 'failed'}"
                    ),
                    plan_hash=plan_hash,
                    partial_result=node_outputs,
                    node_outputs=node_outputs,
                    executed_step_ids=executed_ids,
                )

            if status != "success":
                if budget.replans >= budget.limits.max_replans or replan is None:
                    return ExecutionResult(
                        status="failed",
                        invalid_reason=(
                            f"step {step['step_id']} failed: {result.get('error')}"
                        ),
                        plan_hash=plan_hash,
                        partial_result=node_outputs,
                        node_outputs=node_outputs,
                        executed_step_ids=executed_ids,
                    )
                candidate = await replan(current_plan, str(result.get("error") or ""))
                new_plan = replan_read_only(current_plan, candidate)
                if new_plan is None:
                    await _audit(
                        "replan_rejected",
                        reason="candidate violates read-only replan rules",
                    )
                    return ExecutionResult(
                        status="failed",
                        invalid_reason="replan rejected: must keep side-effect set",
                        plan_hash=plan_hash,
                        partial_result=node_outputs,
                        node_outputs=node_outputs,
                        executed_step_ids=executed_ids,
                    )
                current_plan = new_plan
                budget.replans += 1
                restart = True
                break

            budget.register_step(result)
            if step.get("output_name"):
                node_outputs[str(step["output_name"])] = result.get("data")
            node_outputs.setdefault(step["step_id"], result.get("data"))
            executed_ids.append(step["step_id"])
            if checkpoint is not None:
                await checkpoint(
                    {
                        "step_id": step["step_id"],
                        "executed_step_ids": list(executed_ids),
                        "node_outputs": node_outputs,
                    }
                )
        if restart:
            continue

        # Verify（按 04 策略，位于主循环内以便 replan 后继续）
        if not should_verify(intent_category, current_plan):
            return ExecutionResult(
                status="completed",
                plan_hash=plan_hash,
                final_output=str(node_outputs.get("final_output") or ""),
                node_outputs=node_outputs,
                executed_step_ids=executed_ids,
                replanned=budget.replans > 0,
                max_active_steps=max_active_steps,
            )

        if budget.verifies >= budget.limits.max_verifies:
            # verify ≤1：已 Verify 一次（可能 FAIL 后 replan），不再重复验证
            return ExecutionResult(
                status="completed",
                verify_result="FAIL",
                plan_hash=plan_hash,
                final_output=str(node_outputs.get("final_output") or ""),
                node_outputs=node_outputs,
                executed_step_ids=executed_ids,
                replanned=budget.replans > 0,
                max_active_steps=max_active_steps,
            )

        budget.verifies += 1
        verify_result = "PASS"
        verify_start = time.perf_counter()
        if verify is not None:
            verify_result = await verify(
                str(current_plan.get("goal") or ""), node_outputs
            )
        await record_span(
            trace_id=span_trace_id,
            name="verify",
            start=verify_start,
            end=time.perf_counter(),
            status="ok" if verify_result == "PASS" else "error",
            details={"result": verify_result, "replans": budget.replans},
        )
        if verify_result != "PASS":
            if budget.replans < budget.limits.max_replans and replan is not None:
                candidate = await replan(current_plan, "verify failed")
                new_plan = replan_read_only(current_plan, candidate)
                if new_plan is not None:
                    current_plan = new_plan
                    budget.replans += 1
                    continue  # 重新执行剩余只读步骤，已执行步骤不重跑
            return ExecutionResult(
                status="verify_failed",
                verify_result=verify_result,
                plan_hash=plan_hash,
                partial_result=node_outputs,
                node_outputs=node_outputs,
                executed_step_ids=executed_ids,
            )
        return ExecutionResult(
            status="completed",
            verify_result="PASS",
            plan_hash=plan_hash,
            final_output=str(node_outputs.get("final_output") or ""),
            node_outputs=node_outputs,
            executed_step_ids=executed_ids,
            replanned=budget.replans > 0,
            max_active_steps=max_active_steps,
        )


__all__ = [
    "MAX_SIDE_EFFECT_PARALLELISM",
    "Approval",
    "BudgetLimits",
    "ExecutionBudget",
    "ExecutionResult",
    "PlanInvalidError",
    "audit_execution_event",
    "execute_with_gates",
    "has_side_effects",
    "replan_read_only",
    "should_verify",
    "validate_before_approval",
]
