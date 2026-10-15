"""Export an explicit upstream manuscript once, without paying a model to copy it."""

from __future__ import annotations

import asyncio
import re
import uuid

from app.artifacts.service import artifact_path, verify_artifact
from app.database import async_session_factory
from app.engine import tool_executor
from app.engine.step_context import INPUT_REFS, step_messages
from app.models.artifact import Artifact


async def export_existing_manuscript(state, step):
    # Validate exact dependencies before looking up any material.
    step_messages(state, step)
    outputs = state.get("node_outputs") or {}
    refs = step.get("input_refs") or step.get("depends_on") or []
    values = [outputs[r] for r in refs if r not in INPUT_REFS and r in outputs]
    # Multi-source synthesis, user-only input and empty drafts still need a writer.
    if len(values) != 1 or not isinstance(values[0], str) or not values[0].strip():
        return None
    content = values[0]
    title = step.get("document_title")
    for ref in refs:
        artifacts = (state.get("step_artifacts") or {}).get(ref) or []
        sources = [a for a in artifacts if a.get("format") == "md"]
        if len(sources) > 1:
            return None  # Do not guess between divergent drafts.
        if sources:
            async with async_session_factory() as session:
                row = await session.get(Artifact, uuid.UUID(sources[0]["id"]))
                if (
                    not row
                    or str(row.execution_id) != str(state.get("execution_id"))
                    or str(row.user_id) != str(state.get("user_id"))
                    or str(row.organization_id) != str(state.get("organization_id"))
                    or not await asyncio.to_thread(verify_artifact, row)
                ):
                    raise PermissionError(
                        "Upstream artifact identity or integrity mismatch"
                    )
                content = await asyncio.to_thread(artifact_path(row).read_text)
                title = title or row.filename.rsplit(".", 1)[0]
            break
    heading = re.search(r"^#{1,3}\s+(.+)$", content, re.MULTILINE)
    title = title or (heading[1] if heading else step.get("output_name") or "任务文稿")
    formats = step.get("artifact_formats") or ["pdf"]
    artifacts, blockers = [], []
    for fmt in dict.fromkeys(formats):
        if fmt == "md" and any(a["format"] == "md" for a in artifacts):
            continue
        result = await tool_executor.execute_tool(
            "export_document",
            {"title": title, "content": content, "format": fmt},
            state["execution_id"],
            user_id=state.get("user_id"),
        )
        data = result.get("data") or {}
        if result.get("status") in {"success", "duplicate"} and data.get("verified"):
            artifacts.append(data)
            if data.get("source_artifact"):
                artifacts.append(data["source_artifact"])
        else:
            blockers.append(
                {
                    "code": "export",
                    "reason": "文稿已保留，但文件导出未成功。",
                    "next_actions": ["检查文档服务与存储后续接导出。"],
                }
            )
    output = "已按完整前置文稿导出：\n" + "\n".join(
        f"- [{a['filename']}]({a['download_url']})" for a in artifacts
    )
    return {
        "output": output,
        "usage": [],
        "artifacts": artifacts,
        "blockers": blockers,
        "files": {},
    }
