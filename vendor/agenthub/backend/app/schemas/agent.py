import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import AgentStatus


class AgentBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str = Field("", max_length=500)
    system_prompt: str = ""
    tools: list = Field(default_factory=list)
    status: AgentStatus = AgentStatus.ACTIVE


class AgentCreate(AgentBase):
    pass


class AgentUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = Field(None, max_length=500)
    system_prompt: str | None = None
    tools: list | None = None
    status: AgentStatus | None = None


class AgentRead(AgentBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime
