---
title: Quick start
description: Install Bound, configure one model backend, and verify a local instance.
---

This tutorial installs Bound, configures one inference backend, and starts the web UI on
your local machine.

## Prerequisites

- macOS, Linux, or Windows
- Access to one supported model backend

For a local setup without API credentials, install and start
[Ollama](https://ollama.com). Other presets support AWS Bedrock, Cerebras, z.AI,
OpenCode Go, and [umans.ai](https://code.umans.ai).

## 1. Install the binary

Download the `bound` binary for your platform from the
[GitHub releases page](https://github.com/bound-agents/bound/releases). On macOS or Linux,
make it executable and place it on your `PATH`:

```bash
chmod +x bound
sudo mv bound /usr/local/bin/
```

Verify the installation:

```bash
bound --help
```

## 2. Initialize configuration

Choose one backend preset. The following example configures a local Ollama backend:

```bash
bound init --ollama
```

Other common presets include:

```bash
bound init --bedrock --region us-east-1
bound init --opencode-go
bound init --umans
```

The `--umans` preset requires `UMANS_API_KEY`. API-backed presets read their documented
credentials from the environment.

## 3. Start Bound

Run:

```bash
bound start
```

Keep this process running. Bound serves the web UI on port `3001` and the sync protocol on
port `3000` by default.

## 4. Verify the instance

Open [the local web UI](http://localhost:3001). Create a thread and send a message. A
successful response confirms that the server, database, and selected model backend are
working.

## Add the terminal client

Download the separate `boundless` binary from the same releases page to use Bound from a
terminal:

```bash
boundless
```

Continue with [Use the `boundless` terminal client](/bound/guides/boundless/) for server
URLs, existing threads, filesystem tools, and Agent Client Protocol (ACP) mode.
