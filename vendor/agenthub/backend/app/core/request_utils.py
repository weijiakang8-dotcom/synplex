from __future__ import annotations

import ipaddress

from fastapi import Request

from app.config import settings


def get_client_ip(request: Request) -> str:
    """Trust forwarding headers only from explicitly configured proxies."""
    peer = request.client.host if request.client else "unknown"
    try:
        peer_address = ipaddress.ip_address(peer)
    except ValueError:
        return peer
    trusted = []
    for value in settings.TRUSTED_PROXY_IPS.split(","):
        value = value.strip()
        if not value:
            continue
        try:
            trusted.append(ipaddress.ip_network(value, strict=False))
        except ValueError:
            continue
    if not any(peer_address in network for network in trusted):
        return peer

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()

    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()

    return peer
