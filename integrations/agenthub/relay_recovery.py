"""Remap only an offline restored relay's own workspace connection.

Completed task model rows and provider tokens keep their original identities.
Unfinished tasks remain subject to the existing idle-transfer rejection.
"""
from urllib.parse import urlsplit
from private_infrastructure import read_private


def workspace_relay_endpoint(workspace):
    endpoint = read_private(workspace / "connection.json").get("endpoint", "")
    url = urlsplit(endpoint)
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
            or not 1024 <= url.port <= 65535 or url.path or url.query or url.fragment
            or url.username or url.password or endpoint != f"http://127.0.0.1:{url.port}"):
        raise RuntimeError("恢复工作台的连接地址无法核对，执行器保持停用。")
    return endpoint + "/internal/model/v1"


def remap_restored_relay(snapshot_workspace, restored_workspace, data):
    if data.get("model_mode") != "relay":
        return data
    if data.get("model_relay_endpoint") != workspace_relay_endpoint(snapshot_workspace):
        raise RuntimeError("原模型连接不属于这份工作台快照，未映射。")
    return {**data, "model_relay_endpoint": workspace_relay_endpoint(restored_workspace)}


def verify_restored_relay(snapshot_workspace, restored_workspace, original, restored):
    if original.get("model_mode") != "relay":
        return False
    expected = remap_restored_relay(snapshot_workspace, restored_workspace, original)
    if restored.get("model_relay_endpoint") != expected["model_relay_endpoint"]:
        raise RuntimeError("恢复模型连接没有指向已核对的工作台，执行器保持停用。")
    return True
