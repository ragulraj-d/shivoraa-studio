.PHONY: help install dev api web test lint build up down migrate clean

help:  ## Show this help
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install:  ## Install all dependencies
	cd apps/api && python3 -m venv .venv && .venv/bin/pip install -q -e ".[dev]"
	cd apps/web && npm install

migrate:  ## Apply database migrations
	cd apps/api && .venv/bin/alembic upgrade head

api:  ## Run the API (SQLite, no Postgres needed)
	cd apps/api && SHIVORAA_DATABASE_URL="sqlite+aiosqlite:///./dev.db" \
		.venv/bin/alembic upgrade head && \
		SHIVORAA_DATABASE_URL="sqlite+aiosqlite:///./dev.db" \
		.venv/bin/uvicorn app.main:app --reload --port 8000

web:  ## Run the web app
	cd apps/web && npm run dev

test:  ## Run the test suite
	cd apps/api && .venv/bin/python -m pytest -q

lint:  ## Lint and typecheck everything
	cd apps/api && .venv/bin/ruff check app tests && .venv/bin/ruff format --check app tests
	cd apps/web && npx tsc --noEmit

build:  ## Build the web app for production
	cd apps/web && npm run build

up:  ## Start the full stack with Docker
	docker compose up -d --build

down:  ## Stop the stack
	docker compose down

clean:  ## Remove build artefacts and local databases
	rm -rf apps/web/dist apps/web/node_modules apps/api/.venv apps/api/*.db
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
