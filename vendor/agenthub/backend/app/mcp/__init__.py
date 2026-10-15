"""AgentHub MCP（Model Context Protocol）服务器。

把平台"调度中心"的能力以 MCP 工具的形式暴露给外部 AI 客户端
（Claude / Codex / ChatGPT 桌面等），让外部助手把 AgentHub 当插件调用。
"""

from app.mcp.server import router

__all__ = ["router"]
