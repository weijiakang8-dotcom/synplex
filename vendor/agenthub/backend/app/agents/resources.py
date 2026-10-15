"""Shared resource service for API and approved agent tools."""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import Agent
from app.schemas.agent import AgentCreate


async def create_agent_resource(session, payload: AgentCreate, organization_id):
    existing = (
        await session.execute(
            select(Agent).where(
                Agent.name == payload.name, Agent.organization_id == organization_id
            )
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "Agent name already exists")
    agent = Agent(**payload.model_dump(), organization_id=organization_id)
    session.add(agent)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        # The legacy global name constraint must not disclose another tenant.
        raise HTTPException(
            409, "Agent name unavailable; choose another name"
        ) from None
    await session.refresh(agent)
    return agent


async def load_specialist(agent_id, organization_id):
    import uuid

    from app.database import async_session_factory
    from app.models.enums import AgentStatus

    async with async_session_factory() as session:
        agent = await session.get(Agent, uuid.UUID(str(agent_id)))
        if (
            not agent
            or str(agent.organization_id or "") != str(organization_id or "")
            or agent.status != AgentStatus.ACTIVE
        ):
            raise PermissionError("Specialist agent unavailable for tenant")
        return {
            "agent_id": str(agent.id),
            "system_prompt": agent.system_prompt,
            "tools": agent.tools,
            "name": agent.name,
        }
