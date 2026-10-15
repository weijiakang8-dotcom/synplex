import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.core.permissions import require_permission
from app.models import Agent
from app.models.enums import AgentStatus
from app.schemas.agent import AgentCreate, AgentRead, AgentUpdate

router = APIRouter(prefix="/agents", tags=["agents"])


class AgentRunRequest(BaseModel):
    user_input: str = Field(min_length=1, max_length=50000)


@router.post(
    "/{agent_id}/run",
    status_code=202,
    dependencies=[Depends(require_permission("executions:write"))],
)
async def run_agent(
    agent_id: uuid.UUID,
    payload: AgentRunRequest,
    session: SessionDep,
    user: CurrentUserDep,
):
    from app.engine.outbox import enqueue_outbox_event
    from app.models import Execution, Workflow

    agent = await session.get(Agent, agent_id)
    if (
        not agent
        or agent.organization_id != user.organization_id
        or agent.status != AgentStatus.ACTIVE
    ):
        raise HTTPException(404, "Agent not found")
    workflow = Workflow(
        name=f"Agent: {agent.name}",
        description="Custom agent run",
        agent_chain=[str(agent.id)],
        created_by=str(user.id),
        organization_id=user.organization_id,
    )
    session.add(workflow)
    await session.flush()
    execution = Execution(
        workflow_id=workflow.id,
        user_input=payload.user_input,
        organization_id=user.organization_id,
        user_id=user.id,
    )
    session.add(execution)
    await session.flush()
    await enqueue_outbox_event(
        session,
        "execute_workflow",
        {"execution_id": str(execution.id)},
        execution_id=execution.id,
    )
    await session.commit()
    return {"execution_id": str(execution.id), "status": "pending"}


@router.get("", response_model=list[AgentRead])
async def list_agents(
    session: SessionDep,
    user: CurrentUserDep,
    status: AgentStatus | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[Agent]:
    stmt = select(Agent)
    stmt = stmt.where(Agent.organization_id == user.organization_id)
    if status is not None:
        stmt = stmt.where(Agent.status == status)
    stmt = stmt.order_by(Agent.created_at.desc()).offset(skip).limit(limit)
    result = await session.execute(stmt)
    return list(result.scalars().all())


@router.get("/{agent_id}", response_model=AgentRead)
async def get_agent(
    agent_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> Agent:
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.organization_id != user.organization_id:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.post(
    "",
    response_model=AgentRead,
    status_code=201,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def create_agent(
    payload: AgentCreate, session: SessionDep, user: CurrentUserDep
) -> Agent:
    from app.agents.resources import create_agent_resource

    return await create_agent_resource(session, payload, user.organization_id)


@router.put(
    "/{agent_id}",
    response_model=AgentRead,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def update_agent(
    agent_id: uuid.UUID, payload: AgentUpdate, session: SessionDep, user: CurrentUserDep
) -> Agent:
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.organization_id != user.organization_id:
        raise HTTPException(status_code=404, detail="Agent not found")

    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        dup = await session.execute(
            select(Agent).where(
                Agent.name == data["name"],
                Agent.id != agent_id,
                Agent.organization_id == user.organization_id,
            )
        )
        if dup.scalar_one_or_none() is not None:
            raise HTTPException(status_code=409, detail="Agent name already exists")

    for key, value in data.items():
        setattr(agent, key, value)

    await session.commit()
    await session.refresh(agent)
    return agent


@router.delete(
    "/{agent_id}",
    status_code=204,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def delete_agent(
    agent_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> None:
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.organization_id != user.organization_id:
        raise HTTPException(status_code=404, detail="Agent not found")

    agent.status = AgentStatus.INACTIVE
    await session.commit()
