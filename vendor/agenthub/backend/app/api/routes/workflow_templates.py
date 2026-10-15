from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import CurrentUserDep, SessionDep, get_current_user
from app.models import Workflow
from app.schemas.workflow import WorkflowRead

router = APIRouter(prefix="/workflow-templates", tags=["workflow-templates"])

TEMPLATES = [
    {
        "slug": "weekly-report",
        "name": "周报生成",
        "description": "汇总本周工作，生成结构化周报",
        "nodes": [
            {"id": "n1", "type": "research", "label": "Research Agent"},
            {"id": "n2", "type": "analyze", "label": "Analyze Agent"},
            {"id": "n3", "type": "execute", "label": "Execute Agent"},
        ],
        "edges": [{"source": "n1", "target": "n2"}, {"source": "n2", "target": "n3"}],
    },
    {
        "slug": "competitor-research",
        "name": "竞品调研",
        "description": "调研竞品特性并输出对比报告",
        "nodes": [
            {"id": "n1", "type": "research", "label": "Research Agent"},
            {"id": "n2", "type": "analyze", "label": "Analyze Agent"},
        ],
        "edges": [{"source": "n1", "target": "n2"}],
    },
    {
        "slug": "email-reply",
        "name": "客户邮件自动回复",
        "description": "根据客户邮件内容生成专业回复",
        "nodes": [
            {"id": "n1", "type": "research", "label": "Research Agent"},
            {"id": "n2", "type": "execute", "label": "Execute Agent"},
        ],
        "edges": [{"source": "n1", "target": "n2"}],
    },
    {
        "slug": "lead-scoring",
        "name": "销售线索筛选",
        "description": "对销售线索进行打分与筛选",
        "nodes": [
            {"id": "n1", "type": "research", "label": "Research Agent"},
            {"id": "n2", "type": "analyze", "label": "Analyze Agent"},
            {"id": "n3", "type": "execute", "label": "Execute Agent"},
        ],
        "edges": [{"source": "n1", "target": "n2"}, {"source": "n2", "target": "n3"}],
    },
    {
        "slug": "contract-summary",
        "name": "合同摘要",
        "description": "提取合同关键条款并生成摘要",
        "nodes": [
            {"id": "n1", "type": "research", "label": "Research Agent"},
            {"id": "n2", "type": "analyze", "label": "Analyze Agent"},
        ],
        "edges": [{"source": "n1", "target": "n2"}],
    },
]


@router.get("")
async def list_templates(user: CurrentUserDep) -> list[dict]:
    return TEMPLATES


@router.post(
    "/{slug}/clone",
    response_model=WorkflowRead,
    dependencies=[Depends(get_current_user)],
)
async def clone_template(
    slug: str, session: SessionDep, user: CurrentUserDep
) -> Workflow:
    template = next((t for t in TEMPLATES if t["slug"] == slug), None)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    workflow = Workflow(
        name=template["name"],
        description=template["description"],
        agent_chain=[node["id"] for node in template["nodes"]],
        dag_definition={"nodes": template["nodes"], "edges": template["edges"]},
        created_by="template",
        organization_id=user.organization_id,
    )
    session.add(workflow)
    await session.commit()
    return workflow
