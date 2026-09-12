# Hypertube. Everything runs in Docker; you only need Docker Desktop.

SHELL       := /bin/bash
NAME        := hypertube

# Host architecture detection
UNAME_S     := $(shell uname -s)
UNAME_M     := $(shell uname -m)

ifeq ($(UNAME_M),arm64)
	HOST_PLATFORM := linux/arm64
else ifeq ($(UNAME_M),aarch64)
	HOST_PLATFORM := linux/arm64
else
	HOST_PLATFORM := linux/amd64
endif

# Build for the host arch so there is no QEMU emulation.
export DOCKER_DEFAULT_PLATFORM := $(HOST_PLATFORM)

# Used by `make buildx`.
MULTIARCH   := linux/amd64,linux/arm64

# docker compose v2, with a v1 fallback
COMPOSE     := $(shell if docker compose version >/dev/null 2>&1; \
	                then echo "docker compose"; else echo "docker-compose"; fi)

ENV_FILE    := .env
COMPOSE_CMD := $(COMPOSE) -p $(NAME)

# The published images carry runtime dependencies only, so linting, type
# checking and the tests run in throwaway containers built from the development
# stages. Still nothing to install on the host.
BACK_DEV    := $(NAME)-backend-dev
FRONT_DEV   := $(NAME)-frontend-dev
DEV_RUN     := docker run --rm -t

# Colours
GREEN  := \033[0;32m
YELLOW := \033[0;33m
BLUE   := \033[0;34m
RESET  := \033[0m

.DEFAULT_GOAL := help
.PHONY: help env secrets check up all build re down stop start restart \
	    logs logs-backend logs-frontend ps status shell-backend shell-frontend \
	    db psql migrate seed reset-db clean fclean prune buildx lint typecheck \
	    test test-torrent format info open

# Help
help: ## Show this help
	@printf "$(BLUE)Hypertube$(RESET) - host: $(UNAME_S)/$(UNAME_M) -> $(GREEN)$(HOST_PLATFORM)$(RESET)\n\n"
	@printf "Usage: make $(YELLOW)<target>$(RESET)\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	    | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(YELLOW)%-16s$(RESET) %s\n", $$1, $$2}'
	@printf "\nFirst run: $(GREEN)make env && make up$(RESET)\n"

# Bootstrap
env: ## Create .env from .env.example (never overwrites an existing .env)
	@if [ -f $(ENV_FILE) ]; then \
	    printf "$(YELLOW)==>$(RESET) %s already exists, leaving it untouched.\n" "$(ENV_FILE)"; \
	else \
	    cp .env.example $(ENV_FILE); \
	    printf "$(GREEN)==>$(RESET) Created %s\n" "$(ENV_FILE)"; \
	    $(MAKE) --no-print-directory secrets; \
	fi

secrets: ## Generate strong random secrets into .env
	@test -f $(ENV_FILE) || { printf "$(YELLOW)==>$(RESET) run 'make env' first\n"; exit 1; }
	@tmp=$$(mktemp); \
	acc=$$(openssl rand -hex 64); ref=$$(openssl rand -hex 64); \
	pgp=$$(openssl rand -hex 24); api=$$(openssl rand -hex 32); \
	sed -e "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$$acc|" \
	    -e "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$$ref|" \
	    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$$pgp|" \
	    -e "s|^API_CLIENT_SECRET=.*|API_CLIENT_SECRET=$$api|" \
	    $(ENV_FILE) > $$tmp && mv $$tmp $(ENV_FILE); \
	printf "$(GREEN)==>$(RESET) Random secrets written to %s\n" "$(ENV_FILE)"
	@printf "$(YELLOW)==>$(RESET) Add your TMDB_API_KEY and OAuth credentials to %s\n" "$(ENV_FILE)"

check: ## Verify Docker is installed and running
	@command -v docker >/dev/null 2>&1 || { printf "Docker is not installed.\n"; exit 1; }
	@docker info >/dev/null 2>&1 || { printf "Docker daemon is not running.\n"; exit 1; }
	@printf "$(GREEN)==>$(RESET) Docker OK (%s)\n" "$(COMPOSE)"

# Lifecycle
all: up ## Alias for `up`

up: check env ## Build (if needed) and start the whole stack
	@printf "$(BLUE)==>$(RESET) Starting Hypertube for $(HOST_PLATFORM)...\n"
	@$(COMPOSE_CMD) up -d --build
	@$(MAKE) --no-print-directory info

build: check env ## Force a rebuild of every image
	@$(COMPOSE_CMD) build --pull

re: fclean up ## Full rebuild from scratch

down: ## Stop and remove the containers (data volumes are kept)
	@$(COMPOSE_CMD) down --remove-orphans

stop: ## Stop the containers without removing them
	@$(COMPOSE_CMD) stop

start: ## Start previously stopped containers
	@$(COMPOSE_CMD) start

restart: ## Restart every service
	@$(COMPOSE_CMD) restart

# Observability
logs: ## Follow the logs of every service
	@$(COMPOSE_CMD) logs -f --tail=120

logs-backend: ## Follow the backend logs
	@$(COMPOSE_CMD) logs -f --tail=200 backend

logs-frontend: ## Follow the frontend logs
	@$(COMPOSE_CMD) logs -f --tail=200 frontend

ps: ## Show container status
	@$(COMPOSE_CMD) ps

status: ps ## Alias for `ps`

info: ## Print the URLs of the running services
	@source $(ENV_FILE) 2>/dev/null; \
	printf "\n  $(GREEN)Hypertube is up$(RESET)\n"; \
	printf "  ----------------------------------------\n"; \
	printf "  App          $(BLUE)http://localhost:%s$(RESET)\n" "$${WEB_PORT:-8080}"; \
	printf "  REST API     $(BLUE)http://localhost:%s/api$(RESET)\n" "$${WEB_PORT:-8080}"; \
	printf "  API docs     $(BLUE)http://localhost:%s/api/docs$(RESET)\n" "$${WEB_PORT:-8080}"; \
	printf "  MailHog      $(BLUE)http://localhost:8025$(RESET)\n"; \
	printf "  Postgres     localhost:%s\n" "$${POSTGRES_HOST_PORT:-5433}"; \
	printf "  ----------------------------------------\n\n"

open: ## Open the app in the default browser
	@source $(ENV_FILE) 2>/dev/null; open "http://localhost:$${WEB_PORT:-8080}" 2>/dev/null \
	    || xdg-open "http://localhost:$${WEB_PORT:-8080}" 2>/dev/null || true

# Shells / database
shell-backend: ## Open a shell in the backend container
	@$(COMPOSE_CMD) exec backend sh

shell-frontend: ## Open a shell in the frontend container
	@$(COMPOSE_CMD) exec frontend sh

db: ## Open a psql prompt on the database
	@source $(ENV_FILE); $(COMPOSE_CMD) exec -e PGPASSWORD=$$POSTGRES_PASSWORD postgres \
	    psql -U $$POSTGRES_USER -d $$POSTGRES_DB

psql: db ## Alias for `db`

migrate: ## Run pending SQL migrations
	@$(COMPOSE_CMD) exec backend node dist/db/migrate.js

seed: ## Populate the database with demo users and comments
	@$(COMPOSE_CMD) exec backend node dist/db/seed.js

reset-db: ## Drop the database volume and re-migrate (DESTRUCTIVE)
	@printf "$(YELLOW)==>$(RESET) This deletes all users, comments and watch history. Ctrl-C to abort.\n"
	@sleep 3
	@$(COMPOSE_CMD) down -v
	@$(MAKE) --no-print-directory up

# Quality
dev-images: ## Build the images used by lint/typecheck/test
	@docker build -q -t $(BACK_DEV)  --target development ./backend  >/dev/null
	@docker build -q -t $(FRONT_DEV) --target builder     ./frontend >/dev/null

lint: dev-images ## Run ESLint on backend and frontend
	@printf "$(BLUE)==>$(RESET) backend\n"
	@$(DEV_RUN) -v "$(PWD)/backend/src:/app/src:ro" $(BACK_DEV) npm run --silent lint
	@printf "$(BLUE)==>$(RESET) frontend\n"
	@$(DEV_RUN) -v "$(PWD)/frontend/src:/app/src:ro" $(FRONT_DEV) npm run --silent lint
	@printf "$(GREEN)==>$(RESET) no lint errors\n"

typecheck: dev-images ## Run the TypeScript compiler in check mode
	@printf "$(BLUE)==>$(RESET) backend\n"
	@$(DEV_RUN) -v "$(PWD)/backend/src:/app/src:ro" $(BACK_DEV) npm run --silent typecheck
	@printf "$(BLUE)==>$(RESET) frontend\n"
	@$(DEV_RUN) -v "$(PWD)/frontend/src:/app/src:ro" $(FRONT_DEV) npm run --silent typecheck
	@printf "$(GREEN)==>$(RESET) types are sound\n"

test: dev-images ## Run the test suite (bencode, wire protocol, storage, picker)
	@$(DEV_RUN) -v "$(PWD)/backend/src:/app/src:ro" $(BACK_DEV) npm run --silent test

test-torrent: dev-images ## Run only the BitTorrent engine tests
	@$(DEV_RUN) -v "$(PWD)/backend/src:/app/src:ro" $(BACK_DEV) npm run --silent test:torrent


# Cleaning
clean: down ## Stop the stack and remove dangling build cache
	@docker image prune -f >/dev/null 2>&1 || true
	@printf "$(GREEN)==>$(RESET) Containers removed.\n"

fclean: ## Remove containers, volumes, images and downloaded media (DESTRUCTIVE)
	@$(COMPOSE_CMD) down -v --rmi local --remove-orphans 2>/dev/null || true
	@rm -rf data/media/* data/torrents/* data/avatars/* 2>/dev/null || true
	@printf "$(GREEN)==>$(RESET) Everything removed.\n"

prune: fclean ## fclean + a global Docker prune
	@docker system prune -af --volumes

# Multi-architecture image publishing (bonus)
buildx: ## Build linux/amd64 + linux/arm64 images with buildx
	@docker buildx inspect hypertube-builder >/dev/null 2>&1 \
	    || docker buildx create --name hypertube-builder --use
	@docker buildx use hypertube-builder
	@docker buildx build --platform $(MULTIARCH) -t $(NAME)-backend:latest  ./backend
	@docker buildx build --platform $(MULTIARCH) -t $(NAME)-frontend:latest ./frontend
	@printf "$(GREEN)==>$(RESET) Multi-arch images built for $(MULTIARCH)\n"
