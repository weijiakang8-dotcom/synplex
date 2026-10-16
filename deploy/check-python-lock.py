"""Refuse a container hash lock that changes the evaluated engine versions."""
from pathlib import Path
import re
import sys


def pins(text):
    result = re.findall(r"^([A-Za-z0-9_.-]+)==([^\s]+)", text, re.M)
    if len(dict(result)) != len(result):
        raise ValueError("Duplicate locked package")
    return dict(result)


root = Path(__file__).resolve().parents[1]
original = pins((root / "vendor/agenthub/backend/requirements.lock").read_text())
hashed = (root / "deploy/requirements-container.lock").read_text()
if not original or original != pins(hashed):
    sys.exit("Container versions differ from the evaluated engine lock")
for line in hashed.splitlines():
    if not line.strip() or line.startswith("#"):
        continue
    if not (re.fullmatch(r"[A-Za-z0-9_.-]+==[^\s]+ \\", line)
            or re.fullmatch(r"    --hash=sha256:[a-f0-9]{64}( \\)?", line)):
        sys.exit("Unexpected hash lock content")
print("Container package versions match; pip will verify artifact hashes.")
