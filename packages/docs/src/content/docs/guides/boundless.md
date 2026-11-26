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

In a terminal, change to the directory the agent should work with. The client registers
tools against this real working directory.

## 2. Start a live session

Run the client:

```bash
boundless
```

By default, the client connects to `http://localhost:3001` and creates a thread for the
current working directory. The client session is the live connection; the thread is the
conversation that can be resumed later.

## 3. Verify the live session

Check the status area for the connection state, thread ID, selected model, MCP server count,
and working directory. Send a message in the terminal UI and confirm that the thread
responds.

Copy the full thread ID to resume this thread later.

Type `/help` for the command list. An unknown command suggests the closest match. `/model <name>` accepts a model ID or display name, case-insensitively; an unknown name shows an error and leaves the current model in place. If the connection drops, the input box stays editable and keeps your draft. Enter refuses to send until the connection returns.

Press Esc or Ctrl-C once to close a picker. While a turn is running, Ctrl-C cancels it. Pressing Ctrl-C twice within two seconds exits.

## Work with local files and commands

While connected, `boundless` exposes file, search, and shell tools scoped to your working
directory. See [Agent tools](/bound/reference/agent-tools/#boundless-client-tools) for the tool
list.

:::danger[Filesystem access]
Read access follows the operating-system permissions of the `boundless` process. Writes and shell
commands are confined to the working directory and temporary directories by the platform sandbox
(seatbelt on macOS, bubblewrap on Linux, and an AppContainer lowbox on Windows). `.git/config`
and `.git/hooks` stay read-only, and direct writes to Bound's system database are blocked. Start
`boundless` in a directory whose contents are appropriate for the thread to access.
:::

For details about host-tool trust boundaries and shell write confinement, read
[Security boundaries](/bound/concepts/security-boundaries/) and
[Sandbox and filesystems](/bound/concepts/sandbox/).

## Override the sandbox for one thread

The sandbox default comes from the `sandbox` key in `~/.bound/less/config.json`. Use the `/sandbox` command to change it for the current thread when a task needs looser confinement — for example, working on the sandbox code itself.

- `/sandbox` — report the thread's effective mode and writable paths.
- `/sandbox off` — run this thread's commands unsandboxed. This removes write confinement entirely, including the read-only protection on `.git/config` and `.git/hooks`.
- `/sandbox allow <path>` — keep the sandbox on and grant one more writable path for this thread. Repeat to add several. The path must exist; a missing path is rejected.
- `/sandbox on` — clear the override and return to the configured default.

The override applies only to the current thread and only in memory: `/attach` to another thread uses that thread's override (none by default), `/clear` starts a new thread with none, and restarting `boundless` resets every override. A status-line indicator marks a thread whose sandbox is off or loosened for as long as the override lasts. Each change also prints a short confirmation that clears on your next message, on a thread switch, or after a few seconds.

The override is reachable only from `/sandbox` typed in the client. The agent cannot change its own confinement.

On a host where the sandbox cannot run, `/sandbox` reports the passthrough state and `/sandbox allow` explains that an extra writable path has no effect until the sandbox can confine commands.

## Add attachments

Attach several files to one message before sending it. Paste an image into the composer to stage it as an attachment. On macOS, `boundless` reads images through `pngpaste` or `osascript`; on Linux it uses `wl-paste` or `xclip`; on Windows it uses PowerShell. Install a reader appropriate to your platform when pasting an image.

Press Escape while the input is empty to clear every staged attachment.

## Watch auxiliary work

Foreground and background auxiliary invocations show a live running card while this terminal
client is connected. Clients connecting after an invocation starts see the completed result once
it lands.

User-role messages carry their sender in the header: the display name stamped when the message
was sent, else the thread owner's display name, else `you`. When you attach to an auxiliary
child thread, the main agent's dispatched instructions read `agent` rather than an operator
name.

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

Replace `<thread-id>` with the target thread. This starts a new live client
session attached to that thread.

## Configuration files

Client configuration lives in `~/.bound/less/`:

| File | Purpose |
| --- | --- |
| `config.js` / `config.json` | Server URL, default model, injected context files, and shell override. The optional JS base is overlaid by writable JSON preferences. |
| `mcp.js` / `mcp.json` | Local MCP servers, separate from the server's `mcp.json`. The optional JS base is overlaid by writable JSON preferences. |

### Context files

On session start, `boundless` loads project instruction files from the working directory into the
thread's system prompt. The default set is `README.md`, `CONTRIBUTING.md`, `AGENTS.md`,
`AGENTS.local.md`, `CLAUDE.md`, and `CLAUDE.local.md`; override it with `contextFiles` in
`config.json`.

`AGENTS.local.md` and `CLAUDE.local.md` are developer-local companions loaded alongside their
repository-scoped base file. When `AGENTS.md` is present, `CLAUDE.md` is skipped (and
`AGENTS.local.md` similarly takes precedence over `CLAUDE.local.md`). Context files are loaded
once at session start.

## Read status and tool output

The status row shows context-window usage (`ctx`), thread and daily spend, and active background
tool count when those values are available. Large shell output is shortened or offloaded before
reaching the transcript, while failed calls retain their diagnostic output.

## Follow Yard execution

A running `yard` call renders as an inline card with a live execution graph showing sequential
steps, parallel groups, and each step's running, done, or failed status. When the run finishes,
the card moves into terminal scrollback alongside its program, input, and result.

## Connect an ACP editor

To use `boundless` from an Agent Client Protocol (ACP) editor instead of the terminal UI,
follow [Connect an ACP editor](/bound/guides/acp-editor/).

## Troubleshoot the client

### The client doesn't connect

Confirm that the Bound server is running. If it isn't at `http://localhost:3001`, pass its
web-server URL with `--url` or set the server URL in `~/.bound/less/config.json`.

### An attached thread isn't the expected thread

Copy the full thread ID from the status area and pass that value to `--attach`.

### Git fails inside the Windows sandbox with `could not open '/dev/null'`

Windows' null device refuses AppContainer processes by default, and Git opens `NUL` at startup.
The lowbox helper adds a read/write grant for ALL APPLICATION PACKAGES to the null device, which
needs an elevated `boundless` (the device is owned by Administrators). The grant lasts until
reboot, so one elevated `boundless` command per boot is enough; unelevated sessions see Git exit
128 until then.

### Windows sandbox is unavailable

On Windows, `boundless` requires unprivileged AppContainer profile creation. If host policy
blocks it, the default `sandbox.onUnavailable: "error"` refuses shell commands. Restore
unprivileged profile creation, or set `sandbox.onUnavailable` to `"passthrough"` in
`~/.bound/less/config.json` to run commands unsandboxed (the tool reports `ran UNSANDBOXED`).

## Related concepts

- [System model](/bound/concepts/system-model/)
- [Work lifecycle](/bound/concepts/work-lifecycle/)
- [Security boundaries](/bound/concepts/security-boundaries/)
- [Sandbox and filesystems](/bound/concepts/sandbox/)

For concise option lookup, see the
[`boundless` command reference](/bound/guides/cli-operations/#boundless).
