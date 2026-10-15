from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urljoin, urlsplit

import httpx


class UnsafeOutboundUrlError(ValueError):
    pass


def _is_public_ip(value: str) -> bool:
    return ipaddress.ip_address(value.split("%", 1)[0]).is_global


async def validate_public_http_url(url: str) -> None:
    parsed = urlsplit(url)
    host = parsed.hostname
    if parsed.scheme not in {"http", "https"} or not host:
        raise UnsafeOutboundUrlError("outbound URL must use public HTTP or HTTPS")

    try:
        addresses = [str(ipaddress.ip_address(host))]
    except ValueError:
        try:
            records = await asyncio.to_thread(
                socket.getaddrinfo,
                host,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except socket.gaierror as exc:
            raise UnsafeOutboundUrlError("outbound host cannot be resolved") from exc
        addresses = list({record[4][0] for record in records})

    if not addresses or any(not _is_public_ip(address) for address in addresses):
        raise UnsafeOutboundUrlError("outbound URL must use public HTTP or HTTPS")


async def request_public(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    max_redirects: int = 3,
    **kwargs,
) -> httpx.Response:
    current_url = url
    for _ in range(max_redirects + 1):
        await validate_public_http_url(current_url)
        response = await client.request(method, current_url, **kwargs)
        if not response.is_redirect:
            return response
        location = response.headers.get("location")
        if not location:
            return response
        current_url = urljoin(str(response.url), location)
    raise UnsafeOutboundUrlError("outbound URL redirected too many times")
