from fastapi import APIRouter

from app.api.routes import (
    agent_center,
    agents,
    alert_rules,
    alerts,
    artifacts,
    audit_logs,
    auth,
    conversations,
    dispatch,
    documents,
    executions,
    feedback,
    memories,
    models,
    notifications,
    organizations,
    prompts,
    quotas,
    shadow_audit,
    skills,
    synplex,
    tasks,
    tool_calls,
    tools,
    usage,
    user_api_keys,
    workflow_templates,
    workflows,
)
from app.api.routes import (
    eval as eval_routes,
)
from app.mcp import server as mcp_routes

api_router = APIRouter(prefix="/api")
api_router.include_router(agents.router)
api_router.include_router(artifacts.router)
api_router.include_router(agent_center.router)
api_router.include_router(workflows.router)
api_router.include_router(executions.router)
api_router.include_router(feedback.router)
api_router.include_router(tool_calls.router)
api_router.include_router(tools.router)
api_router.include_router(alerts.router)
api_router.include_router(alert_rules.router)
api_router.include_router(audit_logs.router)
api_router.include_router(auth.router)
api_router.include_router(conversations.router)
api_router.include_router(documents.router)
api_router.include_router(eval_routes.router)
api_router.include_router(models.router)
api_router.include_router(memories.router)
api_router.include_router(notifications.router)
api_router.include_router(organizations.router)
api_router.include_router(prompts.router)
api_router.include_router(quotas.router)
api_router.include_router(shadow_audit.router)
api_router.include_router(skills.router)
api_router.include_router(user_api_keys.router)
api_router.include_router(usage.router)
api_router.include_router(tasks.router)
api_router.include_router(synplex.router)
api_router.include_router(workflow_templates.router)
api_router.include_router(dispatch.router)
api_router.include_router(mcp_routes.router)


__all__ = ["api_router"]
