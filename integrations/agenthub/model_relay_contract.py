"""Strict service request schema, loaded only by the execution API."""
import uuid
from pydantic import BaseModel, ConfigDict, Field


class RelayBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol: str
    grantId: uuid.UUID
    endpoint: str = Field(max_length=500)
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$", repr=False)
    model: str = Field(min_length=1, max_length=160)
    effort: str | None = Field(default=None, max_length=32)
    apiMode: str
    maxOutputTokens: int = Field(strict=True, ge=16, le=32768)
    contextWindow: int = Field(strict=True, ge=1024, le=2000000)
