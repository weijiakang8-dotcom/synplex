"""Pinned SDK tool/reasoning/checkpoint round trip, deterministic HTTP only.

No account is queried. The only HTTP transport returns local fixture bytes.
"""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from openai import AsyncOpenAI
from langchain_core.messages import HumanMessage, ToolMessage, AIMessageChunk, messages_from_dict, messages_to_dict
from langchain_core.messages.utils import message_chunk_to_message

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "integrations/agenthub"))
from engine_provider import Provider, PROVIDERS
from provider_chat import build_client


def blocked(*args, **kwargs):
    raise AssertionError("A free protocol check attempted real network access")


async def main():
    constructions = []
    for name, (url, models) in PROVIDERS.items():
        profile = Provider("a" * 32, tuple(models), 512, "test-only-not-a-real-key", name)
        for model in models:
            row = SimpleNamespace(provider=name, model=model, base_url=url, api_key=profile.marker,
                                  config={"reasoning_effort": profile.default_effort}, max_tokens=512, timeout=90, max_retries=0)
            client = build_client(profile, row, reasoning_effort="high")
            payload = client._get_request_payload([HumanMessage(content="Offline only")])
            assert payload["model"] == model and payload["reasoning_effort"] == "high"
            assert payload["max_completion_tokens"] == 512 and "temperature" not in payload
            assert payload.get("extra_body") == ({"thinking": {"type": "enabled"}} if name == "deepseek" else None)
            for params in [{"reasoning_effort": "ultra"}, {}]:
                if not params:
                    row.max_tokens = 8193
                try:
                    build_client(profile, row, **params)
                except RuntimeError:
                    pass
                else:
                    raise AssertionError("Invalid effort or output bound accepted")
            constructions.append({"provider": name, "model": model})
    profile = Provider("b" * 32, ("kimi-k3",), 512, "test-only-not-a-real-key", "moonshot")
    row = SimpleNamespace(provider="moonshot", model="kimi-k3", base_url=profile.base_url, api_key=profile.marker,
                          config={}, max_tokens=512, timeout=90, max_retries=0)
    client = build_client(profile, row, reasoning_effort="max")
    for change in [{"model": "other"}, {"reasoning_effort": "low"}, {"max_completion_tokens": 8192},
                   {"extra_body": {"model": "other"}}, {"temperature": 1}, {"n": 2}]:
        try:
            client._get_request_payload([HumanMessage(content="Never send overrides")], **change)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Per-call parameters bypassed the confirmed selection")
    requests = []
    def fixture(request):
        assert str(request.url) == profile.base_url + "/chat/completions"
        payload = json.loads(request.content)
        assert payload["model"] == "kimi-k3" and payload["reasoning_effort"] == "max"
        assert payload["max_completion_tokens"] == 512 and "thinking" not in payload and "extra_body" not in payload
        assert "temperature" not in payload
        requests.append(payload)
        if payload.get("stream"):
            chunks = [{"id": "stream-fixture", "object": "chat.completion.chunk", "created": 1, "model": "kimi-k3",
                "choices": [{"index": 0, "delta": delta, "finish_reason": None}]} for delta in [
                {"role": "assistant", "reasoning_content": "first "}, {"reasoning_content": "second"}, {"content": "stream answer"}]]
            chunks.append({"id": "stream-fixture", "object": "chat.completion.chunk", "created": 1, "model": "kimi-k3",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}})
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                content=("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode())
        if len(requests) == 1:
            message = {"role": "assistant", "content": None, "reasoning_content": "fixture reasoning, not a model conclusion",
                       "tool_calls": [{"id": "call_fixture", "type": "function", "function": {"name": "read_source", "arguments": '{"id":"source-1"}'}}]}
            finish = "tool_calls"
        else:
            assert len(requests) == 2
            assert payload["messages"][1]["reasoning_content"] == "fixture reasoning, not a model conclusion"
            assert payload["messages"][1]["tool_calls"][0]["id"] == "call_fixture"
            assert payload["messages"][2] == {"role": "tool", "content": "source bytes", "tool_call_id": "call_fixture"}
            message = {"role": "assistant", "content": "fixture answer", "reasoning_content": "fixture follow-up"}
            finish = "stop"
        return httpx.Response(200, json={"id": "completion-fixture", "object": "chat.completion", "created": 1, "model": "kimi-k3",
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(fixture)) as transport:
        client.async_client = AsyncOpenAI(api_key=profile.credential, base_url=profile.base_url, http_client=transport, max_retries=0).chat.completions
        tools = [{"type": "function", "function": {"name": "read_source", "description": "Local fixture only", "parameters": {
            "type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}}}]
        history = [HumanMessage(content="Offline source question")]
        first = await client.bind_tools(tools).ainvoke(history)
        assert first.tool_calls[0]["args"] == {"id": "source-1"} and first.usage_metadata["total_tokens"] == 30
        # The same encoding used by persisted LangChain messages must retain the field.
        history = messages_from_dict(json.loads(json.dumps(messages_to_dict(history + [first]), ensure_ascii=False)))
        history.append(ToolMessage(content="source bytes", tool_call_id="call_fixture"))
        final = await client.bind_tools(tools).ainvoke(history)
        assert final.content == "fixture answer" and final.additional_kwargs["reasoning_content"] == "fixture follow-up"
        pieces = [piece async for piece in client.astream([HumanMessage(content="Offline stream")])]
    full = pieces[0]
    for piece in pieces[1:]:
        full += piece
    restored = messages_from_dict(messages_to_dict([message_chunk_to_message(full)]))[0]
    assert restored.content == "stream answer"
    assert client._get_request_payload([restored])["messages"][0]["reasoning_content"] == "first second"
    malformed = {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "", "reasoning_content": {"bad": "shape"}}, "finish_reason": None}]}
    try:
        client._convert_chunk_to_generation_chunk(malformed, AIMessageChunk, None)
    except RuntimeError:
        pass
    else:
        raise AssertionError("Malformed reasoning was silently dropped")
    return {"protocolRoundTrip": "passed", "constructors": constructions, "fixtureHttpRequests": len(requests),
            "toolCallAndCheckpointPreserved": True, "streamReasoningPreserved": True,
            "malformedReasoningRejected": True, "perCallOverrideRejected": True, "modelCalls": 0, "accountValidation": "not_run"}


if __name__ == "__main__":
    with patch("socket.socket.connect", blocked), patch("httpx.HTTPTransport.handle_request", blocked), patch("httpx.AsyncHTTPTransport.handle_async_request", blocked):
        print(json.dumps(asyncio.run(main()), ensure_ascii=False))
