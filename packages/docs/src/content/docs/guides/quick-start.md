---
title: Quick Start
description: Get a local Bound instance running against your LLM backend of choice.
---

## Prerequisites

- An LLM backend (one of):
  - [Ollama](https://ollama.com) running locally — easiest to start
  - AWS Bedrock access
  - Any OpenAI-compatible endpoint (Cerebras, z.AI, OpenCode Go, etc.)
  - [umans.ai](https://code.umans.ai) — self-configuring, needs `UMANS_API_KEY`

## Install

Download the latest `bound` binary from the [releases page](https://github.com/bound-agents/bound/releases) for your platform (macOS, Linux, Windows). Make it executable and put it on your `PATH`:

```bash
# macOS / Linux
chmod +x bound
sudo mv bound /usr/local/bin/

# Or just run it from wherever you downloaded it
```

## Initialize and start

```bash
# Pick a backend
bound init --ollama
bound init --bedrock --region us-east-1
bound init --opencode-go
bound init --umans          # needs UMANS_API_KEY

bound start
```

Open [http://localhost:3001](http://localhost:3001). The sync protocol listens
on port 3000 (`PORT`); the web UI on port 3001 (`WEB_PORT`).

## Boundless — terminal coding agent

`boundless` is a separate binary (also on the [releases page](https://github.com/bound-agents/bound/releases)).
It connects to a running bound server and registers local filesystem
and shell tools into the agent's tool set:

```bash
boundless
boundless --url http://localhost:3001    # non-default server
boundless --attach <thread-id>           # resume an existing thread
```

Shell commands run in a write-confinement sandbox (seatbelt on macOS,
bubblewrap on Linux, IsolationSession on Windows): the whole filesystem is
readable but writes are confined to the working directory and `/tmp`.
