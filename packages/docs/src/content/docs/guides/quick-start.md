---
title: Quick Start
description: Get a local Bound instance running against your LLM backend of choice.
---

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- An LLM backend (one of):
  - [Ollama](https://ollama.com) running locally — easiest to start
  - AWS Bedrock access
  - Any OpenAI-compatible endpoint (Cerebras, z.AI, OpenCode Go, etc.)
  - [umans.ai](https://code.umans.ai) — self-configuring, needs `UMANS_API_KEY`

## Install and run

```bash
git clone https://github.com/bound-agents/bound.git
cd bound
bun install

# Pick a backend
bun run packages/cli/src/bound.ts init --ollama
bun run packages/cli/src/bound.ts init --bedrock --region us-east-1
bun run packages/cli/src/bound.ts init --opencode-go
bun run packages/cli/src/bound.ts init --umans          # needs UMANS_API_KEY

bun run packages/cli/src/bound.ts start
```

Open [http://localhost:3001](http://localhost:3001). The sync protocol listens
on port 3000 (`PORT`); the web UI on port 3001 (`WEB_PORT`).

Build a single binary instead:

```bash
bun run build
./dist/bound init --ollama && ./dist/bound start
```

## Boundless — terminal coding agent

`boundless` connects to a running bound server and registers local filesystem
and shell tools into the agent's tool set:

```bash
bun run packages/cli/src/boundless.ts    # or ./dist/boundless after a build
boundless --url http://localhost:3001    # non-default server
boundless --attach <thread-id>           # resume an existing thread
```

Shell commands run in a write-confinement sandbox (seatbelt on macOS,
bubblewrap on Linux, IsolationSession on Windows): the whole filesystem is
readable but writes are confined to the working directory and `/tmp`.
