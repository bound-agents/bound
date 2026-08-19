---
title: Quick start
description: Install Bound with a local Ollama backend and verify your first working instance.
---

This tutorial installs Bound with Ollama, starts a local server, and verifies the setup by
sending your first message in the web UI. The commands below are for macOS and Linux. For
Windows, download the appropriate binary from the
[GitHub releases page](https://github.com/bound-agents/bound/releases).

## Prerequisites

- macOS or Linux
- [Ollama](https://ollama.com), installed and running with a usable model available

This tutorial uses Ollama so that you can complete the setup without API credentials.

## 1. Install Bound

Download the `bound` binary for your platform from the
[GitHub releases page](https://github.com/bound-agents/bound/releases).

Make the binary executable and move it to a system directory on your `PATH`:

```bash
chmod +x bound
sudo mv bound /usr/local/bin/
```

Alternatively, install it without elevated privileges by moving it to a user-owned
directory:

```bash
chmod +x bound
mkdir -p ~/.local/bin
mv bound ~/.local/bin/
```

Ensure that `~/.local/bin` is on your `PATH` when you use the non-privileged installation.

Confirm that your shell can run the binary:

```bash
bound --help
```

The command should print the command-line help.

## 2. Configure Ollama

Initialize Bound with the Ollama preset:

```bash
bound init --ollama
```

This creates the configuration for the local backend.

## 3. Start Bound

Start the server:

```bash
bound start
```

Keep this process running. By default, Bound serves the web UI on port `3001` and the sync
protocol on port `3000`.

## 4. Send a message

1. Open [the local web UI](http://localhost:3001).
2. Create a thread.
3. Send a message.

A successful response confirms that the web UI can send a request through this Bound server
to the configured Ollama backend. This smoke test does not independently verify every
internal component or persistence behavior.

## Use another backend

The following commands are alternatives to `bound init --ollama`, not sequential steps. Run
only the command for the backend you want to configure:

```bash
bound init --bedrock --region us-east-1
bound init --opencode-go
bound init --umans
```

The `--umans` preset requires `UMANS_API_KEY`. API-backed presets read their documented
credentials from the environment. Bound also provides presets for Cerebras and z.AI; see
the [`bound init` reference](/bound/guides/cli-operations/#bound-init) for all presets and
credential variables.

## Optional next step

[Use the `boundless` terminal client](/bound/guides/boundless/) for terminal-based workflows.

## Troubleshoot the setup

### `bound` isn't found

Confirm that the downloaded binary matches your platform, is executable, and is in a
directory on your `PATH`.

### The web UI doesn't open

Confirm that `bound start` is still running, then open `http://localhost:3001` again.

### A message doesn't receive a response

Confirm that Ollama is running and has a usable model available. If you selected an
API-backed preset instead, confirm that its documented credential is available in the
environment where you started Bound.
