---
title: Use the boundless terminal client
description: Connect a terminal workspace to Bound and use local file, shell, and MCP tools.
---

Use the `boundless` terminal client to connect your current working directory to a Bound
thread and make host-side file and shell tools available to that thread.

## Prerequisites

- A running Bound server
- The `boundless` binary on your `PATH`
- A working directory that the agent can read

## 1. Open the working directory

In a terminal, change to the directory you want the agent to work with. The client registers
tools against this real working directory.

## 2. Start a live session

Run the client:

```bash
boundless
```

By default, the client connects to `http://localhost:3001` and creates a thread for the
current working directory. The client session is the live connection; the thread is the
conversation that you can resume later.

## 3. Verify the live session

Check the status area for the connection state, thread ID, selected model, MCP server count,
and working directory. Send a message in the terminal UI and confirm that the thread
responds.

Copy the full thread ID if you want to resume this thread later.

## Work with local files and commands

The client registers these tools against the working directory:

- `boundless_read` reads files with stable line anchors.
- `boundless_read_structure` lists top-level declarations from supported source files without their bodies, with line anchors compatible with `boundless_edit`.
- `boundless_write` creates or replaces files atomically.
- `boundless_edit` applies anchored edits from a prior read.
- `boundless_search` searches files with regular expressions.
- `boundless_bash` executes a command in the sandbox.
- `boundless_copy` copies a file between the host and Bound's virtual filesystem.

Anchored reads let the agent address exact lines without reproducing their full text.

:::danger[Filesystem access]
Read access follows the operating-system permissions of the `boundless` process. Writes are
confined to the working directory and temporary directories allowed by the platform sandbox:
seatbelt on macOS, bubblewrap on Linux, and Bound's one-shot AppContainer lowbox on Windows.
The Windows backend also keeps `.git/config` and `.git/hooks` read-only while ordinary Git
state remains writable. It creates an unprivileged per-command profile; if host policy blocks
profile creation, the default `sandbox.onUnavailable: "error"` refuses the command with
guidance. Set `"passthrough"` only to opt explicitly into a visibly unsandboxed fallback.
Start `boundless` in a directory whose contents are appropriate for the thread to access.
:::

For details about host-tool trust boundaries and shell write confinement, read
[Security boundaries](/bound/concepts/security-boundaries/) and
[Sandbox and filesystems](/bound/concepts/sandbox/).

## Connect to another server

Override the configured server URL for the current run:

```bash
boundless --url http://my-server:3001
```

The override isn't persisted. The default URL is `http://localhost:3001`.

## Resume an existing thread

Pass the full thread ID shown in the status area:

```bash
boundless --attach <thread-id>
```

Replace `<thread-id>` with the thread you want to resume. This starts a new live client
session attached to that thread.

## Configuration files

Client configuration lives in `~/.bound/less/`:

| File | Purpose |
| --- | --- |
| `config.js` / `config.json` | Server URL, default model, injected context files, and shell override. The optional JS base is overlaid by writable JSON preferences. |
| `mcp.js` / `mcp.json` | Local MCP servers, separate from the server's `mcp.json`. The optional JS base is overlaid by writable JSON preferences. |

## Read status and tool output

Large shell results may be shortened or offloaded before they reach the transcript.
Consecutive reads and searches share one compact result group. Failed calls retain their
diagnostic output.

An additional status row appears when measurements are available:

| Segment | Meaning |
| --- | --- |
| `ctx 44% (87k/200k)` | Provider-reported context-window use after the last turn |
| `$1.05 session / $12.34 today` | Cluster-wide live-session and daily spend |
| `● 3 background` | Background tool calls in flight on this thread |

Segments remain hidden until they have a value. See
[Foreground and background work](/bound/concepts/auxiliary-agents/#foreground-and-background-work)
for background work.

## Follow Yard execution

A running `yard` call appears as a magenta-striped card below the transcript. It replaces the ordinary tool request and result rows for the whole invocation.

The card shows the input and a live execution graph. The graph follows generator execution order from left to right: each yielded effect leads to the next. `all([...])` and `sequence([...])` render as labeled containers; `all` keeps its children parallel while `sequence` links its children in order. Nested `yard()` runs remain subtrees. State colors show whether an effect is running, done, or failed. A wide fan-out collapses into one row, with failed members retaining an indexed failure detail.

While the run is live, the card includes a short syntax-highlighted program preview. Previews and graph height are bounded to the viewport. The processing indicator tracks the full invocation, including effect progress and elapsed time, and session cost refreshes as lifecycle events arrive.

Client tools dispatched inside the run, such as `boundless_bash`, appear only as graph nodes. Tools dispatched by auxiliary-agent threads belong to their own thread and do not stream under this chat.

When the root run finishes, the card moves into terminal scrollback at the matching Yard
result row with the generator program (syntax-highlighted) and the full input and result
payloads — pretty-printed JSON when they parse, raw wrapped text when a long preview was
middle-elided upstream. Live execution events are thread-scoped and ephemeral; transcripts
created by older servers, or sessions that attach after a run finishes, retain the
ordinary Yard tool-call/result rendering.

## Connect an ACP editor

To use `boundless` from an Agent Client Protocol (ACP) editor instead of the terminal UI,
follow [Connect an ACP editor](/bound/guides/acp-editor/).

## Troubleshoot the client

### The client doesn't connect

Confirm that the Bound server is running. If it isn't at `http://localhost:3001`, pass its
web-server URL with `--url` or set the server URL in `~/.bound/less/config.json`.

### An attached thread isn't the expected thread

Copy the full thread ID from the status area and pass that value to `--attach`.

### Tool output appears shortened

Shell output longer than 32 visual rows is elided in the middle. Output over 256 KiB is
offloaded before it reaches the transcript.

### Windows lowbox is unavailable

Windows commands do not fall back to mxc or a persisted sandbox session. Bound creates a
one-shot AppContainer profile and lowbox token for each command, then a watcher owns process-
tree cancellation and profile/ACL/journal cleanup. A policy that prevents an unprivileged
user from calling `CreateAppContainerProfile` makes this backend unavailable. Restore
unprivileged profile creation, or set `sandbox.onUnavailable` to `"passthrough"` only if you
intend to run commands without write confinement; the tool reports `ran UNSANDBOXED`.

The Windows CI confinement matrix validates writes inside allowed roots; denial of sibling,
traversal, and junction escapes; read-only `.git/config` and `.git/hooks` including nested
existing hooks; descendant-tree cancellation; and watcher-owned cleanup.

## Related concepts

- [System model](/bound/concepts/system-model/)
- [Work lifecycle](/bound/concepts/work-lifecycle/)
- [Security boundaries](/bound/concepts/security-boundaries/)
- [Sandbox and filesystems](/bound/concepts/sandbox/)

For concise option lookup, see the
[`boundless` command reference](/bound/guides/cli-operations/#boundless).
