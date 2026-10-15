"""Immutable, execution-scoped input bytes, committed with the dispatch intent.

Kept outside checkpoint_data: the legacy runner replaces that field on pause.
There are no caller-supplied filesystem paths or source-directed downloads.
"""
import base64
import hashlib
import re

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

MAX_BYTES = 8 * 1024 * 1024
MAX_FILES = 30
PROTOCOL = "synplex.engine-input-files/1"


class InputBodyLimit:
    """Bound actual streamed bytes before Pydantic/base64 allocation."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") != "/api/synplex/executions":
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > 16 * 1024 * 1024:
                from starlette.responses import JSONResponse
                return await JSONResponse({"detail": "本次内容太多，请减少文件或拆成较小的步骤。"}, status_code=413)(scope, receive, send)
            chunks.append(chunk)
            if not message.get("more_body"):
                break
        body = b"".join(chunks)
        delivered = False
        async def replay():
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await self.app(scope, replay, send)


class InputFile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    resultId: str = Field(min_length=1, max_length=160)
    artifactId: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=255)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    byteLength: int = Field(ge=0, le=MAX_BYTES)
    mediaType: str = Field(min_length=1, max_length=160)
    contentBase64: str = Field(max_length=((MAX_BYTES + 2) // 3) * 4)


class SourceInputFile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sourceId: str = Field(min_length=1, max_length=160)
    occurrenceId: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=255)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    byteLength: int = Field(ge=0, le=MAX_BYTES)
    mediaType: str = Field(min_length=1, max_length=160)
    contentBase64: str = Field(max_length=((MAX_BYTES + 2) // 3) * 4)


async def initialize(engine):
    async with engine.begin() as connection:
        await connection.execute(text("""CREATE TABLE IF NOT EXISTS synplex_task_files (
          execution_id TEXT NOT NULL, input_key TEXT NOT NULL,
          metadata TEXT NOT NULL, content_base64 TEXT NOT NULL,
          PRIMARY KEY(execution_id,input_key))"""))


def validated_files(files):
    if len(files) > MAX_FILES:
        raise ValueError("前置文件太多，请拆成较小的步骤。")
    checked, seen, total = [], set(), 0
    for file in files:
        value = file.model_dump() if isinstance(file, (InputFile, SourceInputFile)) else (SourceInputFile if "sourceId" in file else InputFile).model_validate(file).model_dump()
        if re.search(r"[\x00-\x1f\x7f/\\]", value["name"]) or value["name"] in {".", ".."}:
            raise ValueError("文件名无效，原文件尚未发送。")
        raw = base64.b64decode(value["contentBase64"], validate=True)
        if (len(raw) != value["byteLength"] or hashlib.sha256(raw).hexdigest() != value["sha256"]
                or base64.b64encode(raw).decode() != value["contentBase64"]):
            raise ValueError("文件与保存的指纹不一致。")
        total += len(raw)
        identity = ("source\0" + value["sourceId"] + "\0" + value["occurrenceId"] if "sourceId" in value
                    else value["resultId"] + "\0" + value["artifactId"])
        key = hashlib.sha256(identity.encode()).hexdigest()
        if total > MAX_BYTES or key in seen:
            raise ValueError("前置文件重复或超过本次容量，请减少文件后再开始。")
        seen.add(key)
        checked.append((key, value))
    return checked


async def save_files(session, execution_id, files):
    import json
    for key, value in validated_files(files):
        metadata = {k: v for k, v in value.items() if k != "contentBase64"}
        await session.execute(text("""INSERT INTO synplex_task_files
          (execution_id,input_key,metadata,content_base64) VALUES (:execution,:key,:metadata,:content)"""), {
            "execution": str(execution_id), "key": key,
            "metadata": json.dumps(metadata, ensure_ascii=False), "content": value["contentBase64"],
        })


async def load_file(session, execution_id, input_key):
    import json
    if not re.fullmatch(r"[a-f0-9]{64}", input_key):
        raise ValueError("请从这次任务的文件清单中选择文件。")
    row = (await session.execute(text("""SELECT metadata,content_base64 FROM synplex_task_files
      WHERE execution_id=:execution AND input_key=:key"""), {
        "execution": str(execution_id), "key": input_key,
    })).mappings().first()
    if not row:
        raise PermissionError("这份文件不属于当前任务。")
    value = {**json.loads(row["metadata"]), "contentBase64": row["content_base64"]}
    validated_files([value])
    return value, base64.b64decode(value["contentBase64"], validate=True)


def inventory(files):
    return [{"file_key": key, **{k: v for k, v in value.items() if k != "contentBase64"}}
            for key, value in validated_files(files)]
