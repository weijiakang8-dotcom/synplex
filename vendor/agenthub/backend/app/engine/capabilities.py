"""能力目录：角色与能力解耦（Frozen Core 扩展点）。

Planner 从 CAPABILITIES 中选择能力组成执行图；新增能力只需在目录注册，
不修改图结构。能力是可复用单元，不再与固定 Agent 岗位绑定。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.engine.delivery_tools import (
    create_agent,
    export_document,
    get_agent,
    report_blocker,
)
from app.engine.tools import (
    query_db,
    recall_executions,
    recall_memory,
    search_knowledge,
    search_web,
    send_email,
)

RESPONSE_FORMAT_PROMPT = (
    "请使用清晰、自然的 Markdown 排版：正文用短段落，复杂内容使用简短标题和列表；"
    "代码必须放在带语言标识的三反引号代码块中。不要把整段回答包在引号、JSON 字符串或代码块里，"
    "不要输出原始 HTML，也不要为了排版添加多余空行。"
)


@dataclass(frozen=True)
class Capability:
    name: str
    description: str
    tools: tuple = field(default_factory=tuple)
    system_prompt: str = ""
    inject_knowledge: bool = False
    # Registry 静态声明：Planner/Executor 不得伪造
    side_effect: bool = False
    requires_approval: bool = False
    worker: bool = False


CAPABILITIES: dict[str, Capability] = {
    "general": Capability(
        name="general",
        description="通用只读任务：循环调用可用工具；缺能力时说明条件与可完成部分",
        tools=(
            search_web,
            search_knowledge,
            query_db,
            recall_memory,
            recall_executions,
            get_agent,
            export_document,
            report_blocker,
        ),
        system_prompt="你是通用任务执行智能体。以用户所需成果为验收标准，按需使用专业子智能体。",
        worker=True,
    ),
    "writing": Capability(
        name="writing",
        description="根据资料撰写长文、报告、论文草稿并整理",
        tools=(search_web, search_knowledge, export_document, report_blocker),
        system_prompt="你是写作智能体，按要求组织文稿与引用，缺原始研究数据时明确说明。",
        worker=True,
    ),
    "document": Capability(
        name="document",
        description="将前置完整文稿导出可下载 PDF/DOCX/Markdown 文件",
        tools=(export_document, report_blocker),
        system_prompt="你是文档智能体，将提供的完整文稿用 export_document 导出；不要只提供导出教程或删减源稿。最终返回工具提供的下载入口。",
        worker=True,
    ),
    "agent_builder": Capability(
        name="agent_builder",
        description="创建保存可运行自定义 Agent（审批）；只能配置已注册工具",
        tools=(create_agent,),
        system_prompt="根据用户要求编写并保存专业 Agent 的提示词与工具白名单。工具名必须来自现有目录；没有业务连接时如实写入配置限制，不要承诺已接入订单系统。条件型政策要明确边界；缺少精确时间、金额、状态等判断条件时必须询问或给分支，不能把明天等相对日期直接判定为24小时内。缺外部联络通道时引导用户联系，不得写入已通知或已转达的虚假承诺。",
        side_effect=True,
        requires_approval=True,
    ),
    "agent_inspect": Capability(
        name="agent_inspect",
        description="查询确认已创建 Agent 的配置与运行入口",
        tools=(get_agent,),
        system_prompt="查询并展示保存的 Agent 配置与运行入口。",
    ),
    "answer": Capability(
        name="answer",
        description="直接回答用户问题，不调用任何工具",
        system_prompt="你是 AgentHub 的执行智能体，请直接、准确、简洁地回答。",
    ),
    "research": Capability(
        name="research",
        description="搜索网络获取信息",
        tools=(search_web,),
        system_prompt=(
            "你是研究智能体。如果上下文已提供【联网搜索结果】，直接基于这些"
            "证据总结回答；否则使用 search_web 检索网络。回答注明关键来源"
            "（标题与链接）；搜索失败时如实说明，并基于已有知识回答，不要编造结果。"
        ),
    ),
    "web_search": Capability(
        name="web_search",
        description="只执行网络搜索",
        tools=(search_web,),
        system_prompt=(
            "你是搜索智能体。如果上下文已提供【联网搜索结果】，直接整理摘要；"
            "否则使用 search_web 检索。输出摘要时保留来源（标题与链接），"
            "搜索失败时如实说明，不编造结果。"
        ),
    ),
    "knowledge": Capability(
        name="knowledge",
        description="基于知识库资料回答",
        inject_knowledge=True,
        system_prompt="你是知识助手，优先依据提供的知识库资料回答，资料不足时明说。",
    ),
    "search_knowledge": Capability(
        name="search_knowledge",
        description="检索当前租户知识库（RAG）",
        tools=(search_knowledge,),
        system_prompt=(
            "你是知识库检索智能体。使用 search_knowledge 检索当前租户文档，"
            "只依据返回的片段回答并标注文档来源；检索无结果时如实说明，"
            "不要编造文档内容。"
        ),
    ),
    "recall": Capability(
        name="recall",
        description="检索用户长期记忆与历史执行记录",
        tools=(recall_memory, recall_executions),
        system_prompt=(
            "你是记忆检索智能体。使用 recall_memory 检索用户长期记忆，"
            "使用 recall_executions 检索最近完成的历史执行；只把检索结果当作"
            "参考证据，检索无结果时如实说明，不要编造记忆或历史。"
        ),
    ),
    "query_db": Capability(
        name="query_db",
        description="查询 AgentHub 数据库（只读 SELECT）",
        tools=(query_db,),
        system_prompt=(
            "你是数据分析智能体。使用 query_db 执行单表只读 SELECT，"
            "服务端会自动按当前租户过滤数据。禁止写操作、JOIN、子查询、"
            "ORDER BY/GROUP BY、PRAGMA 等写法；统计查询允许 COUNT(*)/COUNT(列)/"
            "SUM(列)/AVG(列)/MIN(列)/MAX(列)（仍为单表只读）。"
            "常用表与列：executions(status, user_input, final_output, "
            "error_message, created_at, updated_at)、"
            "tool_calls(tool_name, status, execution_id, created_at)、"
            "workflows(name, description, status, created_at)、"
            "documents(name, content)、agents(name, description, status)。"
            "状态取值为 pending/running/waiting_for_approval/completed/failed/"
            "rolled_back。示例查询：SELECT status, created_at FROM executions "
            "LIMIT 10；统计示例：SELECT COUNT(*) FROM executions。查询失败时直接"
            "向用户说明失败原因与限制，不要尝试 sqlite_master 或 PRAGMA 等其它"
            "数据库的写法。"
        ),
    ),
    "analysis": Capability(
        name="analysis",
        description="对已有信息进行分析、推理、总结",
        system_prompt="你是分析智能体，对给定材料进行结构化分析和推理。",
    ),
    "execute": Capability(
        name="execute",
        description="执行需要数据库或邮件等副作用的能力",
        tools=(query_db, send_email),
        system_prompt=(
            "你是执行智能体，谨慎使用工具完成用户指令；副作用操作需要审批。"
            "涉及外部事实时以【联网搜索结果】为证据，不要编造；"
            "内部业务数据以 query_db 结果为准。"
        ),
        side_effect=True,
        requires_approval=True,
    ),
    "send_email": Capability(
        name="send_email",
        description="发送邮件（需要人工审批）",
        tools=(send_email,),
        system_prompt=(
            "你是邮件智能体。发送前请确认收件人、主题与正文；正文涉及最新外部"
            "信息时，必须依据【联网搜索结果】等已提供证据撰写，可标注来源；"
            "不要编造外部事实、日期或数据。"
        ),
        side_effect=True,
        requires_approval=True,
    ),
}

APPROVAL_REQUIRED_TOOLS = frozenset({"send_email", "create_agent"})


def capability_for(step: dict[str, Any]) -> Capability | None:
    name = str(step.get("capability") or step.get("name") or "")
    return CAPABILITIES.get(name)


__all__ = [
    "APPROVAL_REQUIRED_TOOLS",
    "CAPABILITIES",
    "Capability",
    "capability_for",
]
