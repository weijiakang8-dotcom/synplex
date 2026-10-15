"""Human entry for the existing first-idle transfer, not a new recovery mode."""
from __future__ import annotations

import os
from pathlib import Path
import shlex
import sys

from handoff_state import private_directory


def write_recovery_entry(snapshot, target, *, node, tool=None, python=None):
    snapshot, target = private_directory(snapshot), private_directory(target)
    tool = Path(__file__).resolve().parents[2] / "scripts/runtime/recovery-handoff.py" if tool is None else Path(tool)
    python = sys.executable if python is None else str(python)
    if not all(Path(path).is_absolute() for path in [node, tool, python]):
        raise RuntimeError("恢复入口缺少明确的程序位置，没有生成入口。")
    quote = lambda text: shlex.quote(str(text))
    title = "核对并启用副本.command"
    script = (
        '#!/bin/zsh\n'
        f'if [[ "${{0:A:h}}" != {quote(target)} ]]; then\n'
        "  printf '%s\\n' '这个入口已被移动，请回到原恢复目录；没有停用或启动任何实例。'\n"
        '  exit 1\nfi\n'
        "printf '%s\\n' '核对并启用这份恢复副本'\n"
        f"printf '%s\\n' {quote('备份：' + str(snapshot))} {quote('副本：' + str(target))}\n"
        "printf '%s\\n' '请先正常关闭原实例和副本。这里只接管无未完成任务的首次恢复。'\n"
        "printf '%s\\n' '通过核对后，原实例将停止使用；原目录必须保留原位置。不会重做历史任务。'\n"
        "printf '%s' '确认继续请输入“接续”，其他输入取消：'\n"
        'IFS= read -r synplexRecoveryAnswer\n'
        'if [[ "$synplexRecoveryAnswer" != "接续" ]]; then\n'
        "  printf '%s\\n' '已取消，原实例和副本未改动。'\n"
        '  exit 0\nfi\n'
        f'{quote(python)} -I -B {quote(tool)} {quote(snapshot)} "${{0:A:h}}" --node {quote(node)} --human\n'
        'synplexRecoveryStatus=$?\n'
        'if [[ "$synplexRecoveryStatus" -eq 0 ]]; then\n'
        "  printf '%s\\n' '核对完成。请打开这个恢复目录内 workspace 文件夹中的“打开Synplex.command”。'\n"
        'else\n'
        "  printf '%s\\n' '尚未完成。保留原目录、备份和副本；核对后使用本入口续接，不要再次恢复或重发任务。'\n"
        'fi\nexit "$synplexRecoveryStatus"\n'
    )
    file = target / title
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(script)
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(target, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return title
