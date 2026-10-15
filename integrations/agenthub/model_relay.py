"""Per-execution model bindings. Real provider credentials stay in the workspace.

The engine sees one narrowly scoped relay token. It cannot enumerate personal
connections, choose an external URL, fall back, or edit another execution's row.
"""
from urllib.parse import urlsplit
import uuid


def validate_endpoint(endpoint):
    parsed = urlsplit(endpoint)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
            or not 1024 <= parsed.port <= 65535 or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path != "/internal/model/v1"
            or endpoint != f"http://127.0.0.1:{parsed.port}/internal/model/v1"):
        raise RuntimeError("执行模型连接地址不属于本机工作台。")
    return endpoint


def enabled(data):
    if data.get("model_mode") != "relay":
        return False
    validate_endpoint(data.get("model_relay_endpoint", ""))
    return True


async def prepare_model(session, data, payload, user):
    from app.models import ModelConfig
    from fastapi import HTTPException
    binding = payload.model_binding
    if not enabled(data) or not payload.submission or binding is None:
        raise HTTPException(422, "Execution needs a bound private model connection")
    selection = payload.model_selection
    provider = "synplex-run:" + str(payload.submission.operation_id)
    if (binding.protocol != "synplex.execution-model/1"
            or binding.apiMode not in {"chat-completions", "responses"}
            or binding.endpoint != data["model_relay_endpoint"]
            or selection.provider != provider or selection.model != binding.model
            or selection.reasoning_effort != (binding.effort or "default")):
        raise HTTPException(422, "Model binding differs from this execution")
    identity = uuid.uuid5(uuid.UUID(data["id"]), provider)
    row = await session.get(ModelConfig, identity)
    config = {"synplex_relay": binding.model_dump(mode="json", exclude={"token"}),
              "reasoning_effort": binding.effort or "default", "pricingStatus": "unknown",
              "capabilities": {"context_window": binding.contextWindow, "tool_calling": True,
                               "structured_output": True}}
    if row is None:
        row = ModelConfig(id=identity, organization_id=user.organization_id, name="本次任务所选模型",
                          provider=provider, model=binding.model, base_url=binding.endpoint,
                          api_key=binding.token, config=config, max_tokens=binding.maxOutputTokens,
                          timeout=90, max_retries=0, is_default=False, enabled=True, is_active=True)
        session.add(row)
    elif (row.organization_id != user.organization_id or row.provider != provider
          or row.model != binding.model or row.base_url != binding.endpoint or row.api_key != binding.token
          or row.config != config or row.max_tokens != binding.maxOutputTokens):
        raise HTTPException(409, "Original execution model binding differs")
    return row, selection.reasoning_effort


def build_client(data, model, *, reasoning_effort=None):
    from langchain_openai import ChatOpenAI
    from provider_chat import preserve_reasoning
    from langchain_core.messages import AIMessage, AIMessageChunk
    relay = (model.config or {}).get("synplex_relay") or {}
    effort = reasoning_effort or (model.config or {}).get("reasoning_effort")
    if (not enabled(data) or not model.provider.startswith("synplex-run:")
            or model.base_url != data["model_relay_endpoint"] or relay.get("model") != model.model
            or relay.get("endpoint") != model.base_url or model.max_retries != 0 or model.timeout != 90
            or model.max_tokens != relay.get("maxOutputTokens")
            or effort != (relay.get("effort") or "default")):
        raise RuntimeError("本次执行模型设置不一致，不能自动替换。")

    class RelayChat(ChatOpenAI):
        def _create_chat_result(self, response, generation_info=None):
            result = super()._create_chat_result(response, generation_info)
            raw = response if isinstance(response, dict) else response.model_dump()
            for generation, choice in zip(result.generations, raw.get("choices", [])):
                preserve_reasoning(generation.message, choice.get("message", {}))
            return result

        def _convert_chunk_to_generation_chunk(self, chunk, default_chunk_class, base_generation_info):
            result = super()._convert_chunk_to_generation_chunk(chunk, default_chunk_class, base_generation_info)
            choices = chunk.get("choices") or []
            if result and choices and isinstance(result.message, AIMessageChunk):
                preserve_reasoning(result.message, choices[0].get("delta") or {})
            return result

        def _get_request_payload(self, input_, *, stop=None, **kwargs):
            body = super()._get_request_payload(input_, stop=stop, **kwargs)
            # Chat Completions providers such as DeepSeek require their private
            # reasoning field on the next tool round. It is never public UI text.
            if relay["apiMode"] == "chat-completions":
                for original, target in zip(self._convert_input(input_).to_messages(), body.get("messages", [])):
                    if isinstance(original, AIMessage) and "reasoning_content" in original.additional_kwargs:
                        target["reasoning_content"] = original.additional_kwargs["reasoning_content"]
            return body

    return RelayChat(model=model.model, base_url=model.base_url, api_key=model.api_key,
                     max_tokens=model.max_tokens, temperature=None,
                     reasoning_effort=None if effort == "default" else effort,
                     request_timeout=90, max_retries=0,
                     use_responses_api=relay["apiMode"] == "responses", output_version="v0",
                     metadata={"synplex_context_window": relay["contextWindow"]})


def configure(root, endpoint):
    from engine_runtime import configuration
    from engine_recovery import settled
    from private_infrastructure import write_private
    import fcntl
    import os
    validate_endpoint(endpoint)
    saved, _, data = configuration(root)
    if data.get("model_mode") != "disabled":
        raise RuntimeError("仅能为尚未启用模型的独立引擎设置工作台连接。")
    settled(root)
    with open(root / "startup.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.chmod(lock.name, 0o600)
        settled(root, lock)
        if configuration(root)[0] != saved:
            raise RuntimeError("原引擎设置已变化，未覆盖。")
        write_private(root / "provider-update-incomplete.json", {"format": "synplex.engine-relay-update/1", "modelCalls": 0})
        data.update(model_mode="relay", model_relay_endpoint=endpoint)
        saved["providerConfigured"] = True
        write_private(root / "engine/bootstrap.json", data)
        write_private(root / "engine-startup.json", saved)
        (root / "provider-update-incomplete.json").unlink()
    return {"configured": True, "modelCalls": 0}
