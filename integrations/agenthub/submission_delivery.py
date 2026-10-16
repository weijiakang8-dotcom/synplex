"""Atomic original-submission identity; lookup never schedules a task.

The receipt, execution, input files and outbox share one database transaction.
An absent receipt is unknown, not permission to submit again. No provider call.
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import noload

PROTOCOL = "synplex.execution-submission/1"
CREATE_TABLE = """CREATE TABLE IF NOT EXISTS synplex_execution_submissions (
 operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL,
 packet_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
 organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
 workflow_id TEXT NOT NULL, execution_id TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL
)"""


async def initialize(engine):
    async with engine.begin() as connection:
        await connection.execute(text(CREATE_TABLE))


def submission_hash(payload):
    # The admitted input has fixed ASCII keys, integers, strings and arrays.
    # Match the existing JS canonical JSON hash without changing its meaning.
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


async def receipt(session, operation_id):
    result = await session.execute(text(
        "SELECT * FROM synplex_execution_submissions WHERE operation_id=:id"
    ), {"id": str(operation_id)})
    return result.mappings().first()


def matches(row, submission, user, workflow_id):
    expected = {**submission, "organization_id": str(user.organization_id),
                "user_id": str(user.id), "workflow_id": str(workflow_id)}
    return row is not None and all(row[key] == str(value) for key, value in expected.items())


async def reserve(session, submission, user, workflow_id):
    execution_id = str(uuid.uuid4())
    values = {**submission, "organization_id": str(user.organization_id),
              "user_id": str(user.id), "workflow_id": str(workflow_id),
              "execution_id": execution_id, "created_at": datetime.now(timezone.utc).isoformat()}
    result = await session.execute(text("""INSERT INTO synplex_execution_submissions
      (operation_id,attempt_id,packet_hash,payload_hash,organization_id,user_id,workflow_id,execution_id,created_at)
      VALUES (:operation_id,:attempt_id,:packet_hash,:payload_hash,:organization_id,:user_id,:workflow_id,:execution_id,:created_at)
      ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id"""), values)
    if result.first() is not None:
        return execution_id, True
    old = await receipt(session, submission["operation_id"])
    if not matches(old, submission, user, workflow_id):
        raise ValueError("Original submission identity changed")
    return old["execution_id"], False


async def original_execution(session, row, submission, user, workflow_id):
    from app.models import Execution
    if not matches(row, submission, user, workflow_id):
        raise ValueError("Original submission was not found")
    execution = await session.get(Execution, uuid.UUID(row["execution_id"]), options=[noload('*')])
    if (not execution or str(execution.organization_id) != str(user.organization_id)
            or str(execution.user_id) != str(user.id) or str(execution.workflow_id) != str(workflow_id)
            or str(execution.correlation_id) != str(submission["operation_id"])):
        raise ValueError("Original task identity differs")
    return execution


def install_lookup(router, data):
    from fastapi import HTTPException, Query
    from app.api.deps import SessionDep, CurrentUserDep

    @router.get("/api/synplex/submissions/{operation_id}")
    async def lookup(operation_id: uuid.UUID, attempt_id: uuid.UUID,
                     session: SessionDep, user: CurrentUserDep,
                     packet_hash: str = Query(pattern="^[a-f0-9]{64}$"),
                     payload_hash: str = Query(pattern="^[a-f0-9]{64}$")):
        from tenant_identity import identity
        current = await identity(session, data, user.id, user.organization_id)
        if not current:
            raise HTTPException(404, "Original submission was not found")
        submission = {"operation_id": str(operation_id), "attempt_id": str(attempt_id),
                      "packet_hash": packet_hash, "payload_hash": payload_hash}
        row = await receipt(session, operation_id)
        try:
            execution = await original_execution(session, row, submission, user, current["workflow_id"])
        except ValueError as error:
            raise HTTPException(404, "Original submission was not found") from error
        # No prompt, input, files, answer or credential is exposed in this lookup.
        return {"protocol": PROTOCOL, **submission, "execution_id": str(execution.id)}
