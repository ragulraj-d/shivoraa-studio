"""Security primitives: hashing, tokens, encryption, redaction."""

from __future__ import annotations

import pytest

from app.core.security import (
    CryptoService,
    hash_password,
    hash_token,
    redact_mapping,
    redact_text,
    verify_password,
)


# --------------------------------------------------------------------------- #
# Passwords
# --------------------------------------------------------------------------- #
def test_password_round_trip() -> None:
    hashed = hash_password("correct horse battery staple")
    assert verify_password("correct horse battery staple", hashed) is True
    assert verify_password("wrong password entirely", hashed) is False


def test_hashes_are_salted() -> None:
    """Identical passwords must not produce identical hashes."""
    assert hash_password("same-password") != hash_password("same-password")


def test_verify_does_not_raise_on_garbage() -> None:
    assert verify_password("anything", "not-a-valid-hash") is False


# --------------------------------------------------------------------------- #
# Tokens
# --------------------------------------------------------------------------- #
def test_token_hash_is_deterministic() -> None:
    assert hash_token("abc") == hash_token("abc")
    assert hash_token("abc") != hash_token("abd")


# --------------------------------------------------------------------------- #
# Encryption
# --------------------------------------------------------------------------- #
def test_encryption_round_trip() -> None:
    from cryptography.fernet import Fernet

    crypto = CryptoService(Fernet.generate_key().decode())
    ciphertext = crypto.encrypt("sk-secret-value")
    assert b"sk-secret-value" not in ciphertext
    assert crypto.decrypt(ciphertext) == "sk-secret-value"


def test_wrong_key_cannot_decrypt() -> None:
    from cryptography.fernet import Fernet

    a = CryptoService(Fernet.generate_key().decode())
    b = CryptoService(Fernet.generate_key().decode())
    with pytest.raises(ValueError):
        b.decrypt(a.encrypt("secret"))


# --------------------------------------------------------------------------- #
# Redaction — the control that keeps secrets out of logs and AI prompts
# --------------------------------------------------------------------------- #
def test_known_secret_becomes_named_placeholder() -> None:
    """The model should still understand the request shape, without the value."""
    text = "Authorization: Bearer tok_live_abcdef123456"
    result = redact_text(text, {"API_TOKEN": "tok_live_abcdef123456"})
    assert "tok_live_abcdef123456" not in result
    assert "{{API_TOKEN}}" in result


@pytest.mark.parametrize(
    "secret",
    [
        "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        "AKIAIOSFODNN7EXAMPLE",
        "AIzaSyD-abcdefghijklmnopqrstuvwxyz12345",
    ],
)
def test_credential_patterns_are_redacted(secret: str) -> None:
    result = redact_text(f"key is {secret} here", None)
    assert secret not in result
    assert "[REDACTED]" in result


def test_sensitive_keys_redacted_at_any_depth() -> None:
    data = {
        "user": "ada",
        "password": "hunter2",
        "nested": {"api_key": "abc123", "safe": "visible"},
        "list": [{"token": "xyz"}],
    }
    result = redact_mapping(data)
    assert result["password"] == "[REDACTED]"
    assert result["nested"]["api_key"] == "[REDACTED]"
    assert result["list"][0]["token"] == "[REDACTED]"
    # Non-sensitive fields must survive, or the logs become useless.
    assert result["user"] == "ada"
    assert result["nested"]["safe"] == "visible"


def test_header_names_are_matched_case_insensitively() -> None:
    result = redact_mapping({"Authorization": "Bearer abc", "X-Api-Key": "k"})
    assert result["Authorization"] == "[REDACTED]"
    assert result["X-Api-Key"] == "[REDACTED]"


def test_longest_secret_replaced_first() -> None:
    """A short secret contained inside a longer one must not corrupt the longer match."""
    secrets = {"SHORT": "abc123", "LONG": "abc123456789"}
    result = redact_text("value abc123456789 end", secrets)
    assert "{{LONG}}" in result


# --------------------------------------------------------------------------- #
# Database URL normalisation — hosting platforms hand out URLs SQLAlchemy rejects
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("given", "expected"),
    [
        # Render, Heroku and Railway all inject this form.
        ("postgres://u:p@host:5432/db", "postgresql+asyncpg://u:p@host:5432/db"),
        ("postgresql://u:p@host:5432/db", "postgresql+asyncpg://u:p@host:5432/db"),
        # Already correct — must be left alone.
        ("postgresql+asyncpg://u:p@host/db", "postgresql+asyncpg://u:p@host/db"),
        ("sqlite+aiosqlite:///./dev.db", "sqlite+aiosqlite:///./dev.db"),
        # asyncpg uses `ssl`, not libpq's `sslmode`.
        ("postgres://u:p@h/db?sslmode=require", "postgresql+asyncpg://u:p@h/db?ssl=require"),
    ],
)
def test_database_url_is_normalised(given: str, expected: str) -> None:
    from app.core.config import Settings

    assert Settings(database_url=given).database_url == expected
