"""Atomic input delivery for the explicitly isolated AgentHub process only.

An answer and its outbox intent commit together. Workers claim once before
resuming the existing graph. A crash after claim stays unknown; it is never
silently retried. No changes to the protected legacy source tree are required.
"""
import hashlib
import uuid
from datetime import datetime, timezone
from sqlalchemy import text, select
from sqlalchemy.orm import noload


CREATE_TABLE = """CREATE TABLE IF NOT EXISTS synplex_input_deliveries (
 question_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL,
 answer_hash TEXT NOT NULL, state TEXT NOT NULL,
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
)"""


async def initialize(engine):
    async with engine.begin() as connection:
        await connection.execute(text(CREATE_TABLE))


async def delivery(session, question_id):
    row = await session.execute(text(
        "SELECT * FROM synplex_input_deliveries WHERE question_id=:id"
    ), {"id": str(question_id)})
    return row.mappings().first()


async def insert_intent(session, question_id, execution_id, answer):
    answer_hash = hashlib.sha256(answer.encode()).hexdigest()
    old = await delivery(session, question_id)
    if old:
        if old["execution_id"] != str(execution_id) or old["answer_hash"] != answer_hash:
            raise ValueError("Answer identity changed")
        return False
    await session.execute(text("""INSERT INTO synplex_input_deliveries
      (question_id,execution_id,answer_hash,state,created_at)
      VALUES (:id,:execution,:hash,'queued',:time)"""), {
        "id": str(question_id), "execution": str(execution_id), "hash": answer_hash,
        "time": datetime.now(timezone.utc).isoformat(),
    })
    return True


async def claim_once(session, question_id, execution_id, answer):
    row = await session.execute(text("""UPDATE synplex_input_deliveries
      SET state='running',started_at=:time
      WHERE question_id=:id AND execution_id=:execution AND answer_hash=:hash
        AND state='queued' RETURNING question_id"""), {
        "id": str(question_id), "execution": str(execution_id),
        "hash": hashlib.sha256(answer.encode()).hexdigest(),
        "time": datetime.now(timezone.utc).isoformat(),
    })
    return row.first() is not None


def install_api(app, data):
    from fastapi import APIRouter, Depends, HTTPException
    from pydantic import BaseModel, Field, ConfigDict
    from app.api.deps import SessionDep, CurrentUserDep, get_current_user
    from app.models import Execution, Clarification
    from app.models.enums import ExecutionStatus
    from app.models.base import utcnow
    from app.engine.outbox import enqueue_outbox_event

    class Answer(BaseModel):
        model_config = ConfigDict(extra="forbid")
        answer: str = Field(min_length=1, max_length=2000)

    router = APIRouter()

    async def original_question(session, user, clarification_id, *, lock=False):
        q = await session.get(Clarification, clarification_id, with_for_update=lock, options=[noload('*')])
        execution = await session.get(Execution, q.execution_id, with_for_update=lock, options=[noload('*')]) if q else None
        if (not execution or str(execution.workflow_id) != data["workflow_id"]
                or str(execution.organization_id) != data["organization_id"]
                or execution.organization_id != user.organization_id
                or q.organization_id != user.organization_id):
            raise HTTPException(404, "Question not found")
        return q, execution

    @router.get("/api/synplex/executions/{execution_id}/input-deliveries/{clarification_id}",
                dependencies=[Depends(get_current_user)])
    async def inspect_answer(execution_id: uuid.UUID, clarification_id: uuid.UUID,
                             session: SessionDep, user: CurrentUserDep):
        q, execution = await original_question(session, user, clarification_id)
        if execution.id != execution_id:
            raise HTTPException(404, "Question not found")
        row = await delivery(session, clarification_id)
        if row is None:
            raise HTTPException(404, "Answer delivery not found")
        if (row["execution_id"] != str(execution_id) or q.status != "answered"
                or not isinstance(q.answer, str)
                or row["answer_hash"] != hashlib.sha256(q.answer.encode()).hexdigest()
                or row["state"] not in {"queued", "running", "finished", "unknown"}):
            raise HTTPException(409, "Answer delivery needs reconciliation")
        # Persistence confirms receipt, not worker success. Never return the answer.
        return {"protocol": "synplex.input-delivery/1", "executionId": str(execution_id),
                "questionId": str(clarification_id), "answerSha256": row["answer_hash"],
                "deliveryState": row["state"]}

    @router.post("/api/dispatch/clarifications/{clarification_id}/answer",
                 status_code=202, dependencies=[Depends(get_current_user)])
    async def answer(clarification_id: uuid.UUID, payload: Answer,
                     session: SessionDep, user: CurrentUserDep):
        if not payload.answer.strip():
            raise HTTPException(400, "Answer cannot be blank")
        q, execution = await original_question(session, user, clarification_id, lock=True)
        old = await delivery(session, clarification_id)
        if old:
            if old["answer_hash"] != hashlib.sha256(payload.answer.encode()).hexdigest():
                raise HTTPException(409, "Answer identity changed")
            if old["state"] == "unknown":
                raise HTTPException(409, "Original continuation needs reconciliation")
            return {"clarification_id": str(q.id), "execution_id": str(execution.id), "status": "resuming"}
        interrupt = (execution.checkpoint_data or {}).get("interrupt") or {}
        if (q.status != "pending" or execution.status != ExecutionStatus.WAITING_FOR_APPROVAL
                or interrupt.get("type") != "clarification"
                or (interrupt.get("clarification") or {}).get("clarification_id") != str(q.id)):
            raise HTTPException(409, "Execution is not waiting for this question")
        await insert_intent(session, q.id, execution.id, payload.answer)
        q.answer, q.status, q.answered_at = payload.answer, "answered", utcnow()
        execution.status = ExecutionStatus.RUNNING
        await enqueue_outbox_event(session, "resume_workflow", {
            "execution_id": str(execution.id),
            "decision": {"answer": payload.answer, "synplexInputId": str(q.id)},
        }, execution_id=execution.id)
        await session.commit()  # Answer, intent and outbox are one transaction.
        return {"clarification_id": str(q.id), "execution_id": str(execution.id), "status": "resuming"}

    # Real applications include routers lazily on current FastAPI. Prepend our
    # authenticated transaction route instead of assuming a flattened .path.
    from private_routes import include_first
    include_first(app, router)


def install_worker():
    from app.database import async_session_factory
    from app.engine.tasks import resume_workflow_task, run_worker_async
    from app.engine.runner import resume_execution
    from app.engine.lease_runner import run_with_execution_lease
    original = resume_workflow_task.run

    async def guarded(execution_id, decision):
        question_id = decision["synplexInputId"]
        async with async_session_factory() as session:
            claimed = await claim_once(session, question_id, execution_id, decision["answer"])
            await session.commit()
        if not claimed:
            return  # Duplicate broker delivery is not another graph execution.
        state = "unknown"
        try:
            async def run():
                await resume_execution(uuid.UUID(execution_id), {"answer": decision["answer"]})
            await run_with_execution_lease(uuid.UUID(execution_id), "synplex-input:" + question_id, run)
            state = "finished"
        finally:
            async with async_session_factory() as session:
                await session.execute(text("""UPDATE synplex_input_deliveries
                  SET state=:state,finished_at=:time WHERE question_id=:id AND state='running'"""), {
                    "id": question_id, "state": state, "time": datetime.now(timezone.utc).isoformat(),
                })
                await session.commit()

    def run(execution_id, decision):
        if "synplexInputId" not in decision:
            return original(execution_id, decision)
        return run_worker_async(guarded(execution_id, decision))

    resume_workflow_task.run = run
