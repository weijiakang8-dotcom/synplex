import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import ToolCallStatus


class ToolCallBase(BaseModel):
    execution_id: uuid.UUID
    tool_name: str = Field(..., min_length=1, max_length=255)
    input_params: dict = Field(default_factory=dict)
    output_result: dict | None = None
    status: ToolCallStatus = ToolCallStatus.PENDING
    requires_approval: bool = False
    approved_by: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class ToolCallCreate(ToolCallBase):
    pass


class ToolCallUpdate(BaseModel):
    output_result: dict | None = None
    status: ToolCallStatus | None = None
    requires_approval: bool | None = None
    approved_by: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class ToolCallRead(ToolCallBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID


class ToolCallSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tool_name: str
    status: ToolCallStatus
    requires_approval: bool
    approved_by: str | None
    started_at: datetime | None
    completed_at: datetime | None
    input_params: dict | None = None
    output_result: dict | None = None
