---
title: Use the boundless terminal client
description: Connect a terminal workspace to Bound and expose local file, shell, and MCP tools.
---

The `boundless` terminal client connects one working directory to a Bound thread. It adds
host-side file and shell tools while keeping messages, memory, and tool calls in the shared
Bound state.

## Prerequisites

- A running Bound server
- The `boundless` binary on your `PATH`

## Start a session

```bash
boundless
```

By default, the client connects to `http://localhost:3001` and creates a thread for the
current working directory.

Connect to another server:

```bash
boundless --url http://my-server:3001
```

Resume an existing thread:

```bash
boundless --attach <thread-id>
```

## Configure the client

Configuration lives in `~/.bound/less/`:

| File | Purpose |
| --- | --- |
| `config.json` | Server URL, default model, injected context files, and shell override |
| `mcp.json` | Local MCP servers (separate from the server's `mcp.json`) |

## Understand filesystem access

Shell commands run in an OS-level write-confinement sandbox:

| Platform | Mechanism |
| --- | --- |
| macOS | `seatbelt` (sandbox-exec profile) |
| Linux | `bubblewrap` (`bwrap`) |
| Windows | `IsolationSession` |

The agent can read the host filesystem. Writes are confined to the working directory and
temporary directories allowed by the platform sandbox.

The client registers these tools against the real working directory:

- `boundless_read` reads files with stable line anchors.
- `boundless_write` creates or replaces files atomically.
- `boundless_edit` applies anchored edits from a prior read.
- `boundless_search` searches files with regular expressions.
- `boundless_bash` executes a command in the sandbox.
- `boundless_copy` copies a file between the host and Bound's virtual filesystem.

Anchored reads let the agent address exact lines without reproducing their full text.

## Read tool output

Shell results show up to 32 visual rows. Larger results retain the first and last 16 rows
around an elision marker. Results that exceed the universal 256 KiB cap are offloaded
before they reach the transcript.

Consecutive reads, searches, and database queries share one compact result group. Failed
calls retain their diagnostic output.

## Monitor the session

The status area shows the connection state, thread ID, selected model, MCP server count,
and working directory. Copy the full thread ID when you need to reconnect with `--attach`.

An additional row appears when measurements are available:

| Segment | Meaning |
| --- | --- |
| `ctx 44% (87k/200k)` | Provider-reported context-window use after the last turn. |
| `$1.05 session / $12.34 today` | Cluster-wide session and daily spend. |
| `● 3 background` | Background tool calls in flight on this thread (see [Run an errand in the background](/bound/concepts/auxiliary-agents/#run-an-errand-in-the-background)). |

Segments remain hidden until they have a value.

## Connect an ACP editor

`boundless --acp` runs as an [Agent Client Protocol](https://agentclientprotocol.com) agent over stdio, letting ACP-compatible editors (Zed, others) drive bound as their backend agent.

The editor spawns `boundless --acp` as a subprocess and speaks JSON-RPC over stdin/stdout. Bound provides inference, memory, and model routing; the filesystem and shell tools execute locally in the editor's workspace, gated through the editor's permission prompts.

Existing bound threads can be resumed via the protocol's `session/load`.

### Configure Zed

```json
{
  "agent_servers": {
    "bound": {
      "type": "custom",
      "command": "boundless",
      "args": ["--acp"],
      "env": {}
    }
  }
}
```

In ACP mode, stdout is reserved for JSON-RPC. Diagnostics go to
`~/.bound/less/logs/`, with fatal startup errors also written to stderr. ACP clients open
sessions through `session/new` and `session/load`; `--attach` does not apply.

## Command-line reference

| Option | Description |
| --- | --- |
| `--url <url>` | Override the configured server URL for this run (not persisted). Default `http://localhost:3001`. |
| `--attach <thread-id>` | Attach to an existing thread instead of creating a new one. |
| `--acp` | Run as an ACP agent server over stdio instead of rendering the terminal UI. |
