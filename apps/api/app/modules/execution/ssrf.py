"""SSRF protection for the request proxy.

The platform fetches arbitrary user-supplied URLs by design, which makes it an
SSRF engine unless deliberately constrained.

Validating the hostname alone is not enough: an attacker controls DNS, so
`evil.com` can resolve to a public address when we validate and to
169.254.169.254 when we connect (DNS rebinding). The defence here resolves the
host once, validates *every* returned address, and then connects to a pinned IP
so no second resolution can occur. Redirects re-enter the same check.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

import structlog

from app.core.config import settings

log = structlog.get_logger()

# Ranges that must never be reachable from the hosted proxy.
BLOCKED_V4 = [
    ipaddress.ip_network("0.0.0.0/8"),  # "this network"
    ipaddress.ip_network("10.0.0.0/8"),  # private
    ipaddress.ip_network("100.64.0.0/10"),  # carrier-grade NAT
    ipaddress.ip_network("127.0.0.0/8"),  # loopback
    ipaddress.ip_network("169.254.0.0/16"),  # link-local — cloud metadata lives here
    ipaddress.ip_network("172.16.0.0/12"),  # private
    ipaddress.ip_network("192.0.0.0/24"),  # IETF protocol assignments
    ipaddress.ip_network("192.0.2.0/24"),  # TEST-NET-1
    ipaddress.ip_network("192.168.0.0/16"),  # private
    ipaddress.ip_network("198.18.0.0/15"),  # benchmarking
    ipaddress.ip_network("198.51.100.0/24"),  # TEST-NET-2
    ipaddress.ip_network("203.0.113.0/24"),  # TEST-NET-3
    ipaddress.ip_network("224.0.0.0/4"),  # multicast
    ipaddress.ip_network("240.0.0.0/4"),  # reserved
]

BLOCKED_V6 = [
    ipaddress.ip_network("::/128"),  # unspecified
    ipaddress.ip_network("::1/128"),  # loopback
    ipaddress.ip_network("fc00::/7"),  # unique local
    ipaddress.ip_network("fe80::/10"),  # link-local
    ipaddress.ip_network("ff00::/8"),  # multicast
    ipaddress.ip_network("::ffff:0:0/96"),  # IPv4-mapped — must be unwrapped, not trusted
    ipaddress.ip_network("64:ff9b::/96"),  # NAT64
]

ALLOWED_SCHEMES = {"http", "https"}

# Hosts that are obviously private, checked before DNS as a cheap fast path.
PRIVATE_HOST_SUFFIXES = (".local", ".internal", ".localhost", ".home.arpa")
PRIVATE_HOSTNAMES = {"localhost", "metadata.google.internal", "metadata.goog"}


class BlockedTarget(Exception):
    """The target is refused by policy."""

    def __init__(self, reason: str, hint: str, *, is_private: bool = False) -> None:
        self.reason = reason
        self.hint = hint
        # Signals to the caller that local execution would work, which turns a
        # dead end into an actionable next step.
        self.is_private = is_private
        super().__init__(reason)


@dataclass(slots=True)
class ResolvedTarget:
    host: str
    port: int
    scheme: str
    ip: str
    family: int


def is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        # An IPv4-mapped v6 address (::ffff:169.254.169.254) reaches the same
        # host as the bare v4 address, so it must be unwrapped and re-checked
        # rather than compared against v6 ranges alone.
        if ip.ipv4_mapped is not None:
            return is_blocked_ip(ip.ipv4_mapped)
        return any(ip in net for net in BLOCKED_V6)
    return any(ip in net for net in BLOCKED_V4)


def is_private_hostname(host: str) -> bool:
    host = host.lower().rstrip(".")
    if host in PRIVATE_HOSTNAMES or host.endswith(PRIVATE_HOST_SUFFIXES):
        return True
    try:
        return is_blocked_ip(ipaddress.ip_address(host))
    except ValueError:
        return False


def validate_url(url: str) -> ResolvedTarget:
    """Validate a URL and return the single IP the caller must connect to.

    In self-hosted mode private ranges are permitted, because reaching internal
    services is the reason someone runs it themselves.
    """
    parsed = urlparse(url)

    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise BlockedTarget(
            f"Only http and https URLs can be sent ({parsed.scheme or 'no scheme'} was given).",
            "Check the URL starts with http:// or https://.",
        )

    host = (parsed.hostname or "").strip().rstrip(".")
    if not host:
        raise BlockedTarget("That URL has no hostname.", "Check the URL is complete.")

    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    allow_private = settings.deployment_mode == "self_hosted"

    if not allow_private and is_private_hostname(host):
        raise BlockedTarget(
            f"{host} is only reachable from your own machine, not from Shivoraa's servers.",
            "Send this request locally instead — the VS Code extension can reach it.",
            is_private=True,
        )

    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise BlockedTarget(
            f"Couldn't look up {host}.",
            "Check the hostname is spelled correctly and the domain exists.",
        ) from exc

    if not infos:
        raise BlockedTarget(f"{host} didn't resolve to any address.", "Check the hostname.")

    # Every resolved address must pass. A host that returns one public and one
    # private address is a rebinding attempt, not a misconfiguration.
    chosen: ResolvedTarget | None = None
    for family, _type, _proto, _canon, sockaddr in infos:
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue

        if not allow_private and is_blocked_ip(ip):
            log.warning("ssrf_blocked", host=host, resolved_ip=ip_str)
            raise BlockedTarget(
                f"{host} resolves to a private address ({ip_str}), which Shivoraa's "
                "servers won't connect to.",
                "Send this request locally instead if the service runs on your network.",
                is_private=True,
            )

        if chosen is None:
            chosen = ResolvedTarget(
                host=host, port=port, scheme=parsed.scheme.lower(), ip=ip_str, family=family
            )

    if chosen is None:
        raise BlockedTarget(f"Couldn't resolve {host} to a usable address.", "Check the hostname.")

    return chosen
