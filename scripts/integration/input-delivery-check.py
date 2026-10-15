"""One free core scenario: answer rollback, exact replay, worker claim and checkpoint resume.

Imports frozen model definitions read-only; all data is temporary SQLite, all
HTTP is in-process, and the graph has deterministic nodes with no model calls.
"""
import asyncio
import json
import sys
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import TypedDict

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import MemorySaver

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "integrations/agenthub"))
sys.path.insert(0, sys.argv[1])
from input_delivery import initialize, install_api, delivery, claim_once
import hashlib
from app.models import Execution, Clarification, OutboxEvent
from app.models.enums import ExecutionStatus
from app.api.deps import get_current_user
from app.database import get_db


async def main():
    with tempfile.TemporaryDirectory(prefix="synplex-input-") as temporary:
        engine = create_async_engine("sqlite+aiosqlite:///" + temporary + "/fixture.sqlite")
        async with engine.begin() as connection:
            for model in [Execution, Clarification, OutboxEvent]:
                await connection.run_sync(model.__table__.create)
        await initialize(engine)
        fault = {"commit": False}

        class Session(AsyncSession):
            async def commit(self):
                if fault["commit"]:
                    fault["commit"] = False
                    raise RuntimeError("Synthetic crash before commit")
                return await super().commit()

        sessions = async_sessionmaker(engine, class_=Session, expire_on_commit=False)
        eid, qid, org, wid = [uuid.uuid4() for _ in range(4)]
        async with sessions() as session:
            session.add(Execution(id=eid, workflow_id=wid, organization_id=org,
                user_input="合成任务", status=ExecutionStatus.WAITING_FOR_APPROVAL,
                checkpoint_data={"interrupt": {"type": "clarification", "clarification": {"clarification_id": str(qid)}}}))
            session.add(Clarification(id=qid, execution_id=eid, organization_id=org,
                question="你需要什么格式？", options=["文字", "表格"], status="pending"))
            await session.commit()
        app = FastAPI()
        install_api(app, {"workflow_id": str(wid), "organization_id": str(org)})
        user = SimpleNamespace(organization_id=org)

        async def db():
            async with sessions() as session:
                yield session

        app.dependency_overrides[get_db] = db
        app.dependency_overrides[get_current_user] = lambda: user
        assert app.openapi()["paths"]
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://fixture") as client:
            route = "/api/dispatch/clarifications/" + str(qid) + "/answer"
            inspect = f"/api/synplex/executions/{eid}/input-deliveries/{qid}"
            assert (await client.get(inspect)).status_code == 404
            fault["commit"] = True
            assert (await client.post(route, json={"answer": "文字"})).status_code == 500
            async with sessions() as session:
                assert await delivery(session, qid) is None
                assert (await session.get(Clarification, qid)).status == "pending"
                assert not (await session.execute(select(OutboxEvent))).scalars().all()
            first = await client.post(route, json={"answer": "文字"})
            assert first.status_code == 202, first.text
            receipt = (await client.get(inspect)).json()
            assert receipt == {"protocol": "synplex.input-delivery/1", "executionId": str(eid),
                "questionId": str(qid), "answerSha256": hashlib.sha256("文字".encode()).hexdigest(), "deliveryState": "queued"}
            assert (await client.get(inspect.replace(str(eid), str(uuid.uuid4())))).status_code == 404
            assert (await client.post(route, json={"answer": "文字"})).json() == first.json()
            assert (await client.post(route, json={"answer": "表格"})).status_code == 409
            user.organization_id = uuid.uuid4()
            assert (await client.post(route, json={"answer": "文字"})).status_code == 404
            assert (await client.get(inspect)).status_code == 404
            user.organization_id = org
            async with sessions() as session:
                events = (await session.execute(select(OutboxEvent))).scalars().all()
                assert len(events) == 1
                assert events[0].payload["decision"]["synplexInputId"] == str(qid)
                assert await claim_once(session, qid, eid, "文字")
                await session.commit()
            # A new session after the claim simulates recovery of persisted intent.
            async with sessions() as session:
                assert not await claim_once(session, qid, eid, "文字")
                assert (await delivery(session, qid))["state"] == "running"
            assert (await client.get(inspect)).json()["deliveryState"] == "running"
        await engine.dispose()

        class State(TypedDict):
            answer: str

        calls = []
        def before(state):
            calls.append("completed-step")
            return state
        def question(state):
            answer = interrupt("选择格式")
            calls.append("resumed-step")
            return {"answer": answer}
        graph = StateGraph(State)
        graph.add_node("before", before); graph.add_node("question", question)
        graph.add_edge(START, "before"); graph.add_edge("before", "question"); graph.add_edge("question", END)
        checkpointer = MemorySaver()
        configuration = {"configurable": {"thread_id": str(eid)}}
        pending = graph.compile(checkpointer=checkpointer).invoke({"answer": ""}, configuration)
        assert pending["__interrupt__"]
        result = graph.compile(checkpointer=checkpointer).invoke(Command(resume="文字"), configuration)
        assert result["answer"] == "文字"
        assert calls == ["completed-step", "resumed-step"]
        evidence = {"checks": ["read-only scoped answer delivery with hash and actual state", "answer/outbox atomic rollback", "same answer replay", "changed answer refused", "foreign organization refused", "one persisted outbox", "claim once survives reconnect", "original LangGraph interrupt resumes without rerunning completed node"], "modelCalls": 0,
            "limitations": ["SQLite fixture, not PostgreSQL contention", "MemorySaver graph reconstruction, not process restart", "no real model continuation"]}
        output = Path(sys.argv[2]) if len(sys.argv) > 2 else root / ".runtime/implementation-baseline/input-delivery-check.json"
        with output.open("x") as file:
            json.dump(evidence, file, indent=2)
        print("Input delivery core fixture passed; model calls: 0")


asyncio.run(main())
