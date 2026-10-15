import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import ExecutionStatus
from app.schemas.tool_call import ToolCallRead, ToolCallSummary


class ExecutionCreate(BaseModel):
    workflow_id: uuid.UUID
    user_input: str = Field(..., min_length=1)


class ExecutionUpdate(BaseModel):
    status: ExecutionStatus | None = None
    current_step_index: int | None = None
    checkpoint_data: dict | None = None
    final_output: str | None = None
    error_message: str | None = None
    completed_at: datetime | None = None


class ExecutionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workflow_id: uuid.UUID
    status: ExecutionStatus
    current_step_index: int
    checkpoint_data: dict | None
    user_input: str
    final_output: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    eval_score: float | None = None
    eval_details: dict | None = None
    feedback: str | None = None
    intent: dict | None = None
    plan: dict | None = None
    steps: list | None = None
    model_used: list | None = None
    token_usage: dict | None = None


class ExecutionDetail(ExecutionRead):
    tool_calls: list[ToolCallRead] = Field(default_factory=list)


class ExecutionTrace(BaseModel):
    current_step_index: int
    status: ExecutionStatus
    tool_calls: list[ToolCallSummary]
    cost: float | None = None
    token_usage: dict | None = None
    model_used: list | None = None
    verify_status: str | None = None
    approval_mismatch_count: int = 0
    side_effect_proposals: list | None = None
    spans: list["SpanSummary"] = Field(default_factory=list)


class SpanSummary(BaseModel):
    span: str
    status: str
    latency_ms: float | None = None
    model: str | None = None
    tokens: int | None = None
    cost: float | None = None
    error: str | None = None
    recorded_at: str | None = None


class ExecutionAccepted(BaseModel):
    execution_id: uuid.UUID
    status: ExecutionStatus


class ExecutionResume(BaseModel):
    approved: bool = True
    comment: str | None = None


class FeedbackCreate(BaseModel):
    feedback: str = Field(..., min_length=1)
    rating: int | None = Field(None, ge=1, le=5)
    comment: str | None = None
