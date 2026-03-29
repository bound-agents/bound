# syntax=docker/dockerfile:1

# ---- Builder ----
FROM oven/bun:1.3 AS builder
WORKDIR /build

# Copy manifests first for better layer caching
COPY package.json bun.lock ./
COPY packages/shared/package.json    packages/shared/
COPY packages/core/package.json      packages/core/
COPY packages/sync/package.json      packages/sync/
COPY packages/sandbox/package.json   packages/sandbox/
COPY packages/llm/package.json       packages/llm/
COPY packages/agent/package.json     packages/agent/
COPY packages/platforms/package.json packages/platforms/
COPY packages/web/package.json       packages/web/
COPY packages/cli/package.json       packages/cli/

RUN bun install --frozen-lockfile

# Copy full source
COPY . .

# Build Vite SPA + embed assets + compile standalone binary to dist/bound
RUN bun run build

# ---- Runtime ----
FROM debian:bookworm-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r -g 1001 bound \
    && useradd -r -u 1001 -g bound -d /app -s /sbin/nologin bound

COPY --from=builder /build/dist/bound /usr/local/bin/bound

WORKDIR /app

RUN mkdir -p config data && chown -R bound:bound /app

USER bound

# config/ — required JSON configs: allowlist.json, model_backends.json
#           optional: network.json, platforms.json, sync.json, mcp.json, etc.
#           persona.md for a custom agent system prompt
# data/   — SQLite database (bound.db) and Ed25519 keypair (host.key / host.pub)
VOLUME ["/app/config", "/app/data"]

# The server binds to localhost by default (DNS-rebinding protection).
# To expose outside the container use --network host, or front with a
# reverse proxy (nginx, Caddy) that forwards to 127.0.0.1:3000.
EXPOSE 3000

ENTRYPOINT ["bound", "start", "--config-dir", "/app/config"]
