from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class LegacyToolCall(BaseModel):
    model_config = ConfigDict(frozen=True)

    tool_name: str
    input_params: dict[str, Any] = Field(default_factory=dict)
    output_result: dict[str, Any] | None = None
    status: str = "success"


class LegacyAgent(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    system_prompt: str = ""
    tools: list[str] = Field(default_factory=list)


class LegacyWorkflow(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    agent_chain: list[str] = Field(default_factory=list)
    dag_definition: dict[str, Any] | None = None


class LegacyExecution(BaseModel):
    """Legacy Execution 数据的轻量只读投影，不依赖 SQLAlchemy/DB。"""

    model_config = ConfigDict(frozen=True)

    execution_id: str
    workflow: LegacyWorkflow
    user_input: str
    final_output: str | None = None
    status: str = "completed"
    tool_calls: list[LegacyToolCall] = Field(default_factory=list)
    messages: list[dict[str, Any]] = Field(default_factory=list)


__all__ = ["LegacyAgent", "LegacyExecution", "LegacyToolCall", "LegacyWorkflow"]
