<div align="center">

# ◈ Shivoraa Studio

**An API workspace where the AI has actually read your project.**

Send requests, inspect responses, and ask questions — without pasting context into a chat window.

[![CI](https://github.com/ragulraj-d/shivoraa-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/ragulraj-d/shivoraa-studio/actions/workflows/ci.yml)

</div>

---

## What this is

Most AI features bolted onto developer tools see a text box. Shivoraa's assistant sees the request you're editing, the response that just failed, your environment variable names, and the neighbouring requests in your collection — because context assembly is a first-class service, not a prompt-string helper.

The practical difference: you ask *"why does this return 401?"* and get an answer about your specific `Authorization` header, not a general explanation of HTTP status codes.

## Status

Working software, early. The core loop runs end to end:

| Area | State |
|---|---|
| Auth — register, login, JWT + rotating refresh, API keys, device flow | ✅ Working |
| Workspaces, members, three roles enforced server-side | ✅ Working |
| Collections, folders, requests, optimistic-concurrency saves | ✅ Working |
| Environments, variable interpolation, encrypted secrets | ✅ Working |
| Request execution with SSRF-hardened proxy, timing waterfall | ✅ Working |
| AI: 7 providers, context manager, streaming chat, cost accounting | ✅ Working |
| Web dashboard | ✅ Working |
| VS Code extension | 🔜 API is ready (`/executions/plan`, device flow) |
| Import/export, mocks, monitors, CLI, plugins | 🔜 Planned |

**80 backend tests passing. Lint clean. ~100 KB gzipped frontend.**

---

## Quick start

No Docker or Postgres needed — the schema is dialect-portable, so local development runs on SQLite.

```bash
git clone https://github.com/ragulraj-d/shivoraa-studio.git
cd shivoraa-studio

make install     # Python venv + npm packages
make api         # → http://localhost:8000  (docs at /docs)
make web         # → http://localhost:5173  (in a second terminal)
```

Open http://localhost:5173, create an account, and send a request. You get a personal workspace and a Development environment automatically.

### With Docker (Postgres)

```bash
cp .env.example .env     # then edit it
docker compose up -d --build
```

App at `http://localhost:8080`, API at `http://localhost:8000`.

### Make targets

```
make install   Install all dependencies
make api       Run the API with hot reload
make web       Run the web app
make test      Run the test suite
make lint      Lint and typecheck everything
make build     Production build
make up/down   Docker stack
```

---

## Architecture

**Modular monolith, service-ready.** Three deployable processes; strict module boundaries in code. Every module owns its domain and exposes a typed interface — extracting one into a service later is a transport change, not a redesign.

```
apps/
├── api/                      FastAPI · SQLAlchemy 2.0 async · PostgreSQL
│   └── app/
│       ├── core/             config, db, security, deps, errors, middleware
│       └── modules/
│           ├── identity/     register, login, token rotation, device flow
│           ├── workspace/    workspaces, members, roles
│           ├── collection/   collections, folders, requests, repositories
│           ├── environment/  environments, variables, secret encryption
│           ├── execution/    resolver · SSRF guard · HTTP proxy
│           └── ai/           providers · context manager · prompts · SSE
└── web/                      React 18 · TypeScript · Vite · Tailwind
    └── src/
        ├── components/       layout, collections, request, response, ai
        ├── pages/            login, register, device, studio, settings
        ├── lib/              API client, SSE streaming, types, utils
        └── store/            Zustand — auth, workspace draft
```

Dependency direction is strictly one-way. Notably **nothing depends on the `ai` module** — which is what makes "an AI outage never breaks the workspace" structurally true rather than aspirational.

---

## Three decisions worth explaining

### 1. The SSRF guard is not optional

This platform fetches arbitrary user-supplied URLs by design. That makes it an SSRF engine pointed at its own cloud metadata endpoint unless deliberately constrained.

Validating the hostname is not enough — an attacker controls DNS, so `evil.com` can resolve to a public address at validation time and to `169.254.169.254` at connection time. So [`ssrf.py`](apps/api/app/modules/execution/ssrf.py) resolves the host, validates **every** returned address, and **every redirect hop re-enters the same check**. A public URL that redirects to the metadata service is the classic bypass; that's where it dies.

Blocked: loopback, link-local (including IPv4-mapped IPv6 like `::ffff:169.254.169.254`), all RFC 1918 ranges, CGNAT, and multicast. In `self_hosted` mode private networks are allowed, because reaching your own internal services is the entire reason to self-host.

### 2. `localhost` is the hard problem, and the answer is honesty

A cloud API client cannot reach your `localhost:8000`. That is the single largest UX cliff in this category of product, and pretending otherwise loses users permanently.

So Shivoraa detects it and says exactly what's happening, with a route forward:

> `localhost:8000` is only reachable from your own machine.
> **Send this request from the VS Code extension, which runs it locally.**

The server resolves the request into an `ExecutionPlan` and hands it to the extension, which executes it locally and returns an identical result shape. **Both paths share one resolver** — two resolution code paths would produce mode-dependent bugs, the worst possible class of bug here.

### 3. The AI context panel is a trust mechanism

Sending your API data to a third-party model is a real concern, so the answer is verification, not reassurance.

Before the model's first token arrives, the server streams a **context manifest** — every item, its token cost, and whether it was included. The UI panel renders that same structure, so what the user sees cannot drift from what was sent. Anything dropped for budget is listed explicitly rather than silently truncated.

Secret values never enter the context at all. They're replaced with `{{VAR_NAME}}` placeholders, so the model understands the request's shape without seeing a credential.

Untrusted response bodies are wrapped in delimited `<context>` blocks with a system instruction that content inside is data to analyse, never instructions to follow — because an API response containing *"ignore previous instructions"* is an attack, not a payload.

---

## Security

| Control | Implementation |
|---|---|
| Passwords | Argon2id, per-password salt |
| Sessions | 15-min access JWT in memory (never `localStorage`), rotating refresh in an `HttpOnly` host-only cookie |
| Token theft | Refresh reuse detection — a replayed token revokes the whole session and is treated as an incident |
| Secrets at rest | Fernet-encrypted; swap `CryptoService` for KMS envelope encryption in production |
| Tenant isolation | Enforced in a scoped repository base class, verified by tests |
| Authorization | Re-checked against live membership on every request, never trusted from the JWT |
| Account enumeration | Login failures return identical messages and run a constant-time hash either way |
| SSRF | Five-layer defence (above) |
| Secret leakage | A redactor runs inside the log formatter itself, so a developer cannot forget it |
| Rate limiting | Sliding window per endpoint class |

**Before production:** set `SHIVORAA_ENCRYPTION_KEY` and a real `SHIVORAA_SECRET_KEY`, set `SHIVORAA_COOKIE_SECURE=true`, and move rate-limit counters to Redis if running more than one API replica (they're in-process today).

---

## AI providers

Bring your own key. Seven adapters behind one interface, so no vendor is load-bearing:

**OpenAI · Anthropic · Google Gemini · Groq · Ollama (local) · OCI · any OpenAI-compatible endpoint**

Keys are validated with a live call before saving — a typo discovered three days later reads as a broken product. Every call records tokens, latency, and cost to `ai_usage`, so per-feature model routing (cheap model for docs, strong model for debugging) is a real cost lever with real numbers behind it.

New users get 50 free actions on a platform key if `SHIVORAA_TRIAL_OPENAI_KEY` is set, so they can feel the difference before signing up for a third-party account.

---

## Deploying

Live at **studio.shivoraa.in**, deployed from GitHub on every push to `main`.

```
studio.shivoraa.in  →  Firebase Hosting   (SPA, global CDN)
api.shivoraa.in     →  Cloud Run          (FastAPI, scales to zero)
                    →  Neon               (PostgreSQL)
```

The API is on Cloud Run rather than Firebase because Hosting serves static files
only, and its rewrite proxy buffers responses — which would break the AI panel's
SSE streaming. Both hosts are `shivoraa.in` subdomains, so they are same-site and
the refresh cookie works with `SameSite=Lax`.

Full walkthrough — GCP setup, secrets, Workload Identity Federation, DNS,
rollback — in **[DEPLOY.md](DEPLOY.md)**. A single-VPS alternative with automatic
TLS is in `docker-compose.prod.yml` and `infra/Caddyfile`.

## Testing

```bash
make test                                    # everything
cd apps/api && .venv/bin/pytest -m "not network"   # skip outbound calls
```

Coverage focuses where correctness matters most: the SSRF deny-list (including IPv4-mapped IPv6 and redirect chains), variable resolution and auth inheritance, secret redaction, tenant isolation, optimistic-concurrency conflicts, and a full register → collection → send → history walkthrough.

---

## Roadmap

**Next:** VS Code extension (the API already exposes `/executions/plan` and the device flow) · import from Postman/OpenAPI/cURL · saved response examples.

**Then:** AI-generated docs and tests surfaced in the UI · collection runner · mock servers · CLI for CI.

**Later:** plugin marketplace · monitors · SDK generation.

The module contract exists so new capabilities register the same way a third-party plugin would. Shivoraa is designed as a developer platform that happens to start with APIs — not an API client with features stapled on.

---

## Licence

Source-available. See `LICENSE`.
