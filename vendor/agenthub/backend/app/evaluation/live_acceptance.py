"""Approved serial acceptance: real Gateway, HTTP/JWT, graph, checkpoints and downloads.

No Celery worker is launched: API outbox entries are dispatched in-process to the
same production runner. This does not certify broker/worker deployment behavior.
Credentials are read into memory only; never written into reports.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from sqlalchemy import select

from app.artifacts.service import artifact_inventory
from app.config import settings
from app.core.model_gateway import ModelGateway
from app.core.security import create_access_token, hash_password
from app.database import async_session_factory
from app.engine import runner
from app.engine.evaluator import evaluate_execution
from app.main import app
from app.models import (
    Agent,
    Execution,
    ModelConfig,
    Organization,
    UsageEvent,
    User,
)

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = Path(
    ".runtime/live-acceptance"
)
FX = 6.7023  # ECB/Frankfurter snapshot dated 2026-10-08, retrieved 2026-10-09.
PEAK_USD = {"deepseek-flash": (0.006, 0.3, 1.2), "deepseek-v4-pro": (0.044, 1.32, 3.96)}


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str))


async def setup(key):
    state_path = EVIDENCE / "验收状态.json"
    if state_path.exists():
        return json.loads(state_path.read_text())
    async with async_session_factory() as session:
        org = Organization(
            name="AgentHub真实任务验收", slug="acceptance-" + uuid.uuid4().hex[:8]
        )
        session.add(org)
        await session.flush()
        user = User(
            email=f"acceptance-{uuid.uuid4().hex}@example.test",
            password_hash=hash_password(uuid.uuid4().hex),
            organization_id=org.id,
            role="admin",
            full_name="合成验收账户",
        )
        session.add(user)
        await session.flush()
        for name, priority, vision in [
            ("deepseek-flash", 100, True),
            ("deepseek-v4-pro", 1, False),
        ]:
            rates = PEAK_USD[name]
            session.add(
                ModelConfig(
                    organization_id=org.id,
                    name=name,
                    model=name,
                    provider="deepseek",
                    base_url="https://api.deepseek.com/v1",
                    api_key=key,
                    max_tokens=4096,
                    cost_per_1k_tokens=rates[2] * FX / 1000,
                    priority=priority,
                    timeout=60,
                    max_retries=0,
                    is_default=name == "deepseek-flash",
                    config={
                        "capabilities": {
                            "context_window": 1048576,
                            "tool_calling": True,
                            "structured_output": True,
                            "vision": vision,
                        },
                        "input_cost_per_1k_tokens": rates[1] * FX / 1000,
                        "output_cost_per_1k_tokens": rates[2] * FX / 1000,
                    },
                )
            )
        await session.commit()
        state = {
            "org_id": str(org.id),
            "user_id": str(user.id),
            "cases": {},
            "environment": "isolated_local_real_provider",
            "dispatch": "HTTP outbox -> in-process production runner",
            "platform_price_basis": "uniform output peak-rate upper bound; not provider billing",
            "fx": {
                "USD_CNY": FX,
                "date": "2026-10-08",
                "source": "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY",
            },
        }
    save(state_path, state)
    return state


def instrument(key):
    lock = asyncio.Lock()
    original = ModelGateway.invoke
    counter = 0

    async def invoke(self, llms, messages, **kwargs):
        nonlocal counter
        async with lock:
            counter += 1
            if counter > 200:
                raise RuntimeError("acceptance model-call ceiling reached")
            start = time.perf_counter()
            print(
                f"model_call_start {counter} {kwargs.get('task_type')} candidates={len(llms)}",
                flush=True,
            )
            entry = {
                "time": datetime.now(timezone.utc).isoformat(),
                "task_type": kwargs.get("task_type"),
                "execution_id": kwargs.get("correlation_id"),
            }
            try:
                response = await original(self, llms, messages, **kwargs)
                meta = (response.additional_kwargs or {}).get("_agenthub_llm") or {}
                raw = (response.response_metadata or {}).get("token_usage") or {}
                entry.update(meta)
                entry["provider_token_usage"] = raw
                name = meta.get("model_used")
                if name in PEAK_USD and raw:
                    now = datetime.now(timezone.utc)
                    peak = now.weekday() < 5 and (
                        1 <= now.hour < 4 or 6 <= now.hour < 10
                    )
                    hit, miss, out = PEAK_USD[name]
                    multiplier = 1 if peak else 0.5
                    inp = int(raw.get("prompt_tokens") or 0)
                    output = int(raw.get("completion_tokens") or 0)
                    cached = int(
                        raw.get("prompt_cache_hit_tokens")
                        or (raw.get("prompt_tokens_details") or {}).get("cached_tokens")
                        or 0
                    )
                    entry["price_period"] = "peak" if peak else "off_peak"
                    entry["provider_price_estimate_usd"] = (
                        (cached * hit + (inp - cached) * miss + output * out)
                        * multiplier
                        / 1e6
                    )
                    entry["provider_price_estimate_cny"] = (
                        entry["provider_price_estimate_usd"] * FX
                    )
                return response
            except Exception as exc:
                entry["error"] = str(exc).replace(key, "[REDACTED]")[:500]
                raise
            finally:
                entry["latency_seconds"] = round(time.perf_counter() - start, 3)
                with (EVIDENCE / "真实模型调用.jsonl").open("a") as f:
                    f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
                print(
                    f"model_call_end {counter} {entry.get('model_used','')} {entry['latency_seconds']}s",
                    flush=True,
                )

    ModelGateway.invoke = invoke


async def dispatch(client, execution_id, case):
    eid = uuid.UUID(execution_id)
    async with async_session_factory() as session:
        row = await session.get(Execution, eid)
        status = getattr(row.status, "value", row.status)
    if status == "pending":
        await asyncio.wait_for(runner.run_execution(eid), timeout=420)
    elif status == "running":
        raise RuntimeError(
            "Interrupted running execution requires checkpoint audit before restart"
        )
    for _ in range(4):
        async with async_session_factory() as session:
            row = await session.get(Execution, eid)
            status = getattr(row.status, "value", row.status)
        if status != "waiting_for_approval":
            break
        async with runner.get_checkpoint_manager() as manager:
            graph = runner.build_graph(checkpointer=manager.saver)
            snapshot = await graph.aget_state({"configurable": {"thread_id": str(eid)}})
            pending = snapshot.values.get("pending_approval") or {}
            proposals = pending.get("side_effect_proposals") or []
        # The human approved creating the two synthetic Agents, never transactions.
        approve = (
            case["id"] in {"inn-agent", "learning-agent"}
            and bool(proposals)
            and all(
                p.get("tool") == "create_agent"
                and p.get("params", {}).get("name", "").startswith("验收-")
                for p in proposals
            )
        )
        decision = {
            "approved": approve,
            "comment": None if approve else "验收不批准外部副作用",
        }
        response = await client.post(f"/api/executions/{eid}/resume", json=decision)
        response.raise_for_status()
        await asyncio.wait_for(runner.resume_execution(eid, decision), timeout=420)
    async with async_session_factory() as session:
        row = await session.get(Execution, eid)
        output = row.final_output
    if output:
        await evaluate_execution(str(eid))


async def collect(client, eid):
    detail = await client.get(f"/api/executions/{eid}")
    detail.raise_for_status()
    data = detail.json()
    async with async_session_factory() as session:
        execution = await session.get(Execution, uuid.UUID(eid))
        receipts = list(
            (
                await session.execute(
                    select(UsageEvent).where(UsageEvent.execution_id == execution.id)
                )
            )
            .scalars()
            .all()
        )
        inventory, missing = await artifact_inventory(
            execution.id, execution.user_id, execution.organization_id
        )
        agents = list(
            (
                await session.execute(
                    select(Agent).where(
                        Agent.organization_id == execution.organization_id
                    )
                )
            )
            .scalars()
            .all()
        )
    data["receipt_summary"] = [
        {
            "id": str(r.id),
            "model": r.model,
            "input_tokens": r.input_tokens,
            "output_tokens": r.output_tokens,
            "cost": r.cost,
            "status": r.status,
            "task_type": r.task_type,
        }
        for r in receipts
    ]
    data["verified_inventory"] = inventory
    data["missing_files"] = missing
    data["saved_agents"] = [
        {
            "id": str(a.id),
            "name": a.name,
            "system_prompt": a.system_prompt,
            "tools": a.tools,
        }
        for a in agents
    ]
    data["downloads"] = []
    for artifact in inventory:
        response = await client.get(artifact["download_url"])
        filename = f"{eid}-{artifact['id']}.{artifact['format']}"
        if response.status_code == 200:
            (EVIDENCE / filename).write_bytes(response.content)
        data["downloads"].append(
            {
                "artifact_id": artifact["id"],
                "http_status": response.status_code,
                "file": str(EVIDENCE / filename),
                "size": len(response.content),
            }
        )
    return data


async def main_async(args):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    key_result = await asyncio.to_thread(
        subprocess.run,
        [
            "security",
            "find-generic-password",
            "-s",
            "codex-model-provider-deepseek",
            "-w",
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    key = key_result.stdout.strip()
    if not key:
        raise RuntimeError("Approved provider credential unavailable")
    settings.OPENAI_API_KEY = key
    state = await setup(key)
    if args.reasoning_effort:
        async with async_session_factory() as session:
            configs = (
                (
                    await session.execute(
                        select(ModelConfig).where(
                            ModelConfig.organization_id == uuid.UUID(state["org_id"])
                        )
                    )
                )
                .scalars()
                .all()
            )
            for config in configs:
                config.config = {
                    **(config.config or {}),
                    "reasoning_effort": args.reasoning_effort,
                }
            await session.commit()
        state["reasoning_effort"] = args.reasoning_effort
        save(EVIDENCE / "验收状态.json", state)
    instrument(key)
    cases = json.loads((ROOT / "evaluation/acceptance_tasks.json").read_text())
    supplements = ROOT / "evaluation/acceptance_supplements.json"
    if supplements.exists():
        cases.extend(json.loads(supplements.read_text()))
    wanted = (
        set(args.case or []) | set(args.retry_case or []) | set(args.probe_only or [])
    )
    selected = [c for c in cases if not wanted or c["id"] in wanted]
    transport = httpx.ASGITransport(app=app)
    token = create_access_token(state["user_id"], state["org_id"])
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://acceptance.local",
        headers={"Authorization": "Bearer " + token},
        timeout=450,
    ) as client:
        for case in selected:
            current = state["cases"].get(case["id"])
            if case["id"] in (args.probe_only or []):
                if not current or not case.get("probe"):
                    raise ValueError(
                        "Probe requires a saved acceptance Agent and parent execution"
                    )
                client.headers["Authorization"] = "Bearer " + create_access_token(
                    state["user_id"], state["org_id"]
                )
                result = await collect(client, current["execution_id"])
                target = (
                    "验收-海风民宿管家"
                    if case["id"] == "inn-agent"
                    else "验收-线代入门教练"
                )
                agent = next(a for a in result["saved_agents"] if a["name"] == target)
                if not current.get("probe_pending"):
                    source = EVIDENCE / (case["id"] + "-实际执行.json")
                    if source.exists():
                        old = json.loads(source.read_text()).get("agent_trial")
                        if old:
                            save(EVIDENCE / f"{case['id']}-trial-{old['id']}.json", old)
                    trial = await client.post(
                        f"/api/agents/{agent['id']}/run",
                        json={"user_input": case["probe"]},
                    )
                    trial.raise_for_status()
                    current["trial_execution_id"] = trial.json()["execution_id"]
                    current["probe_pending"] = True
                    save(EVIDENCE / "验收状态.json", state)
                trial_id = current["trial_execution_id"]
                await dispatch(client, trial_id, {**case, "id": "trial"})
                result["agent_trial"] = await collect(client, trial_id)
                result["case"] = case
                result["elapsed_seconds"] = current["elapsed_seconds"]
                current["probe_pending"] = False
                save(EVIDENCE / (case["id"] + "-实际执行.json"), result)
                save(EVIDENCE / "验收状态.json", state)
                print("probe_done", case["id"], trial_id, flush=True)
                continue
            if current and current.get("finished"):
                if case["id"] not in (args.retry_case or []):
                    print("skip_finished", case["id"], flush=True)
                    continue
                previous = list(state.get("attempt_history", {}).get(case["id"]) or [])
                previous.append(current)
                state.setdefault("attempt_history", {})[case["id"]] = previous
                source = EVIDENCE / (case["id"] + "-实际执行.json")
                if source.exists():
                    (
                        EVIDENCE
                        / f"{case['id']}-attempt-{current['execution_id']}.json"
                    ).write_bytes(source.read_bytes())
                current = None
                state["cases"].pop(case["id"])
                save(EVIDENCE / "验收状态.json", state)
            client.headers["Authorization"] = "Bearer " + create_access_token(
                state["user_id"], state["org_id"]
            )
            print("case_start", case["id"], flush=True)
            started = time.perf_counter()
            if not current:
                wf = await client.post(
                    "/api/workflows",
                    json={
                        "name": "验收-" + case["name"],
                        "created_by": state["user_id"],
                        "agent_chain": [],
                    },
                )
                wf.raise_for_status()
                response = await client.post(
                    "/api/executions",
                    json={
                        "workflow_id": wf.json()["id"],
                        "user_input": case["request"],
                    },
                )
                response.raise_for_status()
                current = {
                    "execution_id": response.json()["execution_id"],
                    "started_at": datetime.now(timezone.utc).isoformat(),
                }
                state["cases"][case["id"]] = current
                save(EVIDENCE / "验收状态.json", state)
            eid = current["execution_id"]
            try:
                await dispatch(client, eid, case)
            except Exception as exc:  # noqa: BLE001
                # Preserve failure evidence and continue the remaining acceptance cases.
                current["harness_error"] = str(exc).replace(key, "[REDACTED]")[:500]
                print("case_error", case["id"], type(exc).__name__, flush=True)
            result = await collect(client, eid)
            if case.get("probe"):
                own_agents = [
                    a
                    for a in result["saved_agents"]
                    if a["name"] in {"验收-海风民宿管家", "验收-线代入门教练"}
                ]
                target = (
                    "验收-海风民宿管家"
                    if case["id"] == "inn-agent"
                    else "验收-线代入门教练"
                )
                agent = next((a for a in own_agents if a["name"] == target), None)
                if agent:
                    trial_id = current.get("trial_execution_id")
                    if not trial_id:
                        trial = await client.post(
                            f"/api/agents/{agent['id']}/run",
                            json={"user_input": case["probe"]},
                        )
                        trial.raise_for_status()
                        trial_id = trial.json()["execution_id"]
                        current["trial_execution_id"] = trial_id
                        save(EVIDENCE / "验收状态.json", state)
                    await dispatch(client, trial_id, {**case, "id": "trial"})
                    result["agent_trial"] = await collect(client, trial_id)
            current.update(
                finished=True,
                elapsed_seconds=round(time.perf_counter() - started, 3),
                status=result["status"],
                delivery=(result.get("checkpoint_data") or {}).get("delivery"),
            )
            result["case"] = case
            result["elapsed_seconds"] = current["elapsed_seconds"]
            save(EVIDENCE / (case["id"] + "-实际执行.json"), result)
            save(EVIDENCE / "验收状态.json", state)
            print(
                "case_done",
                case["id"],
                current["status"],
                (current.get("delivery") or {}).get("status"),
                current["elapsed_seconds"],
                flush=True,
            )


def main():
    logging.basicConfig(level=logging.ERROR)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append")
    parser.add_argument("--retry-case", action="append")
    parser.add_argument("--probe-only", action="append")
    parser.add_argument("--reasoning-effort", choices=["low", "high", "max"])
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
