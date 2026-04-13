# syntax=docker/dockerfile:1

# Pre-built binaries are supplied via the build context (binaries/<arch>/*).
# No compilation happens here — just copy and set up the runtime environment.

FROM debian:bookworm-slim

ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r -g 1001 bound \
    && useradd -r -u 1001 -g bound -d /app -s /sbin/nologin bound

COPY binaries/${TARGETARCH}/bound     /usr/local/bin/bound
COPY binaries/${TARGETARCH}/boundctl  /usr/local/bin/boundctl
COPY binaries/${TARGETARCH}/bound-mcp /usr/local/bin/bound-mcp
COPY binaries/${TARGETARCH}/boundcurl /usr/local/bin/boundcurl

WORKDIR /app

RUN mkdir -p config data && chown -R bound:bound /app

USER bound

# config/ — required JSON configs: allowlist.json, model_backends.json
#           optional: network.json, platforms.json, sync.json, mcp.json, etc.
#           persona.md for a custom agent system prompt
# data/   — SQLite database (bound.db) and Ed25519 keypair (host.key / host.pub)
VOLUME ["/app/config", "/app/data"]

# Two listeners: sync (PORT, default 3000) and web UI (WEB_PORT, default 3001).
# Sync port handles hub-spoke replication (Ed25519 authenticated).
# Web port serves the UI and API (DNS-rebinding protected, bind to localhost).
# In production, expose only the sync port externally.
EXPOSE 3000 3001

ENTRYPOINT ["bound", "start", "--config-dir", "/app/config"]
