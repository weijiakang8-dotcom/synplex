"""Provision scoped execution identities using AgentHub's Organization/User/
Agent/Workflow models. Only the original private operator can provision; tenant
requests can use only the exact registered identity. No provider calls here.
"""
import secrets
import uuid
from sqlalchemy import text

CREATE_TABLE = """CREATE TABLE IF NOT EXISTS synplex_engine_tenants (
 tenant_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL UNIQUE,
 user_id TEXT NOT NULL UNIQUE, workflow_id TEXT NOT NULL UNIQUE,
 agent_id TEXT NOT NULL UNIQUE)"""


async def initialize(engine):
    async with engine.begin() as connection:
        await connection.execute(text(CREATE_TABLE))


async def identity(session, data, user_id, organization_id):
    if str(user_id) == data["user_id"] and str(organization_id) == data["organization_id"]:
        return data
    if data.get("model_mode") != "relay":
        return None
    result = await session.execute(text("SELECT * FROM synplex_engine_tenants WHERE user_id=:u AND organization_id=:o"),
                                   {"u": str(user_id), "o": str(organization_id)})
    row = result.mappings().first()
    return {**data, **dict(row)} if row else None


async def execution_identity(session, data, execution):
    if execution is None:
        return None
    value = await identity(session, data, execution.user_id, execution.organization_id)
    return value if value and str(execution.workflow_id) == value["workflow_id"] else None


def install_api(app, data):
    from fastapi import APIRouter, HTTPException
    from app.api.deps import SessionDep, CurrentUserDep
    from app.models import Organization, User, Agent, Workflow
    from app.models.enums import AgentStatus, WorkflowStatus
    from app.core.security import hash_password, create_access_token
    router = APIRouter()

    @router.post("/api/synplex/tenants/{tenant_id}")
    async def provision(tenant_id: uuid.UUID, session: SessionDep, user: CurrentUserDep):
        if (str(user.id) != data["user_id"] or str(user.organization_id) != data["organization_id"]
                or data.get("model_mode") != "relay" or not user.is_active):
            raise HTTPException(404, "Connection not found")
        # Serialize this identity only, including concurrent first-time requests.
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": tenant_id.int % (2**63-1)})
        values = {"tenant_id": str(tenant_id), **{key: str(uuid.uuid5(tenant_id, key)) for key in
                 ("organization_id", "user_id", "workflow_id", "agent_id")}}
        old = (await session.execute(text("SELECT * FROM synplex_engine_tenants WHERE tenant_id=:tenant_id"), values)).mappings().first()
        if old and dict(old) != values:
            raise HTTPException(409, "Tenant identity differs")
        if not old:
            root = await session.get(Agent, uuid.UUID(data["agent_id"]))
            if root is None:
                raise HTTPException(503, "Engine template unavailable")
            oid, uid = uuid.UUID(values["organization_id"]), uuid.UUID(values["user_id"])
            session.add(Organization(id=oid, name="Synplex工作台", slug="synplex-"+tenant_id.hex, settings={}))
            await session.flush()
            session.add(User(id=uid, organization_id=oid, email=tenant_id.hex+"@synplex.invalid",
                             password_hash=hash_password(secrets.token_hex(32)), full_name="工作台用户", role="member"))
            session.add(Agent(id=uuid.UUID(values["agent_id"]), organization_id=oid,
                              name="synplex-"+tenant_id.hex, system_prompt=root.system_prompt,
                              tools=list(root.tools or []), status=AgentStatus.ACTIVE))
            session.add(Workflow(id=uuid.UUID(values["workflow_id"]), organization_id=oid,
                                 name="项目交付", created_by=str(uid), agent_chain=[], status=WorkflowStatus.ACTIVE))
            await session.flush()
            await session.execute(text("INSERT INTO synplex_engine_tenants VALUES (:tenant_id,:organization_id,:user_id,:workflow_id,:agent_id)"), values)
        else:
            member = await session.get(User, uuid.UUID(values["user_id"]))
            workflow = await session.get(Workflow, uuid.UUID(values["workflow_id"]))
            if (not member or not member.is_active or str(member.organization_id) != values["organization_id"]
                    or not workflow or str(workflow.organization_id) != values["organization_id"]
                    or str(workflow.created_by) != values["user_id"]):
                raise HTTPException(409, "Tenant records need reconciliation")
        await session.commit()
        return {"protocol": "synplex.engine-tenant/1", **values,
                "token": create_access_token(values["user_id"], values["organization_id"])}
    app.include_router(router)
