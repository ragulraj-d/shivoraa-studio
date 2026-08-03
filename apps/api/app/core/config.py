"""Application configuration. All settings come from environment variables (12-factor)."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # SHIVORAA_ prefix so our variables can't collide with anything else in the
    # container's environment (e.g. a generic DATABASE_URL from a platform).
    model_config = SettingsConfigDict(
        env_prefix="SHIVORAA_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- App ---
    app_name: str = "Shivoraa Studio"
    environment: Literal["local", "staging", "production"] = "local"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"

    # --- Deployment mode ---
    # In self_hosted mode the SSRF guard permits private networks, because reaching
    # internal services is the entire point of running it yourself.
    deployment_mode: Literal["saas", "self_hosted"] = "saas"

    # --- Database ---
    database_url: str = "postgresql+asyncpg://shivoraa:shivoraa@localhost:5432/shivoraa"
    db_pool_size: int = 20
    db_max_overflow: int = 10
    db_echo: bool = False

    # --- Security ---
    secret_key: str = Field(default="dev-only-change-me-in-production-please-32b")
    # Fernet key for encrypting provider keys and secret variables at rest.
    # Generate with:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    encryption_key: str = Field(default="")
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 30
    jwt_algorithm: str = "HS256"

    # --- Google Sign-In ---
    # The public OAuth client ID from Google Cloud Console. Only the client ID
    # is needed: the browser obtains an ID token and the server verifies its
    # signature against Google's public keys, so there is no client secret and
    # no redirect-callback flow to secure.
    google_client_id: str = ""

    # --- CORS ---
    # Explicit allow-list. Never a wildcard, never a regex ending in the domain
    # (which would match evilshivoraa.in).
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:4173",
        "https://app.shivoraa.in",
    ]

    # --- Cookies ---
    cookie_secure: bool = False  # True in staging/production
    cookie_samesite: Literal["lax", "strict", "none"] = "lax"
    # Host-only cookie: Domain is deliberately never set, so a compromised
    # subdomain cannot read or overwrite the refresh token.
    refresh_cookie_name: str = "__Host-sv_refresh"

    # --- Request execution ---
    exec_timeout_seconds: int = 60
    exec_connect_timeout_seconds: int = 10
    exec_max_body_bytes: int = 50 * 1024 * 1024  # 50 MB
    exec_max_redirects: int = 5

    # --- AI ---
    ai_default_timeout_seconds: int = 120
    ai_context_token_budget: int = 8000
    ai_trial_actions: int = 50

    # --- Rate limits (requests per window) ---
    rate_limit_auth: int = 5
    rate_limit_auth_window_seconds: int = 900
    rate_limit_exec: int = 100
    rate_limit_ai: int = 30
    rate_limit_window_seconds: int = 60

    @field_validator("database_url", mode="before")
    @classmethod
    def _normalise_database_url(cls, v: object) -> object:
        """Accept the URL shape hosting platforms actually hand out.

        Render, Heroku, Railway and friends all inject `postgres://...`, which
        SQLAlchemy 2 rejects, and none of them offer an async driver. Rewriting
        here means the app runs on any of them with no per-platform config and
        no manual copy-paste step that someone will eventually get wrong.
        """
        if not isinstance(v, str) or not v:
            return v
        if v.startswith("postgres://"):
            v = v.replace("postgres://", "postgresql+asyncpg://", 1)
        elif v.startswith("postgresql://"):
            v = v.replace("postgresql://", "postgresql+asyncpg://", 1)

        # asyncpg does not understand libpq's `sslmode`; it uses `ssl`.
        if "+asyncpg" in v and "sslmode=" in v:
            v = v.replace("sslmode=require", "ssl=require")
            v = v.replace("sslmode=prefer", "ssl=prefer")
        return v

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
