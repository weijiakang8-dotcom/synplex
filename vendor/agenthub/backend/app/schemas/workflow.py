import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import WorkflowStatus
from app.schemas.agent import AgentRead


class WorkflowBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    agent_chain: list = Field(default_factory=list)
    dag_definition: dict | None = None
    status: WorkflowStatus = WorkflowStatus.DRAFT
    created_by: str = Field(..., min_length=1, max_length=255)


class WorkflowCreate(WorkflowBase):
    pass


class WorkflowUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    agent_chain: list | None = None
    status: WorkflowStatus | None = None
    created_by: str | None = Field(None, min_length=1, max_length=255)
    dag_definition: dict | None = None


class WorkflowRead(WorkflowBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class WorkflowDetail(WorkflowRead):
    agents: list[AgentRead] = Field(default_factory=list)
