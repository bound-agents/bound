---
title: Boundless
description: The terminal coding-agent client — connect to bound, get filesystem and shell tools in your agent's toolset.
---

`boundless` is a terminal coding-agent client. It connects to a running bound server over a client-tool WebSocket interface, attaches to one thread, and registers host-side filesystem and shell tools (plus optional MCP servers) into that thread's tool set. Session messages, tool calls, and memory operations are written to bound, so other surfaces observe the work.

## Getting started

```bash
# If bound is running locally:
boundless

# Connect to a non-default server:
boundless --url http://my-server:3001

# Resume an existing thread:
boundless --attach <thread-id>
```

A running bound server (`bound start`) is required. Boundless connects to the web server port (default 3001).

## Configuration

Configuration lives in `~/.bound/less/`:

| File | Purpose |
| --- | --- |
| `config.json` | Server URL, default model, injected context files, shell override |
| `mcp.json` | Local MCP servers (separate from the server's `mcp.json`) |

## Filesystem sandbox

Shell commands run in an OS-level write-confinement sandbox:

| Platform | Mechanism |
| --- | --- |
| macOS | `seatbelt` (sandbox-exec profile) |
| Linux | `bubblewrap` (`bwrap`) |
| Windows | `IsolationSession` |

The whole filesystem is readable — the agent can inspect any file on your machine. But writes are confined to the current working directory and `/tmp`. This lets the agent explore your codebase freely while preventing accidental writes outside the project.

## File tools

Boundless registers host-side file tools that operate on the real working directory:

- **`boundless_read`** — read a file in hashline format (line:hash|content), with offset/limit paging
- **`boundless_write`** — create or overwrite a file (atomic, creates parents)
- **`boundless_edit`** — edit a file using hashline anchors from a prior read; ranges validated atomically
- **`boundless_search`** — regex search across files, returning grep-style matches with hashline anchors
- **`boundless_bash`** — execute a shell command in the sandbox
- **`boundless_copy`** — copy a file between the satellite (host) and main (VFS) environments

The hashline format gives the LLM stable 4-character anchors to address specific lines without reproducing their text. The anchors survive line drift, so edits land correctly even if the file shifted since the read.

## Status bar

The bar under the input line carries the session's live state. The identity row is always present — connection badge, full thread ID (rendered untruncated so you can select and copy it for `--attach`), model, MCP server count, and the working directory on the right edge.

Above it, a measurements row appears only once it has something real to report:

| Segment | Meaning |
| --- | --- |
| `ctx 44% (87k/200k)` | Context-window pressure after the last turn, colored green → yellow → red as it climbs. Provider-reported tokens, not a local estimate. |
| `$1.05 session · $12.34 today` | Cluster-wide spend since you started this session and since local midnight. |
| `● 3 background` | Background tool calls in flight on this thread (see [Backgrounding an errand](/bound/concepts/auxiliary-agents/#backgrounding-an-errand)). |

Each segment hides rather than showing a zero, so a fresh session reports nothing instead of a row of placeholder numbers. The background count in particular only appears while work is actually running, and it reflects server state rather than a local tally — attaching to a thread that already has background work shows the count immediately, and a dropped frame corrects itself on the next update instead of drifting.

## ACP mode

`boundless --acp` runs as an [Agent Client Protocol](https://agentclientprotocol.com) agent over stdio, letting ACP-compatible editors (Zed, others) drive bound as their backend agent.

The editor spawns `boundless --acp` as a subprocess and speaks JSON-RPC over stdin/stdout. Bound provides inference, memory, and model routing; the filesystem and shell tools execute locally in the editor's workspace, gated through the editor's permission prompts.

Existing bound threads can be resumed via the protocol's `session/load`.

### Zed configuration

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

In ACP mode, stdout is the JSON-RPC channel — boundless writes nothing else to stdout. Diagnostics go to the file logger at `~/.bound/less/logs/` and to stderr for fatal startup errors. `--attach` is ignored in ACP mode; ACP clients open sessions via `session/new` and `session/load`.

## Command-line options

| Option | Description |
| --- | --- |
| `--url <url>` | Override the configured server URL for this run (not persisted). Default `http://localhost:3001`. |
| `--attach <thread-id>` | Attach to an existing thread instead of creating a new one. |
| `--acp` | Run as an ACP agent server over stdio instead of rendering the terminal UI. |
