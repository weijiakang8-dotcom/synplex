"""Fixed Chat Completions transports with provider reasoning round trips.

The pinned generic client intentionally omits non-OpenAI reasoning fields.
Keep the documented field on messages/checkpoints, never in public progress.
No global SDK patch, discovery, fallback or extra provider dependency.
"""
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_openai import ChatOpenAI


def preserve_reasoning(message, source):
    value = source.get("reasoning_content")
    if value is not None:
        if not isinstance(value, str):
            raise RuntimeError("模型回复中的思考记录格式不正确，请保留原任务后核对。")
        message.additional_kwargs["reasoning_content"] = value


class ProviderChat(ChatOpenAI):
    def _create_chat_result(self, response, generation_info=None):
        result = super()._create_chat_result(response, generation_info)
        raw = response if isinstance(response, dict) else response.model_dump()
        for generation, choice in zip(result.generations, raw.get("choices", [])):
            preserve_reasoning(generation.message, choice.get("message", {}))
        return result

    def _convert_chunk_to_generation_chunk(self, chunk, default_chunk_class, base_generation_info):
        result = super()._convert_chunk_to_generation_chunk(chunk, default_chunk_class, base_generation_info)
        choices = chunk.get("choices") or chunk.get("chunk", {}).get("choices", [])
        if result and choices and isinstance(result.message, AIMessageChunk):
            preserve_reasoning(result.message, choices[0].get("delta") or {})
        return result

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        if (payload.get("model") != self.model_name or payload.get("reasoning_effort") != self.reasoning_effort
                or payload.get("max_completion_tokens") != self.max_tokens or payload.get("extra_body") != self.extra_body
                or payload.get("temperature") is not None or payload.get("n", 1) != 1 or payload.get("reasoning") is not None):
            raise RuntimeError("本次请求与已确认的型号、思考设置或输出上限不一致，未发送请求。")
        original = self._convert_input(input_).to_messages()
        outgoing = payload.get("messages", [])
        if len(original) != len(outgoing):
            raise RuntimeError("模型对话格式发生变化，不能自动省略原记录。")
        for message, target in zip(original, outgoing):
            if isinstance(message, AIMessage):
                reasoning = message.additional_kwargs.get("reasoning_content")
                if reasoning is not None:
                    if not isinstance(reasoning, str):
                        raise RuntimeError("原对话的思考记录格式不正确，请先核对。")
                    target["reasoning_content"] = reasoning
        return payload


def build_client(profile, model, *, reasoning_effort=None):
    if not profile.accepts(model):
        raise RuntimeError("所选型号不属于这份已配置的模型连接。")
    effort = reasoning_effort or (model.config or {}).get("reasoning_effort") or profile.default_effort
    if (effort not in {"low", "high", "max"} or model.max_tokens != profile.max_tokens
            or model.timeout != 90 or model.max_retries != 0):
        raise RuntimeError("所选型号或思考设置超出已配置范围，请重新选择。")
    return ProviderChat(model=model.model, base_url=profile.base_url, api_key=profile.credential,
                        max_tokens=profile.max_tokens, temperature=None, reasoning_effort=effort,
                        request_timeout=90, max_retries=0, use_responses_api=False, output_version="v0",
                        extra_body={"thinking": {"type": "enabled"}} if profile.provider == "deepseek" else None,
                        metadata={"synplex_context_window": (model.config or {}).get("capabilities", {}).get("context_window")})
