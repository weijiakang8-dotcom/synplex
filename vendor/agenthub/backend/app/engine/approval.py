"""Phase 6A Frozen Contract：Approval 参数冻结（Pro FINAL DECISION = C）。

审批载荷：
{plan_hash, approval_id, side_effect_proposals:[{step_id, capability, tool, params, params_canonical}]}

执行必须与冻结提案完全一致；任何不一致 → approval_mismatch → audit → FAILED → 新审批。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from app.engine import canonical
from app.engine.canonical import params_canonical
from app.engine.capabilities import CAPABILITIES
from app.engine.planner import compute_plan_hash, side_effect_step_ids


class ProposalInvalidError(RuntimeError):
    """副作用提案非法（0 次 / 多次调用 / tool 或参数不符合 schema）。"""


@dataclass(frozen=True)
class SideEffectProposal:
    step_id: str
    capability: str
    tool: str
    params: dict[str, Any] = field(default_factory=dict)
    params_canonical: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "step_id": self.step_id,
            "capability": self.capability,
            "tool": self.tool,
            "params": self.params,
            "params_canonical": self.params_canonical,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> SideEffectProposal:
        return cls(
            step_id=str(raw.get("step_id") or ""),
            capability=str(raw.get("capability") or ""),
            tool=str(raw.get("tool") or ""),
            params=dict(raw.get("params") or {}),
            params_canonical=str(raw.get("params_canonical") or ""),
        )


def build_proposal(
    *,
    step_id: str,
    capability: str,
    tool: str,
    params: dict[str, Any],
) -> SideEffectProposal:
    schema_errors = canonical.validate_tool_params(tool, params)
    if schema_errors:
        raise ProposalInvalidError(f"{step_id}: {'; '.join(schema_errors)}")
    return SideEffectProposal(
        step_id=step_id,
        capability=capability,
        tool=tool,
        params=params,
        params_canonical=canonical.params_canonical(params, tool_name=tool),
    )


def proposals_from_plan(plan: dict[str, Any]) -> list[SideEffectProposal]:
    raw_proposals = plan.get("side_effect_proposals") or []
    return [SideEffectProposal.from_dict(item) for item in raw_proposals]


def proposals_to_dicts(proposals: list[SideEffectProposal]) -> list[dict[str, Any]]:
    return [proposal.to_dict() for proposal in proposals]


def same_side_effect_proposals(
    left: list[dict[str, Any]] | tuple[dict[str, Any], ...],
    right: list[dict[str, Any]] | tuple[dict[str, Any], ...],
) -> bool:
    def fingerprint(proposal: dict[str, Any]) -> tuple[str, str, str]:
        return (
            str(proposal.get("step_id") or ""),
            str(proposal.get("tool") or ""),
            str(proposal.get("params_canonical") or ""),
        )

    left_set = {fingerprint(item) for item in (left or [])}
    right_set = {fingerprint(item) for item in (right or [])}
    return left_set == right_set and len(left_set) == len(left or []) == len(
        right or []
    )


def proposal_mismatch_reason(
    proposal: dict[str, Any],
    tool: str,
    params: dict[str, Any],
) -> str | None:
    """执行参数与冻结提案不一致时返回原因，否则 None。"""
    if str(proposal.get("tool") or "") != tool:
        return f"tool mismatch: frozen={proposal.get('tool')} actual={tool}"
    if not canonical.tool_params_match(
        str(proposal.get("params_canonical") or ""), tool, params
    ):
        return f"params mismatch for step {proposal.get('step_id')}"
    return None


def validate_proposals(plan: dict[str, Any]) -> list[str]:
    """每个 side_effect step 恰好一个提案；tool 必须属于该能力；提案自洽。"""
    errors: list[str] = []
    proposals = proposals_from_plan(plan)
    by_step: dict[str, list[SideEffectProposal]] = {}
    for proposal in proposals:
        by_step.setdefault(proposal.step_id, []).append(proposal)
    for step in plan.get("steps") or []:
        if not bool(step.get("side_effect")):
            continue
        step_id = str(step.get("step_id") or "")
        step_proposals = by_step.get(step_id, [])
        if len(step_proposals) != 1:
            errors.append(f"side-effect step {step_id} must have exactly one proposal")
            continue
        proposal = step_proposals[0]
        capability = CAPABILITIES.get(step.get("capability") or "")
        if capability is None:
            errors.append(f"unknown capability {step.get('capability')}")
            continue
        tool_names = {getattr(tool, "name", "") for tool in capability.tools}
        if proposal.tool not in tool_names:
            errors.append(
                f"proposal tool {proposal.tool} not in capability {capability.name}"
            )
        expected = canonical.params_canonical(proposal.params, tool_name=proposal.tool)
        if proposal.params_canonical != expected:
            errors.append(f"proposal {step_id} params_canonical is not self-consistent")
    for step_id in by_step:
        if not any(
            bool(step.get("side_effect")) and str(step.get("step_id") or "") == step_id
            for step in plan.get("steps") or []
        ):
            errors.append(f"proposal for non-side-effect step {step_id}")
    return errors


def resume_approval_decision(decision: dict[str, Any]) -> tuple[bool, str]:
    """resume 决策：只有 approved=true 且计划未修改才放行。"""
    if not isinstance(decision, dict):
        return False, "invalid resume decision"
    if decision.get("approved") is not True:
        return False, "explicit approval required"
    if decision.get("comment"):
        return False, "approval_mismatch: modified_plan requires new approval"
    return True, ""


def build_approval_payload(
    plan: dict[str, Any],
    *,
    approval_id: str | None = None,
) -> dict[str, Any]:
    return {
        "plan_hash": compute_plan_hash(plan),
        "approval_id": approval_id or uuid.uuid4().hex,
        "side_effect_set": list(side_effect_step_ids(plan)),
        "side_effect_proposals": proposals_to_dicts(proposals_from_plan(plan)),
    }


__all__ = [
    "ProposalInvalidError",
    "SideEffectProposal",
    "build_approval_payload",
    "build_proposal",
    "params_canonical",
    "proposal_mismatch_reason",
    "proposals_from_plan",
    "proposals_to_dicts",
    "resume_approval_decision",
    "same_side_effect_proposals",
    "validate_proposals",
]
