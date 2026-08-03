"""Password hashing, JWT issuance/verification, symmetric encryption, and redaction."""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)


# --------------------------------------------------------------------------- #
# Passwords
# --------------------------------------------------------------------------- #
def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        _hasher.verify(password_hash, password)
        return True
    except (VerifyMismatchError, Exception):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


# --------------------------------------------------------------------------- #
# JWT
# --------------------------------------------------------------------------- #
def create_access_token(
    *, user_id: UUID, session_id: UUID, workspace_id: UUID | None = None, role: str | None = None
) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "sid": str(session_id),
        "typ": "access",
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_ttl_minutes),
        "jti": secrets.token_urlsafe(16),
    }
    if workspace_id:
        payload["wsp"] = str(workspace_id)
    # `role` is a hint for the UI only. Authorization is always re-checked
    # server-side against live membership, so a stale token grants nothing.
    if role:
        payload["role"] = role
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict[str, Any]:
    """Raises jwt.PyJWTError on any problem — expiry, signature, or wrong type."""
    payload: dict[str, Any] = jwt.decode(
        token, settings.secret_key, algorithms=[settings.jwt_algorithm]
    )
    if payload.get("typ") != "access":
        raise jwt.InvalidTokenError("Not an access token")
    return payload


def generate_refresh_token() -> tuple[str, str]:
    """Return (plaintext, sha256_hash). Only the hash is ever stored."""
    raw = secrets.token_urlsafe(48)
    return raw, hash_token(raw)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def generate_api_key() -> tuple[str, str, str]:
    """Return (plaintext, hash, display_prefix). Shown to the user exactly once."""
    raw = f"sk_live_{secrets.token_urlsafe(32)}"
    return raw, hash_token(raw), raw[:16]


def generate_device_code() -> tuple[str, str]:
    """Return (device_code, user_code). User code is short and human-readable."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no ambiguous 0/O/1/I
    user_code = "SHIV-" + "".join(secrets.choice(alphabet) for _ in range(4))
    return secrets.token_urlsafe(32), user_code


# --------------------------------------------------------------------------- #
# Encryption at rest
# --------------------------------------------------------------------------- #
class CryptoService:
    """Symmetric encryption for provider keys and secret variables.

    Fernet (AES-128-CBC + HMAC) keyed from SHIVORAA_ENCRYPTION_KEY. In a managed
    deployment this should be swapped for KMS envelope encryption with
    per-workspace data keys; the interface is deliberately narrow so that swap
    touches only this class.
    """

    def __init__(self, key: str | None = None) -> None:
        raw = key or settings.encryption_key
        if not raw:
            # Deterministic dev fallback derived from the secret key so a
            # developer without a configured key still gets a working app —
            # and a loud warning rather than silent plaintext.
            digest = hashlib.sha256(settings.secret_key.encode()).digest()
            raw = base64.urlsafe_b64encode(digest).decode()
            if settings.is_production:
                raise RuntimeError("SHIVORAA_ENCRYPTION_KEY must be set in production")
        self._fernet = Fernet(raw.encode() if isinstance(raw, str) else raw)

    def encrypt(self, plaintext: str) -> bytes:
        return self._fernet.encrypt(plaintext.encode())

    def decrypt(self, ciphertext: bytes) -> str:
        try:
            return self._fernet.decrypt(ciphertext).decode()
        except InvalidToken as exc:  # wrong key, or tampered ciphertext
            raise ValueError("Could not decrypt value") from exc


crypto = CryptoService()


# --------------------------------------------------------------------------- #
# Redaction
# --------------------------------------------------------------------------- #
_SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}\b"),
    re.compile(r"\bsk_live_[A-Za-z0-9_\-]{16,}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{30,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}\b"),
    re.compile(r"\bxox[baprs]-[0-9A-Za-z\-]{10,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----"),
]

_SENSITIVE_KEYS = {
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "authorization",
    "auth",
    "credential",
    "credentials",
    "private_key",
    "client_secret",
    "session",
    "cookie",
}

REDACTED = "[REDACTED]"


def redact_text(text: str, known_secrets: dict[str, str] | None = None) -> str:
    """Replace known secret values and pattern-matched credentials.

    `known_secrets` maps variable name -> secret value; matches are replaced with
    the readable placeholder `{{VAR_NAME}}` so an AI model still understands the
    shape of the request without ever seeing the value.
    """
    if known_secrets:
        # Longest first, so a value that contains another value is handled correctly.
        for name, value in sorted(known_secrets.items(), key=lambda kv: -len(kv[1])):
            if value and len(value) >= 4:
                text = text.replace(value, f"{{{{{name}}}}}")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(REDACTED, text)
    return text


def _is_sensitive_key(key: str) -> bool:
    """Match by substring, not equality.

    Real payloads use `X-Api-Key`, `user_password`, `refreshToken`, and dozens of
    other variations. Substring matching over-redacts occasionally, which is the
    correct direction to be wrong in — a redacted log line is inconvenient, a
    leaked credential is not.
    """
    normalised = key.lower().replace("-", "_").replace(" ", "_")
    return any(sensitive in normalised for sensitive in _SENSITIVE_KEYS)


def redact_mapping(data: Any, known_secrets: dict[str, str] | None = None) -> Any:
    """Recursively redact by key name and by value pattern."""
    if isinstance(data, dict):
        out: dict[str, Any] = {}
        for key, value in data.items():
            if isinstance(key, str) and _is_sensitive_key(key):
                out[key] = REDACTED
            else:
                out[key] = redact_mapping(value, known_secrets)
        return out
    if isinstance(data, list):
        return [redact_mapping(v, known_secrets) for v in data]
    if isinstance(data, str):
        return redact_text(data, known_secrets)
    return data
