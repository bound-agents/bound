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
- `boundless_read_structure` returns a flat, body-free declaration outline with hashline-compatible `LINE:HASH|symbolName` rows. It has one `path` parameter. Supported extensions are TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.d.ts`, `.d.mts`, `.d.cts`), Python (`.py`, `.pyi`), Go (`.go`), Rust (`.rs`), Java (`.java`), Kotlin (`.kt`, `.kts`), C (`.c`, `.h`), C++ (`.cc`, `.cp`, `.cpp`, `.cxx`, `.c++`, `.hh`, `.hpp`, `.hxx`), C# (`.cs`, `.csx`), Ruby (`.rb`, `.rake`, `.gemspec`), PHP (`.php`, `.php3`, `.php4`, `.php5`, `.phtml`), Swift (`.swift`), Lua (`.lua`), shell (`.sh`, `.bash`, `.zsh`, `.ksh`), and SQL (`.sql`). TypeScript-family files use the TypeScript compiler parser; Python, Go, and Rust use their Tree-sitter grammars. The outline normalizes named top-level declarations: TypeScript/JavaScript functions, classes, variables, interfaces, type aliases, enums, namespaces/modules, and named exports; Python classes, functions, and simple identifier assignments; Go types, constants, variables, functions, and methods; and Rust structs, enums, unions, functions, traits, impls, types, modules, statics, and constants. Nested declarations are omitted. Extensions are dispatched explicitly and case-insensitively: extensionless and unregistered files (such as Svelte, configuration, document, markup, and stylesheet formats) return an empty result rather than being parsed as another language. Malformed supported source is rejected when its registered parser reports an error; parser failures return an error and never fall through to another parser. Source input is limited to 1,000,000 UTF-8 bytes before parsing; rendered output is capped at 50,000 UTF-8 bytes with no partial symbol row. Anchors hash normalized physical source lines and remain compatible with `boundless_edit`.
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

A running `yard` call appears as a magenta-striped turn below the transcript — the same
left-stripe wrapper as every other message, so long content wraps inside the stripe
instead of shattering a border. The card replaces the ordinary tool request and result
rows entirely: the request card is suppressed while the run is live and stays suppressed
after it commits, so one card carries the whole invocation. The card shows the
initial input and the live execution graph: tool, auxiliary-agent, and inference effects
hang off their parent with box-drawing branches, nested `yard()` runs indent as subtrees,
and concurrent effects read as siblings in dispatch order. Glyphs are color-coded by state
(green done, red failed, yellow running); tool, inference, and nested-run labels carry
their own colors, and finished effects show elapsed time graded by magnitude. A fan-out
that dispatches the same agent across many partitions packs into one dense row —
`aux:scout ×24` with a per-member glyph cluster — and failed members keep an indexed
detail line with the failure reason. While the run is live, the card shows the head of the
generator program (syntax-highlighted, elided past a few lines), previews are clamped to
one line, and the graph section is capped to the viewport (rows past the budget collapse
into “… +N more effects”), so the card never outgrows the terminal. The processing indicator
reflects the invocation as a whole — `Yard · 3/12 effects` with elapsed anchored at the
run's start rather than a per-segment “Thinking” counter that resets between loop turns —
and the status-bar session cost refreshes as lifecycle events arrive instead of freezing
until the run terminates. Client tools dispatched from inside the run (for example
`boundless_bash`) render only as graph nodes, and tools dispatched by auxiliary-agent
threads never stream under this chat — they belong to their own thread.

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
