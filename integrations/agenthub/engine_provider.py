"""Explicit private-provider setup. No discovery, ping, model call, or shared edits.

Only evaluated, fixed provider/model pairs are eligible. Directory entries alone
never grant access, and configuration never probes an account or its balance.
"""
from dataclasses import dataclass, field
import fcntl
import json
import os
from pathlib import Path
import uuid

from private_infrastructure import read_private, write_private, OwnedInfrastructure

MODELS = ("deepseek-flash", "deepseek-v4-pro")
BASE_URL = "https://api.deepseek.com/v1"
PROVIDERS = {
    "deepseek": (BASE_URL, MODELS),
    "moonshot": ("https://api.moonshot.cn/v1", ("kimi-k3",)),
}


def token_value(path):
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_uid != os.getuid() or stat.st_mode & 0o077 or stat.st_size > 4096:
        raise RuntimeError("模型连接资料需要是仅本人可读的小文件。")
    value = path.read_text().strip()
    if not value or len(value) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise RuntimeError("模型连接资料格式不正确，请保留原文件并核对。")
    return value


@dataclass(frozen=True)
class Provider:
    id: str
    models: tuple[str, ...]
    max_tokens: int
    credential: str = field(repr=False)
    provider: str = "deepseek"

    @property
    def base_url(self):
        return PROVIDERS[self.provider][0]

    @property
    def default_effort(self):
        return "max" if self.provider == "moonshot" else "low"

    @property
    def marker(self):
        return "synplex-runtime-provider:" + self.id

    def accepts(self, row):
        return row.provider == self.provider and row.model in self.models and row.base_url == self.base_url and row.api_key == self.marker


def load_provider(directory, data):
    file = directory / "provider.json"
    if data.get("model_mode") == "disabled":
        if file.exists():
            raise RuntimeError("模型状态与连接资料不一致，不能自动启用。")
        return None
    if data.get("model_mode") != "configured":
        raise RuntimeError("独立引擎的模型状态无法识别。")
    saved = read_private(file)
    if (not isinstance(saved, dict) or set(saved) != {"format", "id", "engineId", "provider", "models", "maxTokens"}
            or saved["format"] != "synplex.engine-provider/1"
            or saved["engineId"] != data["id"] or not isinstance(saved["id"], str)
            or len(saved["id"]) != 32 or any(c not in "0123456789abcdef" for c in saved["id"])):
        raise RuntimeError("模型连接不属于当前独立引擎。")
    validate_models(saved["models"], saved["maxTokens"], saved["provider"])
    return Provider(saved["id"], tuple(saved["models"]), saved["maxTokens"], token_value(directory / "provider-key"), saved["provider"])


def validate_models(models, max_tokens, provider="deepseek"):
    if not isinstance(provider, str) or provider not in PROVIDERS:
        raise RuntimeError("请选择已核对连接方式的厂商；其他厂商暂未开放。")
    allowed = PROVIDERS[provider][1]
    if (not isinstance(models, list) or not models or any(not isinstance(model, str) or model not in allowed for model in models)
            or len(models) != len(set(models)) or type(max_tokens) is not int or not 512 <= max_tokens <= 8192):
        raise RuntimeError("请选择已核对的型号和合适的输出上限；其他型号尚未开放。")


def configure(root, spec_file):
    from engine_runtime import configuration
    from engine_recovery import settled
    from local_runner import database_connection
    import psycopg
    root = root.resolve()
    saved, infra, data = configuration(root)
    if data.get("runtime_format") != "synplex.engine-runtime/2" or data.get("model_mode") != "disabled":
        raise RuntimeError("此入口只配置尚未启用模型的独立引擎，不更改活动模型或旧项目。")
    spec = read_private(spec_file)
    if not isinstance(spec, dict) or set(spec) != {"provider", "models", "maxTokens", "tokenFile"}:
        raise RuntimeError("请只填写厂商、型号、输出上限和私有连接文件；不能更改连接地址。")
    validate_models(spec["models"], spec["maxTokens"], spec["provider"])
    if not isinstance(spec["tokenFile"], str) or not Path(spec["tokenFile"]).is_absolute():
        raise RuntimeError("请明确指定仅本人可读的连接资料文件。")
    credential = token_value(Path(spec["tokenFile"]))
    settled(root)
    with open(root / "startup.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.chmod(lock.name, 0o600)
        settled(root, lock)
        owned = OwnedInfrastructure(infra)
        try:
            owned.start_database()
            with psycopg.connect(**database_connection(data, data["database"])) as db:
                if db.execute("SELECT to_regclass('public.executions')").fetchone()[0]:
                    active = db.execute("SELECT count(*) FROM executions WHERE status IN ('pending','running','waiting_for_approval')").fetchone()[0]
                    unpublished = db.execute("SELECT count(*) FROM outbox_events WHERE published_at IS NULL").fetchone()[0]
                    if active or unpublished:
                        raise RuntimeError("还有原任务需要核对，不能更改模型连接；任务不会重发。")
        finally:
            owned.close()
        settled(root, lock)
        if configuration(root) != (saved, infra, data):
            raise RuntimeError("配置期间原引擎发生变化，请先核对。")
        if any((root / "engine" / name).exists() for name in ["provider.json", "provider-key"]):
            raise RuntimeError("已有模型连接资料，不能覆盖；请先核对原配置。")
        write_private(root / "provider-update-incomplete.json", {"format": "synplex.engine-provider-update/1", "modelCalls": 0})
        fd = os.open(root / "engine/provider-key", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write(credential)
        write_private(root / "engine/provider.json", {"format": "synplex.engine-provider/1", "id": uuid.uuid4().hex,
                      "engineId": data["id"], "provider": spec["provider"], "models": spec["models"], "maxTokens": spec["maxTokens"]})
        data["model_mode"] = "configured"
        write_private(root / "engine/bootstrap.json", data)
        saved["providerConfigured"] = True
        write_private(root / "engine-startup.json", saved)
        load_provider(root / "engine", data)
        (root / "provider-update-incomplete.json").unlink()
    return {"provider": spec["provider"], "models": spec["models"], "configured": True, "modelCalls": 0,
            "notice": "连接资料已单独保存；未验证账户余额、型号权限或真实调用。"}
