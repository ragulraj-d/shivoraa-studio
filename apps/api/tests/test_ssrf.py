"""SSRF guard tests.

These matter more than most: the proxy fetches arbitrary user-supplied URLs by
design, so a gap here is a path to the cloud metadata service.
"""

from __future__ import annotations

import ipaddress

import pytest

from app.modules.execution.ssrf import (
    BlockedTarget,
    is_blocked_ip,
    is_private_hostname,
    validate_url,
)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",  # loopback
        "169.254.169.254",  # AWS/GCP/Azure metadata — the classic target
        "10.0.0.1",  # private
        "172.16.0.1",  # private
        "192.168.1.1",  # private
        "0.0.0.0",  # "this network"
        "100.64.0.1",  # carrier-grade NAT
        "::1",  # v6 loopback
        "fc00::1",  # v6 unique local
        "fe80::1",  # v6 link-local
        "::ffff:169.254.169.254",  # v4-mapped metadata address
    ],
)
def test_blocked_addresses(ip: str) -> None:
    assert is_blocked_ip(ipaddress.ip_address(ip)) is True


@pytest.mark.parametrize("ip", ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"])
def test_public_addresses_allowed(ip: str) -> None:
    assert is_blocked_ip(ipaddress.ip_address(ip)) is False


def test_ipv4_mapped_v6_is_unwrapped() -> None:
    """An IPv4-mapped v6 address reaches the same host as the bare v4 address.

    Comparing it only against v6 ranges would let ::ffff:169.254.169.254 through.
    """
    mapped = ipaddress.ip_address("::ffff:10.0.0.1")
    assert is_blocked_ip(mapped) is True


@pytest.mark.parametrize(
    "host",
    ["localhost", "LOCALHOST", "api.local", "db.internal", "metadata.google.internal", "127.0.0.1"],
)
def test_private_hostnames(host: str) -> None:
    assert is_private_hostname(host) is True


@pytest.mark.parametrize("host", ["example.com", "api.github.com", "shivoraa.in"])
def test_public_hostnames(host: str) -> None:
    assert is_private_hostname(host) is False


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "gopher://evil.com", "ftp://x.com", "data:text/plain,hi"]
)
def test_non_http_schemes_rejected(url: str) -> None:
    with pytest.raises(BlockedTarget):
        validate_url(url)


def test_localhost_rejected_with_actionable_hint() -> None:
    with pytest.raises(BlockedTarget) as exc:
        validate_url("http://localhost:8000/api")
    # The user is told local execution is the fix, rather than hitting a dead end.
    assert exc.value.is_private is True
    assert "local" in exc.value.hint.lower()


def test_metadata_endpoint_rejected() -> None:
    with pytest.raises(BlockedTarget) as exc:
        validate_url("http://169.254.169.254/latest/meta-data/iam/security-credentials/")
    assert exc.value.is_private is True


def test_missing_hostname_rejected() -> None:
    with pytest.raises(BlockedTarget):
        validate_url("http://")


def test_self_hosted_mode_allows_private(monkeypatch: pytest.MonkeyPatch) -> None:
    """Self-hosted deployments must reach internal services — that's the point."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "deployment_mode", "self_hosted")
    target = validate_url("http://127.0.0.1:8000/health")
    assert target.host == "127.0.0.1"
    assert target.port == 8000


def test_public_url_resolves() -> None:
    target = validate_url("https://example.com/path?q=1")
    assert target.scheme == "https"
    assert target.port == 443
    assert target.host == "example.com"
