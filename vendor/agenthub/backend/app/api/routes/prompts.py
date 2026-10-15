from __future__ import annotations

from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.api.deps import CurrentUserDep
from app.core.model_gateway import ModelGateway

router = APIRouter(prefix="/prompts", tags=["prompts"])

OPTIMIZE_SYSTEM = (
    "你是提示词优化助手。保持用户原意与语言，输出一个更清晰、更具体、"
    "更易于执行的版本。只输出优化后的文本，不要任何解释。"
)


class PromptOptimizeRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=8000)


@router.post("/optimize")
async def optimize_prompt(
    payload: PromptOptimizeRequest,
    user: CurrentUserDep,
) -> dict:
    try:
        gateway = ModelGateway()
        llms = await gateway.select(
            organization_id=user.organization_id,
            complexity="simple",
            user_id=user.id,
        )
        response = await gateway.invoke(
            llms,
            [
                SystemMessage(content=OPTIMIZE_SYSTEM),
                HumanMessage(content=payload.content),
            ],
            task_type="prompt_optimize",
            organization_id=user.organization_id,
        )
        optimized = str(getattr(response, "content", "")).strip()
        if not optimized:
            raise ValueError("empty optimization result")
        return {"optimized": optimized}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"提示词优化失败：{exc}") from exc
