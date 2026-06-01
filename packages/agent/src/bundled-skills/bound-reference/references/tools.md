# Tools Reference

This is the catalog of tools you can call. A hallucinated tool call fails hard —
if you are unsure a tool exists or what it takes, confirm here rather than
guessing a name or shape.

There are three families:

1. **Native agent tools** — built into bound, with structured JSON-schema
   parameters. The LLM receives typed parameters directly; there is no string
   parsing. These are always available.
2. **Built-in file/sandbox tools** — `read`, `write`, `edit`, `bash`. File tools
   operate on the virtual filesystem; `bash` runs in the sandbox. (On a
   `boundless` terminal session these are additionally surfaced as
   `boundless_read` / `boundless_write` / `boundless_edit` / `boundless_bash`,
   scoped to the user's local working directory.)
3. **MCP-dispatched commands** — one command per connected MCP server, dispatched
   via a `subcommand` parameter. These are dynamic: which ones exist depends on
   the operator's `mcp.json` and connected platform connectors. They are listed
   in your orientation under "Additional MCP Commands", not here, because the set
   changes per host.

Native tools self-describe through their JSON schemas in every turn. This file
adds the conceptual layer the schema can't carry: what each tool is *for* and
*when to reach for it*.

## Native agent tools

These twelve are registered in `createAgentTools()`
(`packages/agent/src/tools/index.ts`). The set is the source of truth; this
catalog is kept in sync with it by a test.

### `task`
Manage scheduled tasks via an `action` parameter.

- **`action=schedule`** — create a deferred, cron, or event-driven task. Each task
runs in its own thread with its own context window, so it does not consume the
current conversation's budget. Use `delay` for one-shot deferred work, `cron` for
recurring work, `on_event` for event-driven work. Use `after` / `require_success`
to chain dependencies and `inject_mode` to feed a dependency's results forward.
**Always populate `payload`** with the full instructions — the `task_description`
field is display-only metadata and is not delivered to the waking thread.
- **`action=update`** — mutate an existing task by `task_id` without recreating it.
Updatable config fields: `no_history` (false re-enables history), `model_hint`
(empty string clears back to the system default), `alert_threshold`. Omitted fields
are left unchanged. Lifecycle/scheduling fields are not updatable here — use
`cancel` to stop a task. A task cannot update *itself*: when the running task's id
matches `task_id` the call is refused, so a task loop can't silently rewrite its own
config (e.g. clearing its own `model_hint` mid-run). To change the running task's
model, use the `model_hint` tool.

### `cancel`
Cancel a scheduled task. Targets either a specific `task_id` or every task whose
payload matches a `payload_match` substring. The heartbeat task is uncancellable
by design.

### `query`
Execute a **read-only** `SELECT` or an allowlisted read-only `PRAGMA` against the
database. This is the primary way to verify claims against ground truth — prefer
it over trusting a summary. `LIMIT 1000` is auto-appended to SELECTs. Writes,
`ATTACH`, and the `PRAGMA x = y` assignment form are rejected.

### `purge`
Create a purge record targeting message IDs (or the last N messages of a thread).
Use to remove resolved/noisy turns from a thread's working set.

### `advisory`
Post a proactive advisory for operator review, or manage existing ones
(`list`, `approve`, `apply`, `defer`, `dismiss`). Advisories are for live
operational issues that warrant the operator's attention — not for routine
logging.

### `notify`
Send a proactive notification to another thread, enqueuing a message and
triggering inference there. All threads are the same agent, so compose with "we"
and "our". Use to hand work or context to a sibling thread.

### `introspect`
Consult another thread synchronously and get its response back. Use for deeper
reflection or insight from a different context. Blocks until the target replies
or the timeout elapses.

### `archive`
Archive a thread to long-term storage, by `thread_id` or by an `older_than`
age cutoff.

### `model_hint`
Set or clear the model hint for the current task — switch to a different model
tier or ID, or `reset` to clear the hint.

### `hostinfo`
Display registered host information and cluster topology: which hosts are online,
their roles (hub/spoke), models, and MCP servers. Use to reason about where
inference and tools live before delegating or diagnosing.

### `memory`
Semantic memory operations: `store`, `forget`, `search`, `connect`, `disconnect`,
`traverse`, `neighbors`. Pass `tier: "pinned"` on `store` to make an entry durable
across context compaction. Edges use the canonical relation set; put bespoke
phrasing in the `context` field, not the relation. This is your durable
cross-session memory — see `references/memory.md`.

### `skill`
Manage skills: `activate`, `list`, `read`, `retire`. Skills are reusable
instruction sets; activating one makes its index entry appear in every turn and
lets a task inject its body. See the `skill-authoring` skill for how to write one.

## Built-in file and sandbox tools

- **`read`** — read a file from the virtual filesystem (head-truncated; use
  `offset` / `limit` to page).
- **`write`** — write or overwrite a file (creates parent directories).
- **`edit`** — apply one or more exact search-and-replace edits to a file; all
  edits are validated before any are written.
- **`bash`** — run a command in the sandbox. MCP tools are also reachable as
  commands here.

On a `boundless` session the same operations are exposed as `boundless_*` tools
that act on the user's real local working directory instead of the VFS.

## MCP-dispatched commands

Each connected MCP server (and platform connector) becomes one command with a
`subcommand` parameter that selects the underlying tool. The available servers
and their subcommands are host-specific and listed in your orientation, not here.
Run a server command with `--help` to see its subcommands. The platform
`connector` tool (`action: list | channels | attach | detach`) manages event
subscriptions.
