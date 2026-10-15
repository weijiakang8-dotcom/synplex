"""Private credential and fixed destination guards; stdlib-only free CI."""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])
from engine_provider import load_provider, validate_models, PROVIDERS
from private_infrastructure import write_private

root = Path(sys.argv[2])
key = root / "provider-key"
key.write_text("test-only-not-a-real-key")
os.chmod(key, 0o600)
engine = {"id": "owned-engine", "model_mode": "configured"}
base = {"format": "synplex.engine-provider/1", "id": "a" * 32,
        "engineId": engine["id"], "provider": "moonshot", "models": ["kimi-k3"], "maxTokens": 512}

def rejected(action):
    try:
        action()
    except RuntimeError:
        return
    raise AssertionError("Unsafe provider configuration accepted")

for provider, (url, models) in PROVIDERS.items():
    saved = {**base, "provider": provider, "models": list(models)}
    write_private(root / "provider.json", saved)
    profile = load_provider(root, engine)
    assert profile.provider == provider and profile.base_url == url
    assert "test-only" not in repr(profile)
    row = SimpleNamespace(provider=provider, model=models[0], base_url=url, api_key=profile.marker)
    assert profile.accepts(row)
    for change in [{"provider": "unreviewed"}, {"model": "not-enabled"}, {"base_url": url + "/other"}, {"api_key": "other-engine"}]:
        assert not profile.accepts(SimpleNamespace(**{**vars(row), **change}))
    for change in [{"engineId": "other-engine"}, {"id": "bad"}, {"provider": "unreviewed"},
                   {"provider": ["moonshot"]}, {"models": ["unreviewed"]}, {"maxTokens": True},
                   {"maxTokens": 8193}, {"baseUrl": "http://127.0.0.1"}, {"models": list(models) * 2}]:
        write_private(root / "provider.json", {**saved, **change})
        rejected(lambda: load_provider(root, engine))
write_private(root / "provider.json", base)
rejected(lambda: load_provider(root, {**engine, "model_mode": "disabled"}))
os.chmod(key, 0o644)
rejected(lambda: load_provider(root, engine))
os.chmod(key, 0o600)
key.rename(root / "original-key")
key.symlink_to(root / "original-key")
rejected(lambda: load_provider(root, engine))
validate_models(["deepseek-flash"], 512)  # Existing v1 profiles remain valid.
print(json.dumps({"credentialAndDestinationGuards": "passed", "modelCalls": 0}))
