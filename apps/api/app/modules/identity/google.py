"""Google ID token verification.

The browser obtains an ID token from Google Identity Services and posts it here.
We verify its signature against Google's published JWKS rather than calling a
Google endpoint per login — that keeps sign-in fast and works even if Google's
tokeninfo endpoint is slow.

Verifying locally means the checks must be done properly and completely:
signature, issuer, audience, and expiry. Skipping any one of them turns this
into "trust whatever the client sent", which is worse than no auth at all.
"""

from __future__ import annotations

import time
from typing import Any

import jwt
import structlog
from jwt import PyJWKClient

from app.core.config import settings
from app.core.errors import AuthenticationError, ValidationError

log = structlog.get_logger()

GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}

# Cached across requests — Google rotates these keys slowly, and the client
# refetches automatically when it sees an unknown key id.
_jwk_client: PyJWKClient | None = None


def _client() -> PyJWKClient:
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = PyJWKClient(GOOGLE_CERTS_URL, cache_keys=True, lifespan=3600)
    return _jwk_client


async def verify_google_id_token(id_token: str) -> dict[str, Any]:
    if not settings.google_client_id:
        raise ValidationError(
            "Google sign-in isn't configured on this server.",
            hint="Set SHIVORAA_GOOGLE_CLIENT_ID, or sign in with an email and password.",
            code="google_not_configured",
        )

    try:
        signing_key = _client().get_signing_key_from_jwt(id_token)
        claims: dict[str, Any] = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256"],
            # `audience` must be our client ID. Without this check, a token
            # issued for any other Google app would be accepted here.
            audience=settings.google_client_id,
            options={"require": ["exp", "iat", "aud", "iss", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise AuthenticationError(
            "That Google sign-in expired.", hint="Try signing in again."
        ) from exc
    except jwt.InvalidAudienceError as exc:
        raise AuthenticationError(
            "That Google token was issued for a different app.",
            hint="Check SHIVORAA_GOOGLE_CLIENT_ID matches the client ID the browser used.",
        ) from exc
    except jwt.PyJWTError as exc:
        log.warning("google_token_invalid", error=str(exc))
        raise AuthenticationError("That Google sign-in couldn't be verified.") from exc

    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise AuthenticationError("That token wasn't issued by Google.")

    if not claims.get("sub"):
        raise AuthenticationError("That Google token is missing a subject.")

    # Belt and braces: PyJWT already enforces exp, but an unexpectedly large
    # clock skew should fail closed rather than silently extend a session.
    if claims.get("exp", 0) < time.time():
        raise AuthenticationError("That Google sign-in expired.")

    return claims
