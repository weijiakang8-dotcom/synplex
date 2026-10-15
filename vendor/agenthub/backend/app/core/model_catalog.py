"""内置模型目录：厂商、模型、档位与各自的思考等级。

设计要点：思考等级按模型声明，不做全局枚举。不同厂商的控制方式本来就不同
（DeepSeek 用 thinking 开关加 reasoning_effort，Anthropic 用思考 token 预算，
Google 用思考预算或等级，另有若干厂商只有开/关），统一的"低/中/高"会在实际
不支持的模型上给出假选项。

`verified` 表示该条目的等级与价格是否已按官方文档或真实调用核对过。未核对的
条目可以出现在目录里供管理员参考，但默认不向终端用户开放。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ReasoningOption:
    """一个可选的思考等级。id 原样传给上游，name 用于界面展示。"""

    id: str
    name: str
    description: str = ""


@dataclass(frozen=True)
class CatalogModel:
    model: str
    display_name: str
    tier: str
    context_window: int
    reasoning: tuple[ReasoningOption, ...] = ()
    default_reasoning: str | None = None
    supports_tools: bool = True
    supports_vision: bool = False
    input_cost_per_1k: float = 0.0
    output_cost_per_1k: float = 0.0
    verified: bool = False
    note: str = ""


@dataclass(frozen=True)
class CatalogProvider:
    id: str
    name: str
    base_url: str
    api_mode: str = "chat_completions"
    models: tuple[CatalogModel, ...] = field(default_factory=tuple)


def _efforts(*pairs: tuple[str, str]) -> tuple[ReasoningOption, ...]:
    return tuple(ReasoningOption(id=pid, name=name) for pid, name in pairs)


_THINKING_OFF_ON = (
    ReasoningOption("disabled", "关闭思考", "更快更省，适合改写与整理"),
    ReasoningOption("enabled", "开启思考", "先推理再回答，适合复杂分析"),
)


PROVIDERS: dict[str, CatalogProvider] = {
    "deepseek": CatalogProvider(
        id="deepseek",
        name="DeepSeek",
        base_url="https://api.deepseek.com/v1",
        models=(
            CatalogModel(
                model="deepseek-flash",
                display_name="DeepSeek Flash",
                tier="flash",
                context_window=1_048_576,
                reasoning=_efforts(("low", "低"), ("high", "高"), ("max", "最大")),
                default_reasoning="high",
                verified=True,
                note="官方文档：thinking 开关 × 顶层 reasoning_effort",
            ),
            CatalogModel(
                model="deepseek-v4-pro",
                display_name="DeepSeek V4 Pro",
                tier="pro",
                context_window=1_048_576,
                reasoning=_efforts(("low", "低"), ("high", "高"), ("max", "最大")),
                default_reasoning="high",
                verified=True,
                note="官方文档：thinking 开关 × 顶层 reasoning_effort",
            ),
        ),
    ),
    "moonshot": CatalogProvider(
        id="moonshot",
        name="月之暗面 Kimi",
        base_url="https://api.moonshot.cn/v1",
        models=(
            CatalogModel(
                model="kimi-k3",
                display_name="Kimi K3",
                tier="pro",
                context_window=262_144,
                reasoning=_efforts(("low", "低"), ("high", "高"), ("max", "最大")),
                default_reasoning="max",
                verified=True,
                note="官方文档：顶层 reasoning_effort，默认 max",
            ),
            CatalogModel(
                model="kimi-k2.6",
                display_name="Kimi K2.6",
                tier="flash",
                context_window=262_144,
                reasoning=_efforts(("low", "低"), ("high", "高")),
                default_reasoning="high",
                note="官方文档提示各模型参数存在差异，落库前需实测",
            ),
        ),
    ),
    "openai": CatalogProvider(
        id="openai",
        name="OpenAI",
        base_url="https://api.openai.com/v1",
        api_mode="responses",
        models=(
            CatalogModel(
                model="gpt-6",
                display_name="GPT-6",
                tier="pro",
                context_window=400_000,
                reasoning=_efforts(
                    ("minimal", "最低"),
                    ("low", "低"),
                    ("medium", "中"),
                    ("high", "高"),
                ),
                default_reasoning="medium",
                note="官方文档在本机网络不可达，等级待核对",
            ),
            CatalogModel(
                model="gpt-6-astra",
                display_name="GPT-6 Astra",
                tier="pro",
                context_window=400_000,
                reasoning=_efforts(
                    ("minimal", "最低"),
                    ("low", "低"),
                    ("medium", "中"),
                    ("high", "高"),
                ),
                default_reasoning="medium",
                note="官方文档在本机网络不可达，等级待核对",
            ),
            CatalogModel(
                model="gpt-5.6-terra",
                display_name="GPT-5.6 Terra",
                tier="balanced",
                context_window=400_000,
                reasoning=_efforts(
                    ("minimal", "最低"),
                    ("low", "低"),
                    ("medium", "中"),
                    ("high", "高"),
                ),
                default_reasoning="medium",
                note="官方文档在本机网络不可达，等级待核对",
            ),
            CatalogModel(
                model="gpt-5.6-luna",
                display_name="GPT-5.6 Luna",
                tier="flash",
                context_window=400_000,
                reasoning=_efforts(
                    ("minimal", "最低"),
                    ("low", "低"),
                    ("medium", "中"),
                    ("high", "高"),
                ),
                default_reasoning="low",
                note="官方文档在本机网络不可达，等级待核对",
            ),
        ),
    ),
    "anthropic": CatalogProvider(
        id="anthropic",
        name="Anthropic Claude",
        base_url="https://api.anthropic.com",
        api_mode="anthropic_messages",
        models=(
            CatalogModel(
                model="claude-opus-4-6",
                display_name="Claude Opus 4.6",
                tier="pro",
                context_window=200_000,
                reasoning=_efforts(
                    ("off", "关闭思考"),
                    ("low", "低预算"),
                    ("high", "高预算"),
                ),
                default_reasoning="high",
                supports_vision=True,
                note="用思考 token 预算控制，落库前需按官方文档确认参数名",
            ),
            CatalogModel(
                model="claude-sonnet-4-6",
                display_name="Claude Sonnet 4.6",
                tier="balanced",
                context_window=200_000,
                reasoning=_efforts(
                    ("off", "关闭思考"),
                    ("low", "低预算"),
                    ("high", "高预算"),
                ),
                default_reasoning="high",
                supports_vision=True,
                note="同上",
            ),
        ),
    ),
    "google": CatalogProvider(
        id="google",
        name="Google Gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        models=(
            CatalogModel(
                model="gemini-3-pro",
                display_name="Gemini 3 Pro",
                tier="pro",
                context_window=1_000_000,
                reasoning=_efforts(("low", "低"), ("high", "高")),
                default_reasoning="high",
                supports_vision=True,
                note="用思考预算或思考等级控制，待核对",
            ),
            CatalogModel(
                model="gemini-3-flash",
                display_name="Gemini 3 Flash",
                tier="flash",
                context_window=1_000_000,
                reasoning=_efforts(("low", "低"), ("high", "高")),
                default_reasoning="low",
                supports_vision=True,
                note="同上",
            ),
        ),
    ),
    "xai": CatalogProvider(
        id="xai",
        name="xAI Grok",
        base_url="https://api.x.ai/v1",
        models=(
            CatalogModel(
                model="grok-4",
                display_name="Grok 4",
                tier="pro",
                context_window=256_000,
                reasoning=_efforts(("low", "低"), ("high", "高")),
                default_reasoning="high",
                supports_vision=True,
                note="reasoning_effort，待核对",
            ),
        ),
    ),
    "qwen": CatalogProvider(
        id="qwen",
        name="阿里通义千问",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        models=(
            CatalogModel(
                model="qwen3-max",
                display_name="通义千问 3 Max",
                tier="pro",
                context_window=262_144,
                reasoning=_THINKING_OFF_ON,
                default_reasoning="enabled",
                note="enable_thinking 开关，待核对",
            ),
            CatalogModel(
                model="qwen3-flash",
                display_name="通义千问 3 Flash",
                tier="flash",
                context_window=262_144,
                reasoning=_THINKING_OFF_ON,
                default_reasoning="disabled",
                note="enable_thinking 开关，待核对",
            ),
        ),
    ),
    "zhipu": CatalogProvider(
        id="zhipu",
        name="智谱 GLM",
        base_url="https://open.bigmodel.cn/api/paas/v4",
        models=(
            CatalogModel(
                model="glm-4.6",
                display_name="GLM-4.6",
                tier="pro",
                context_window=200_000,
                reasoning=_THINKING_OFF_ON,
                default_reasoning="enabled",
                note="thinking.type 开关，待核对",
            ),
        ),
    ),
    "minimax": CatalogProvider(
        id="minimax",
        name="MiniMax",
        base_url="https://api.minimaxi.com/v1",
        models=(
            CatalogModel(
                model="MiniMax-M2",
                display_name="MiniMax M2",
                tier="pro",
                context_window=200_000,
                reasoning=_THINKING_OFF_ON,
                default_reasoning="enabled",
                note="思考开关，待核对",
            ),
        ),
    ),
    "volcengine": CatalogProvider(
        id="volcengine",
        name="字节豆包（火山方舟）",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        models=(
            CatalogModel(
                model="doubao-1.6-pro",
                display_name="豆包 1.6 Pro",
                tier="pro",
                context_window=256_000,
                reasoning=_THINKING_OFF_ON,
                default_reasoning="enabled",
                note="thinking.type 开关，待核对",
            ),
        ),
    ),
    "baidu": CatalogProvider(
        id="baidu",
        name="百度文心",
        base_url="https://qianfan.baidubce.com/v2",
        models=(
            CatalogModel(
                model="ernie-4.5-turbo",
                display_name="文心 4.5 Turbo",
                tier="balanced",
                context_window=128_000,
                reasoning=_THINKING_OFF_ON,
                default_reasoning="enabled",
                note="思考开关，待核对",
            ),
        ),
    ),
    "mistral": CatalogProvider(
        id="mistral",
        name="Mistral",
        base_url="https://api.mistral.ai/v1",
        models=(
            CatalogModel(
                model="magistral-medium",
                display_name="Magistral Medium",
                tier="pro",
                context_window=128_000,
                reasoning=_efforts(("low", "低"), ("high", "高")),
                default_reasoning="high",
                note="推理强度，待核对",
            ),
        ),
    ),
    "openrouter": CatalogProvider(
        id="openrouter",
        name="OpenRouter（聚合）",
        base_url="https://openrouter.ai/api/v1",
        models=(
            CatalogModel(
                model="auto",
                display_name="自动路由（透传上游）",
                tier="aggregate",
                context_window=200_000,
                reasoning=_efforts(("low", "低"), ("medium", "中"), ("high", "高")),
                default_reasoning="medium",
                note="聚合入口，等级取决于所选上游模型",
            ),
        ),
    ),
    "siliconflow": CatalogProvider(
        id="siliconflow",
        name="硅基流动（聚合）",
        base_url="https://api.siliconflow.cn/v1",
        models=(
            CatalogModel(
                model="deepseek-ai/DeepSeek-V3",
                display_name="硅基流动 DeepSeek V3",
                tier="aggregate",
                context_window=131_072,
                reasoning=_THINKING_OFF_ON,
                default_reasoning="disabled",
                note="聚合入口，待核对",
            ),
        ),
    ),
    "ollama": CatalogProvider(
        id="ollama",
        name="本地自建（Ollama 等）",
        base_url="http://127.0.0.1:11434/v1",
        models=(
            CatalogModel(
                model="",
                display_name="自建模型（管理员填写模型名）",
                tier="self-hosted",
                context_window=32_768,
                reasoning=(),
                default_reasoning=None,
                note="自建模型没有统一思考参数，管理员按需填写",
            ),
        ),
    ),
}


def list_providers() -> list[CatalogProvider]:
    return list(PROVIDERS.values())


def find_provider(provider: str) -> CatalogProvider | None:
    return PROVIDERS.get((provider or "").strip().lower())


def find_model(provider: str, model: str) -> CatalogModel | None:
    catalog = find_provider(provider)
    if catalog is None:
        return None
    wanted = (model or "").strip()
    for item in catalog.models:
        if item.model == wanted:
            return item
    return None


def reasoning_options(provider: str, model: str) -> tuple[ReasoningOption, ...]:
    entry = find_model(provider, model)
    return entry.reasoning if entry else ()


def reasoning_ids(provider: str, model: str) -> set[str]:
    return {option.id for option in reasoning_options(provider, model)}


def default_reasoning(provider: str, model: str) -> str | None:
    entry = find_model(provider, model)
    return entry.default_reasoning if entry else None
