# Agent System

This document describes the `@bound/agent` package — the runtime core of Bound. It covers the agent loop state machine, context assembly pipeline, built-in commands, scheduler, MCP bridge, and the supporting subsystems that round out the package.

---

## Table of Contents

1. [Agent Loop State Machine](#agent-loop-state-machine)
2. [Context Assembly Pipeline](#context-assembly-pipeline)
3. [Built-in Commands](#built-in-commands)
4. [Scheduler](#scheduler)
5. [MCP Bridge](#mcp-bridge)
6. [Advanced Features](#advanced-features)
   - [Advisories](#advisories)
   - [Message Redaction](#message-redaction)
   - [Thread Title Generation](#thread-title-generation)
   - [Summary Extraction](#summary-extraction)
   - [File-Thread Tracking](#file-thread-tracking)

---

## Agent Loop State Machine

### States

The `AgentLoopState` union enumerates every phase the loop can occupy:

```typescript
type AgentLoopState =
  | "IDLE"
  | "HYDRATE_FS"
  | "ASSEMBLE_CONTEXT"
  | "LLM_CALL"
  | "PARSE_RESPONSE"
  | "TOOL_EXECUTE"
  | "RELAY_WAIT"
  | "RELAY_STREAM"
  | "TOOL_PERSIST"
  | "RESPONSE_PERSIST"
  | "FS_PERSIST"
  | "QUEUE_CHECK"
  | "ERROR_PERSIST"
  | "AWAIT_POLL";
```

| State | Description |
|---|---|
| `IDLE` | Initial state before run begins; also the terminal state after a successful run. |
| `HYDRATE_FS` | Loads workspace files into the sandbox before the LLM call. |
| `ASSEMBLE_CONTEXT` | Runs the 8-stage context assembly pipeline (see below). Model resolution also happens here. |
| `LLM_CALL` | Streams tokens from the LLM backend (local) or enters `RELAY_STREAM` (remote). |
| `PARSE_RESPONSE` | Iterates accumulated chunks to extract text content and detect tool-use starts. |
| `TOOL_EXECUTE` | Dispatches tool calls via the sandbox. Remote MCP tools enter `RELAY_WAIT`. |
| `RELAY_WAIT` | Polls `relay_inbox` for a tool result from a remote host (event-driven with 500ms fallback polls, 30s timeout per host, automatic failover). |
| `RELAY_STREAM` | Polls `relay_inbox` for streaming inference chunks from a remote host. Reorders by `seq`, handles gaps, fails over after `inference_timeout_ms` (default 300s) per host. |
| `TOOL_PERSIST` | Writes tool call and tool result messages to the database. |
| `RESPONSE_PERSIST` | Persists the assembled assistant message to `messages`. |
| `FS_PERSIST` | Flushes workspace file mutations back to the database. |
| `QUEUE_CHECK` | Checks for newly queued messages before returning. |
| `ERROR_PERSIST` | Persists an `alert` role message when an unrecoverable error occurs mid-run. |
| `AWAIT_POLL` | Used in polling contexts while waiting for an external condition. |

### Configuration and Result Types

```typescript
interface AgentLoopConfig {
  threadId: string;
  taskId?: string;   // task IDs not prefixed "interactive-" block confirmed MCP tools (autonomous mode)
  userId: string;
  modelId?: string;  // resolved cluster-wide via resolveModel(); routes to RELAY_STREAM if remote
  modelTier?: number;
  abortSignal?: AbortSignal;
  // ... additional optional fields: onActivity, tools, platform, platformTools, shouldYield
}

interface AgentLoopResult {
  messagesCreated: number;
  toolCallsMade: number;
  filesChanged: number;
  error?: string;
}
```

### `run()` Lifecycle

`AgentLoop.run()` is the single entry point. It sequences through states in order and returns an `AgentLoopResult`. The internal counters `messagesCreated`, `toolCallsMade`, and `filesChanged` accumulate across the run and are always included in the return value, even on error.

```
IDLE
  -> HYDRATE_FS       (workspace hydration)
  -> ASSEMBLE_CONTEXT (8-stage pipeline + model resolution)
  -> LLM_CALL         (local: streams from LLMBackend)
     |                (remote: enters RELAY_STREAM, polls relay_inbox for chunks)
     [on error] -> ERROR_PERSIST -> return with error field
  -> PARSE_RESPONSE
  -> TOOL_EXECUTE     (local tools: sandbox dispatch)
     |                (remote MCP tools: enters RELAY_WAIT, polls relay_inbox for result)
  -> RESPONSE_PERSIST (writes assistant message row)
  -> FS_PERSIST       (workspace flush)
  -> QUEUE_CHECK
  -> IDLE             (return result)
```

During `LLM_CALL`, model resolution determines the execution path:
- **Local model** — `StreamChunk`s collected directly from the local `LLMBackend.chat()` call.
- **Remote model** — loop enters `RELAY_STREAM`: writes an `inference` outbox entry with a UUID `stream_id`, then waits for `relay:inbox` events (with 500ms fallback polling) for `stream_chunk` and `stream_end` inbox entries. Chunks are reordered by `seq`. Gaps are skipped after 6 polling cycles (~3s) with a warning. Per-host timeout is `inference_timeout_ms` (default 300s); the loop fails over to the next eligible host on timeout.

If `this.aborted` is set during streaming, `RELAY_STREAM` writes a `cancel` outbox entry (with `ref_id` pointing to the original `inference` entry) and exits cleanly.

If the LLM backend throws, the loop transitions to `ERROR_PERSIST`, writes an `alert`-role message to `messages` with the error text, and returns immediately with the error populated in the result.

Any other unhandled error caught by the outer `try/catch` also transitions to `ERROR_PERSIST` and returns with the error field set.

### Cancel Support

```typescript
const ac = new AbortController();
const loop = new AgentLoop(ctx, sandbox, modelRouter, {
  threadId: "t-123",
  userId:   "u-456",
  abortSignal: ac.signal,
});

// Cancel from outside — safe to call at any time
ac.abort();

// Alternatively, call directly on the instance
loop.cancel();
```

`cancel()` sets the internal `aborted` flag. The streaming loop checks this flag on every chunk. The `AbortSignal` listener wires `abort` events to the same flag, so either approach has the same effect. Cancellation is cooperative — the loop finishes its current in-progress step before stopping.

### Error Handling

| Error source | Transition | Outcome |
|---|---|---|
| LLM backend throws | `ERROR_PERSIST` | `alert` message row inserted; result returned with `error` field |
| Any other unhandled throw | `ERROR_PERSIST` | No alert row; result returned with `error` field |

The `alert` role is a reserved message role visible in the thread but excluded from LLM context during subsequent calls.

---

## Context Assembly Pipeline

`assembleContext(params: ContextParams): ContextAssemblyResult` is a synchronous function that builds the full message array to be sent to the LLM, returning `{ messages, debug, systemSuffix? }`. It runs in 8 stages described in spec §13.1.

```typescript
interface ContextParams {
  db:              Database;
  threadId:        string;
  taskId?:         string;
  userId:          string;
  currentModel?:   string;
  contextWindow?:  number;                    // token budget (default: 8000)
  noHistory?:      boolean;                   // skip message retrieval (default: false)
  configDir?:      string;                    // persona search root (default: "config")
  hostName?:       string;
  siteId?:         string;
  relayInfo?: {                               // injected for delegated loops
    remoteHost: string;
    localHost:  string;
    model:      string;
    provider:   string;
  };
  platformContext?: {                         // suppresses auto-deliver for platform relay loops
    platform:   string;
    toolNames?: string[];                     // tools the agent should call to send messages
  };
  targetCapabilities?: BackendCapabilities;   // enables in-place content block substitution
}
```

### Stage 1 — MESSAGE_RETRIEVAL

Fetches all messages for `threadId` from the `messages` table ordered by `created_at ASC`. If `noHistory` is `true`, this stage is skipped and the message list starts empty.

### Stage 2 — PURGE_SUBSTITUTION

Scans the retrieved messages for rows whose `role` is `"purge"`. Each purge message's `content` is parsed as:

```json
{ "target_ids": ["msg-id-1", "msg-id-2"], "summary": "..." }
```

All IDs found in `target_ids` are collected into a `replacedIds` set. In stage 5, any message whose `id` is in this set is dropped from the assembled output. The purge message itself is also naturally excluded because its role is filtered during annotation.

The `purge` command (see [Built-in Commands](#built-in-commands)) is the mechanism for creating these purge rows.

### Stage 3 — TOOL_PAIR_SANITIZATION

Ensures that every `tool_call` message has a corresponding `tool_result` and vice versa. The sanitizer walks messages sequentially using a state machine:

- A `tool_call` sets `inActiveTool = true`.
- The next `tool_result` closes the pair and resets the flag.
- If a `tool_result` arrives with `inActiveTool = false` (orphaned result), a synthetic `tool_call` is injected immediately before it.
- If a non-tool message arrives while `inActiveTool` is true, a synthetic `tool_result` with the text `"Tool execution was interrupted"` is injected to close the open pair.
- If the message list ends with an open pair, a synthetic `tool_result` with `"Tool execution completed"` is appended.

This ensures the LLM always receives valid, properly interleaved tool-use sequences regardless of how the database was written.

### Stage 4 — MESSAGE_QUEUEING

Messages that were persisted during an active tool-use window (and therefore would create structural violations) are excluded. In practice this is handled by the sanitizer in stage 3; stage 4 is a logical marker for the pipeline rather than a separate code step.

### Stage 5 — ANNOTATION

Each sanitized `Message` is mapped to an `LLMMessage`, dropping messages whose `id` is in `replacedIds` (from stage 2). The mapping copies `role`, `content`, `model_id`, and `host_origin` into the LLM message shape.

**Stage 5b — CONTENT_SUBSTITUTION:** When `targetCapabilities` is set on `ContextParams`, a post-annotation pass substitutes content blocks that the target backend does not support. Image blocks (`type: "image"`) in messages are replaced with `[Image: description]` text annotations when the backend lacks `vision` support. Document blocks (`type: "document"`) are always replaced with their `text_representation`. `file_ref` image sources are resolved to inline base64 from the `files` table when vision is available. The substitution modifies only the assembled `LLMMessage[]` — persisted `messages.content` rows are never altered.

### Stage 6 — ASSEMBLY

The final message array is composed in this order:

1. **Base system prompt** — a hardcoded instruction establishing the assistant identity and tool-use posture.
2. **Persona** (optional) — the contents of `{configDir}/persona.md` injected as a second `system` message. The persona file is loaded once and cached in a module-level variable per `configDir` path. If the file does not exist, this message is omitted.
3. **Orientation** — a stable `system` message listing available commands, current model, and host identity.
4. **Skill body** (optional) — if the task's `payload` JSON contains `"skill": "<name>"` and that skill is active in the `skills` table, its SKILL.md content is injected as an additional `system` message. This injection happens outside the `noHistory` guard so it applies even when history is suppressed. If the referenced skill is not active, a note is deferred to the volatile context instead.
5. **Message history** — all annotated messages from stage 5b.
6. **Volatile context** — a trailing `system` message appended when `noHistory` is false. Contains:
   - `User ID` and `Thread ID`
   - Relay info: when `relayInfo` is set, injects a line identifying the remote model, provider, and host (plus the originating local host).
   - Platform silence semantics: when `platformContext` is set, explains that the platform user sees nothing unless the agent explicitly calls a platform send tool (e.g., `discord_send_message`). The specific tool name(s) are listed if `toolNames` is provided.
   - Semantic memory entries (up to 10, most-recently-modified first).
   - Cross-thread digest.
   - Cross-thread file modification notifications.
   - Active skill index: `SKILLS (N active):` followed by name and description for each active skill, ordered by `last_activated_at DESC`.
   - Operator retirement notifications: skills retired by `"operator"` within the last 24 hours are listed with their reason.
   - Inactive skill reference note: if the task payload referenced a skill that is not currently active, a warning is appended here.

```
[ system: base prompt ]
[ system: persona ]        <- only if config/persona.md exists
[ system: orientation ]    <- available commands, model, host identity
[ system: skill body ]     <- only if task payload contains an active skill ref
[ ... history messages ]
[ system: volatile ctx ]   <- only when noHistory is false
```

### Stage 7 — BUDGET_VALIDATION

Counts tokens using `countContentTokens()` (tiktoken `cl100k_base`) across all assembled messages. The context window is resolved from the backend's advertised `max_context` (defaults to 200,000 when unavailable; the `contextWindow` parameter defaults to 8,000 but is typically overridden by the agent loop). If the estimated total exceeds the window:

1. System messages are separated from history messages.
2. History is truncated via a token-aware backward fill targeting 85% of the window (cache-friendly headroom), always keeping at least 2 messages and advancing the slice so the kept history begins with a `user` message.
3. A `system` truncation marker is injected (noting how many messages were dropped and including the thread summary when available) and the result `[...systemMessages, truncationMarker, ...remaining]` is returned.

Budget pressure also triggers tier-aware reductions to the volatile enrichment (memory/digest sections) before truncation.

### Stage 8 — METRIC_RECORDING

Reserved for token usage recording when the metrics subsystem is available. Currently a no-op placeholder.

### Persona Injection

Place a Markdown file at `config/persona.md` (relative to the working directory, or at the path passed via `configDir`) to inject a custom persona into every LLM call. The file is read once on first use per `configDir` value and cached for subsequent calls.

```
config/
  persona.md   <- injected as a system message after the base prompt
```

---

## Native Agent Tools

Agent tools are implemented as `RegisteredTool` factories in `packages/agent/src/tools/`. Each factory closes over a `ToolContext` (db, siteId, eventBus, logger, threadId, taskId, modelRouter, fs) and returns a `RegisteredTool` with a JSON schema `ToolDefinition` and an `execute` handler.

The 14 native tools replace the previous 20 bash-dispatched commands:

| Tool | Actions / Params | Kind |
|------|-----------------|------|
| `memory` | action: store, forget, search, connect, disconnect, traverse, neighbors | Grouped |
| `cache` | action: warm, pin, unpin, evict | Grouped |
| `skill` | action: activate, list, read, retire | Grouped |
| `schedule` | task_description, cron, delay, on_event, model_hint, ... | Standalone |
| `cancel` | task_id, payload_match | Standalone |
| `query` | sql | Standalone |
| `emit` | event, payload | Standalone |
| `await_event` | task_ids, timeout | Standalone |
| `purge` | message_ids, last_n, thread_id | Standalone |
| `advisory` | title, detail, action, impact, list, approve, apply, dismiss, defer | Standalone |
| `notify` | user, all, platform, message | Standalone |
| `archive` | thread_id, older_than | Standalone |
| `model_hint` | model, reset | Standalone |
| `hostinfo` | (no params) | Standalone |

Tools dispatch through the unified tool registry (`Map<string, RegisteredTool>`) in the agent loop's `executeToolCall()` method. The registry replaces the previous waterfall dispatch pattern.

---

### `query`

Execute a read-only SQL query against the agent database.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `sql` | yes | string | A SQL `SELECT` statement or read-only `PRAGMA` |

Only `SELECT` statements and read-only `PRAGMA` introspection queries are permitted. Results are printed as tab-separated values with a header row.

Example invocation:
```json
{
  "sql": "SELECT id, status FROM tasks WHERE status = 'pending'"
}
```

---

### `memory`

Native memory tool dispatched by action parameter: `store`, `forget`, `search`, `connect`, `disconnect`, `traverse`, `neighbors`.

| Action | Parameters | Description |
|---|---|---|
| `store` | key, value, tier | Upsert a key/value pair in `semantic_memory`. Keys with prefixes `_standing`, `_feedback`, `_policy`, or `_pinned` are auto-pinned; otherwise `tier` (`pinned`, `summary`, `default`, `detail`) is honored. Row ID is a deterministic UUID derived from the key using `BOUND_NAMESPACE`. |
| `forget` | key_match, prefix | Soft-delete an entry by `key_match` or batch-delete by `prefix`. Cascades to memory edges; retiring a `summary` promotes its `detail` children back to `default`. |
| `search` | query | Keyword search over memory keys and values (stop-word filtered, limit 20, ordered by `modified_at DESC`). |
| `connect` / `disconnect` | source, target, relation, weight | Upsert or remove `memory_edges` rows. `summarizes` edges drive tier transitions. |
| `traverse` / `neighbors` | node_id, direction | Graph queries over the memory edge graph. |

---

### `schedule`

Create a new task in the `tasks` table. Exactly one of `delay`, `cron`, or `on_event` must be provided.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `task_description` | yes | string | What the task should do |
| `delay` | one-of | string | Deferred time offset: `5m`, `2h`, `1d` |
| `cron` | one-of | string | Cron expression (5-field) for recurring tasks |
| `on_event` | one-of | string | Event name for event-driven trigger |
| `payload` | no | string | Task payload as JSON string |
| `model_hint` | no | string | Model ID or tier to suggest to scheduler |
| `thread_id` | no | string | Thread ID for task context |
| `no_history` | no | boolean | Skip loading conversation history |
| `after` | no | string | Task ID this task depends on |
| `require_success` | no | boolean | Require dependency to succeed |
| `inject_mode` | no | string | How to inject dependency results: `results`, `all`, or `file` |
| `alert_threshold` | no | integer | Consecutive failures before advisory (default 3) |

Returns the new task UUID.

Example invocations:
```json
{
  "task_description": "Run nightly cleanup",
  "delay": "30m",
  "payload": "{\"action\":\"sweep\"}"
}
```

```json
{
  "task_description": "Hourly digest",
  "cron": "0 * * * *",
  "model_hint": "opus"
}
```

```json
{
  "task_description": "Process on deploy",
  "on_event": "deploy:finished",
  "after": "task-uuid-abc",
  "require_success": true
}
```

---

### `cancel`

Cancel a pending or running task.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `task_id` | no | string | UUID of the task to cancel |
| `payload_match` | no | string | Cancel all pending/claimed tasks whose payload contains this string |

One of `task_id` or `payload_match` must be provided. When `task_id` is supplied, that specific task is cancelled. When `payload_match` is supplied, all tasks in `pending` or `claimed` status whose `payload` field contains the match string are cancelled.

Example invocations:
```json
{"task_id": "550e8400-e29b-41d4-a716-446655440000"}
```

```json
{"payload_match": "cleanup:urgent"}
```

---

### `emit`

Publish an event on the application event bus.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `event` | yes | string | Event name to emit |
| `payload` | no | string | Event payload as JSON string (default: `{}`) |

The payload is parsed and passed to `ctx.eventBus.emit`. Event-driven tasks whose `trigger_spec` matches the event name will be claimed by the scheduler on the next tick. If a hub is configured, the event is broadcast to all spokes via relay.

Example invocation:
```json
{
  "event": "data:ready",
  "payload": "{\"sourceId\":\"ds-42\"}"
}
```

---

### `purge`

Insert a `purge`-role message that causes the context assembly pipeline to drop the targeted messages from subsequent LLM calls. One of `message_ids` or (`last_n` with optional `thread_id`) must be provided.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `message_ids` | one-of | string | Comma-separated message IDs to purge |
| `last_n` | one-of | integer | Purge the last N messages from the thread |
| `thread_id` | with `last_n` | string | Thread ID (defaults to current thread) |
| `summary` | no | string | Optional summary text for the purge record |

The purge message content is stored as:

```json
{ "target_ids": ["..."], "summary": "..." }
```

Stage 2 of context assembly reads this structure and excludes the listed IDs from the LLM context. The original message rows are not modified or deleted.

Example invocations:
```json
{
  "last_n": 10,
  "thread_id": "t-abc123",
  "summary": "Purged outdated context"
}
```

```json
{
  "message_ids": "msg-1,msg-2,msg-3",
  "summary": "Removed duplicate messages"
}
```

---

### `await_event`

Poll until a set of tasks reach a terminal state (`completed`, `failed`, or `cancelled`).

| Parameter | Required | Type | Description |
|---|---|---|---|
| `task_ids` | yes | string | Comma-separated task UUIDs |
| `timeout` | no | integer | Timeout in milliseconds (default: 300000) |

Polls every 2 seconds until all tasks reach a terminal state. Returns a JSON object keyed by task ID, each containing `status`, `result`, and `error`. If the aggregated JSON exceeds 50 KB, the output is truncated to 50 KB.

Example invocation:
```json
{
  "task_ids": "task-1,task-2,task-3",
  "timeout": 600000
}
```

---

### `cache`

Consolidated cache operations: warm, pin, unpin, or evict.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `action` | yes | string | Cache operation: `warm`, `pin`, `unpin`, or `evict` |
| `path` | with `pin`/`unpin` | string | File path to pin or unpin |
| `pattern` | with `warm`/`evict` | string | Glob pattern for paths to warm or evict |

**Actions:**

- `warm`: Pre-populate the file cache for paths matching the glob pattern (requires MCP proxy connectivity).
- `pin`: Mark a file as pinned so it is not evicted by cache pressure. Looks up the file by path in the `files` table.
- `unpin`: Remove the pinned mark from a file, making it eligible for eviction.
- `evict`: Immediately soft-delete files from the cache that match a glob pattern. Glob patterns use `*` → `%` and `?` → `_` for SQL `LIKE` translation.

Example invocations:
```json
{
  "action": "warm",
  "pattern": "src/**/*.ts"
}
```

```json
{
  "action": "pin",
  "path": "src/critical-module.ts"
}
```

```json
{
  "action": "unpin",
  "path": "src/critical-module.ts"
}
```

```json
{
  "action": "evict",
  "pattern": "dist/**"
}
```

---

### `model_hint`

Set or clear the preferred model for the current task. Requires `taskId` to be present in the command context.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `model` | one-of | string | Model ID or tier to switch to |
| `reset` | one-of | boolean | Pass `true` to clear the hint |

Updates `model_hint` on the task row (the task row must already exist — the command fails if it does not). When a `modelRouter` is available, the requested model is validated against the cluster-wide pool. Capability requirements are derived from recent thread history (e.g., `vision` when the recent thread contains image blocks); capability mismatches log a warning but the hint is still accepted.

Example invocations:
```json
{"model": "opus"}
```

```json
{"reset": true}
```

---

### `archive`

Soft-delete one or more threads. One of `thread_id` or `older_than` must be provided.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `thread_id` | one-of | string | Specific thread UUID to archive |
| `older_than` | one-of | string | Archive threads inactive for this long (e.g., `7d`, `2w`, `3m`) |

For `older_than`, threads whose `last_message_at` is before the computed cutoff date are soft-deleted. Supports units: `d` (days), `w` (weeks), `m` (months).

Example invocations:
```json
{"thread_id": "t-abc123"}
```

```json
{"older_than": "30d"}
```

---

### `skill`

Consolidated skill management: activate, list, read, or retire.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `action` | yes | string | Skill operation: `activate`, `list`, `read`, or `retire` |
| `name` | with `activate`/`read`/`retire` | string | Skill name (must match `^[a-z0-9]+(-[a-z0-9]+)*$`) |
| `status` | with `list` | string | Filter by status: `active` or `retired` |
| `verbose` | with `list` | boolean | Show additional columns: `allowed_tools`, `compatibility`, `content_hash`, `retired_reason` |
| `reason` | with `retire` | string | Reason for retiring the skill |

**Actions:**

- `activate`: Activate a skill from the virtual filesystem. Reads `/home/user/skills/{name}/SKILL.md`, parses its YAML frontmatter, validates limits (64 KB max, 500 body lines max, 20 active skills cap), persists all files to `files` table, and upserts the skill record into `skills` table. Skill ID is a deterministic UUID derived from the name. Requires `ctx.fs` to be set.

- `list`: List skills with status, activation count, last-used timestamp, and description. Optional `status` filter shows `active` or `retired` only. Optional `verbose` flag adds more columns.

- `read`: Read the full SKILL.md content of a skill, along with a status header showing activation count, last-used timestamp, and content hash. Content is read from `files` table (path `/home/user/skills/{name}/SKILL.md`).

- `retire`: Retire a skill by name (soft-update status to `"retired"`). After retiring, scans all tasks whose `payload` JSON contains `"skill": "{name}"` and creates an advisory for each, prompting the operator to update or remove the reference.

Example invocations:
```json
{
  "action": "activate",
  "name": "code-reviewer"
}
```

```json
{
  "action": "list",
  "status": "active"
}
```

```json
{
  "action": "read",
  "name": "code-reviewer"
}
```

```json
{
  "action": "retire",
  "name": "old-formatter",
  "reason": "replaced by format-v2"
}
```

---

### `advisory`

Manage advisories (structured recommendations for operator review). Supports creating, listing, and transitioning the lifecycle of advisories.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `title` | with create | string | Advisory title |
| `detail` | with create | string | Advisory detail/description |
| `action` | no | string | Recommended corrective action |
| `impact` | no | string | Impact description |
| `list` | no | boolean | List advisories |
| `list_status` | no | string | Filter by status: `proposed`, `approved`, `deferred`, `applied`, `dismissed` |
| `approve` | no | string | Advisory ID prefix to approve |
| `apply` | no | string | Advisory ID prefix to apply |
| `dismiss` | no | string | Advisory ID prefix to dismiss |
| `defer` | no | string | Advisory ID prefix to defer |
| `defer_until` | no | string | ISO 8601 date to defer until (default: 24h from now) |

**Lifecycle:** `proposed` → (`approved` | `dismissed` | `deferred`) → `applied`. All transitions set `resolved_at` timestamps or `defer_until` for deferred advisories.

Example invocations:
```json
{
  "title": "Enable rate limiting",
  "detail": "Current config has no rate limits on the public API",
  "action": "Set RATE_LIMIT_RPM=100",
  "impact": "Prevents abuse and reduces LLM costs"
}
```

```json
{
  "list": true,
  "list_status": "proposed"
}
```

```json
{
  "approve": "550e8400"
}
```

---

### `notify`

Send a notification to users on configured platforms.

| Parameter | Required | Type | Description |
|---|---|---|---|
| `user` | one-of | string | Target bound username |
| `all` | one-of | boolean | Broadcast to all users |
| `platform` | yes | string | Platform name (e.g., `discord`) |
| `message` | yes | string | Notification message content |

Routes the message to a platform-specific DM thread (or creates one if needed) and enqueues a proactive notification. The agent will run inference to deliver the message via the platform connector.

Example invocations:
```json
{
  "user": "alice",
  "platform": "discord",
  "message": "Your deployment completed successfully"
}
```

```json
{
  "all": true,
  "platform": "discord",
  "message": "System maintenance in 5 minutes"
}
```

---

### `hostinfo`

Read operational information about the current host.

| Parameter | Required | Type | Description |
|---|---|---|---|
| (no params) | - | - | Read-only operation |

Returns host identity, model availability, MCP server status, and cluster configuration. No parameters required.

Example invocation:
```json
{}
```

---

## Scheduler

The `Scheduler` class drives all autonomous agent execution. It polls a task queue at a configurable interval and runs tasks via the `AgentLoop`.

### Construction and Startup

```typescript
const scheduler = new Scheduler(ctx, agentLoopFactory, { pollInterval: 5000 });
const { stop } = scheduler.start();
// ...later
stop();
```

`agentLoopFactory` is a `(config: AgentLoopConfig) => AgentLoop` callback. The scheduler uses it to instantiate a fresh `AgentLoop` for each task, keeping each run isolated.

The scheduler starts two timers on `start()`:

- **Main tick** — runs `tick()` via a self-rescheduling `setTimeout`, pacing on the current `getEffectivePollInterval()` (base default 5 seconds, subject to quiescence multiplier).
- **Heartbeat** — runs `updateHeartbeats()` every 30 seconds via `setInterval`, updating `heartbeat_at` for all currently running tasks to prevent eviction.

### 4-Phase Tick

Each tick invokes phases in sequence:

```
tick()
  -> phase0Eviction()
  -> phase1Schedule()
  -> [phase2Sync() — reserved]
  -> phase3Run()
```

#### Phase 0 — Eviction

Two sweeps:

1. **Lease expiry** — any task in `claimed` status whose `claimed_at` is older than 5 minutes is reset to `pending` (lease cleared). This recovers tasks that were claimed but never started.
2. **Heartbeat timeout** — any task in `running` status whose `heartbeat_at` is older than 5 minutes is marked `failed` with error `"evicted due to heartbeat timeout"` (and `consecutive_failures` is incremented). This reclaims tasks from crashed workers.

```
LEASE_DURATION    = 300_000 ms  (5 minutes)
EVICTION_TIMEOUT  = 300_000 ms  (5 minutes)
```

#### Phase 1 — Schedule

Fetches up to 100 tasks in `pending` status whose `next_run_at <= now`, ordered by `next_run_at ASC`. For each, `canRunHere()` is called to check:

- All dependencies listed in `depends_on` are `completed` (or don't exist, which is treated as failed).
- If `require_success` is set, no dependency may be in `failed` state.
- If `requires.host` is specified, it must match `ctx.hostName` (exact or glob), or be a matching array; `requires.site_id` is also honored.

Tasks that pass are updated to `claimed` with `claimed_by = ctx.siteId`.

#### Phase 2 — Sync

Reserved for cross-host synchronisation (not yet active).

#### Phase 3 — Run

Fetches up to 10 tasks in `claimed` status owned by this host (by `ctx.siteId`), ordered by `created_at ASC`. Each is dispatched asynchronously to avoid blocking the tick. The run sequence for each task:

1. Generate a `leaseId` (UUID) and set `status = 'running'`, `heartbeat_at = now`.
2. Record the task in `runningTasks` map for heartbeat updates.
3. Instantiate an `AgentLoop` via the factory and call `run()`.
4. On completion, verify `lease_id` still matches (guards against concurrent eviction).
5. If the lease is still valid, set `status = 'completed'`, store `result`, increment `run_count`.
6. For `cron` tasks, compute the next `next_run_at` via `computeNextRunAt()` and reset status to `pending`.
7. On error, if the lease is still valid, set `status = 'failed'` with the error string.

### Cron Parsing

`computeNextRunAt(cronExpr, from)` parses a 5-field cron expression:

```
<minute> <hour> <day> <month> <weekday>
```

Supported field syntax:

| Syntax | Example | Meaning |
|---|---|---|
| Wildcard | `*` | Every value in range |
| Single value | `5` | Exact match |
| Range | `1-5` | Inclusive range |
| Step | `*/15` or `0-30/5` | Every N within range |
| List | `1,3,5` | Enumerated values |

Day-of-month and day-of-week fields are evaluated with OR semantics (a match on either satisfies the date check), consistent with standard cron behaviour.

The parser scans forward from `from + 1 minute` up to 4 years. If no matching time is found within that window, an error is thrown.

```typescript
// Every weekday at 09:30
computeNextRunAt("30 9 * * 1-5")

// Every 15 minutes
computeNextRunAt("*/15 * * * *")

// First day of each month at midnight
computeNextRunAt("0 0 1 * *")
```

### DAG Resolution

`isDependencySatisfied(db, task)` implements the dependency gate:

- `depends_on` is a JSON array of task UUIDs (or a bare UUID string for single-dependency shorthand).
- A missing dependency (row not found) is treated as `failed`.
- If `task.require_success` is truthy, any dependency in `failed` state blocks the task.
- Otherwise, the task proceeds once all dependencies are `completed`.

`canRunHere` calls `isDependencySatisfied` as its first check before evaluating host affinity.

### Quiescence

The scheduler adjusts its effective poll interval based on user inactivity using a graduated-tier table. The `message:created` event resets the inactivity clock (and also resets `eventDepth`).

```
0-30m idle   : ×1
30m-1h idle  : ×2
1-4h idle    : ×3
4-12h idle   : ×5
12-24h idle  : ×10
```

`getEffectivePollInterval()` exposes this value. If any pending task has `no_quiescence = 1`, the base interval is used unconditionally. The interval is recomputed after every tick so changes take effect without restarting the scheduler.

### Event-Driven Tasks

`onEvent(eventType, payload)` is the entry point for reactive tasks. It queries for `pending` tasks of `type = 'event'` whose `trigger_spec` matches the event name, then claims them for this host (subject to the same `canRunHere` checks).

A re-entrancy guard (`eventDepth`) prevents cascading event chains from growing deeper than 5 levels:

```typescript
const MAX_EVENT_DEPTH = 5;
```

`onUserInteraction()` (wired to `message:created`) resets `eventDepth` to 0 on every user turn, ensuring the guard does not permanently block event processing after a burst.

### Seeding Cron Tasks

`seedCronTasks(db, cronConfigs, siteId)` inserts cron task rows on startup using deterministic UUIDs (`INSERT OR IGNORE`), so repeated calls are idempotent:

```typescript
seedCronTasks(db, [
  { name: "nightly-sweep",  cron: "0 2 * * *" },
  { name: "hourly-digest",  cron: "0 * * * *", payload: '{"mode":"summary"}' },
], siteId);
```

Task IDs are derived as `deterministicUUID(BOUND_NAMESPACE, "cron-{name}")`. Cron `trigger_spec` is stored as the raw expression (e.g. `"0 * * * *"`); the scheduler uses `extractCronExpression()` to handle both raw-string and JSON-wrapped forms at read time.

---

## MCP Bridge

The MCP bridge connects external [Model Context Protocol](https://modelcontextprotocol.io) servers to the Bound command system. It has two components: `MCPClient` (connection lifecycle) and `generateMCPCommands` (command generation).

### MCPClient Lifecycle

`MCPClient` manages a single server connection and its discovered capabilities.

```typescript
const client = new MCPClient({
  name:      "my-server",
  transport: "stdio",
  command:   "my-mcp-server",
  args:      ["--port", "3000"],
  allow_tools: ["search", "fetch"],  // optional allowlist
  confirm:     ["delete"],           // tools requiring confirmation
  // HTTP transport alternative:
  // transport: "http", url: "https://host/mcp", headers: { Authorization: "..." }
});

await client.connect();
// ... use client
await client.disconnect();
```

**Configuration fields:**

| Field | Description |
|---|---|
| `name` | Logical name used to prefix generated command names |
| `transport` | `"stdio"` (subprocess) or `"http"` (Streamable HTTP) |
| `command` | Executable to spawn (stdio only) |
| `args` | Arguments for the subprocess |
| `url` | Endpoint URL (http only) |
| `headers` | Optional request headers for the http transport |
| `allow_tools` | If set, only tools in this list are exposed as commands |
| `confirm` | Tools that require explicit confirmation in autonomous mode |

**Methods:**

| Method | Description |
|---|---|
| `connect()` | Establishes the transport connection and loads capabilities |
| `disconnect()` | Closes the connection and clears all cached tools/resources/prompts |
| `listTools()` | Returns discovered `ToolDefinition[]`; throws if not connected |
| `listResources()` | Returns discovered `ResourceDefinition[]`; throws if not connected |
| `listPrompts()` | Returns discovered `PromptDefinition[]`; throws if not connected |
| `callTool(name, args)` | Invokes a tool and returns `ToolResult` |
| `readResource(uri)` | Fetches resource content by URI |
| `invokePrompt(name, args)` | Invokes a prompt template with argument substitution |
| `isConnected()` | Returns current connection state |
| `getConfig()` | Returns the `MCPServerConfig` used at construction |


### Auto-Generated Commands from MCP Tools

MCP bridge commands are the only commands still dispatched through the bash sandbox via `CommandDefinition` handlers. All other agent tools use the native `RegisteredTool` architecture described above.

`generateMCPCommands(clients, confirmGates)` iterates all connected clients and creates **one `CommandDefinition` per MCP server** (not one per tool). The command name is the server name (e.g., `"github"`). It returns an `MCPCommandsResult`:

```typescript
interface MCPCommandsResult {
  commands:    CommandDefinition[];
  serverNames: Set<string>; // server-level command names (excludes meta-commands)
}
```

Each server command accepts an optional `subcommand` parameter that selects the tool within that server (e.g., `github --subcommand create_issue`). Tool-specific arguments pass through alongside `subcommand`.

When no `subcommand` is provided (or `subcommand="help"`), the command prints a listing of all available subcommands for that server. Tools not in `allow_tools` (if configured) are silently excluded from the dispatch table.

**Confirmation gate:** If a subcommand appears in the server's `confirm` list and the current execution context has a `taskId` that does not start with `"interactive-"` (indicating autonomous mode), the command returns exit code 1 with an error message rather than invoking the tool.

```typescript
const { commands: mcpCommands, serverNames } = await generateMCPCommands(clients, confirmGates);
setCommandRegistry(mcpCommands, serverNames);
```

### Host MCP Info

`updateHostMCPInfo(db, siteId, clients)` writes the current server names to the `hosts` table:

```sql
UPDATE hosts
SET mcp_servers = ?,    -- JSON array of all server names (connected or not)
    mcp_tools   = ?,    -- JSON array of connected server names (flat string[])
    modified_at = ?
WHERE site_id = ?
```

Under the subcommand dispatch model, `mcp_tools` stores **server names** (e.g., `["github", "slack"]`), not individual `"{server}-{tool}"` strings. Delegation affinity is evaluated at the server level: `getDelegationTarget()` checks whether a candidate host's `mcp_tools` contains the server names used in the thread's recent tool calls, not the individual tool names. Only connected clients contribute to `mcp_tools`; `mcp_servers` lists all configured servers regardless of connection state.

Call this after all clients have connected to keep the host record current.

### Access Commands

`generateMCPCommands` also registers four fixed commands for browsing and invoking MCP capabilities:

#### `resources`

List all resources across connected servers.

| Argument | Required | Description |
|---|---|---|
| `server` | no | Filter output to a single server |

Output format: `{server}: {uri} ({name})`, one entry per line.

#### `resource`

Read the content of a specific resource by URI.

| Argument | Required | Description |
|---|---|---|
| `uri` | yes | Resource URI |
| `server` | no | Hint to search a specific server first |

Tries each connected server in turn until one returns content for the URI.

#### `prompts`

List all prompt templates across connected servers.

| Argument | Required | Description |
|---|---|---|
| `server` | no | Filter output to a single server |

Output format: `{server}: {name} ({description})`, one entry per line.

#### `prompt`

Invoke a prompt template. The name argument uses the format `{server}/{prompt-name}`.

| Argument | Required | Description |
|---|---|---|
| `name` | yes | `{server}/{prompt-name}` |
| `...` | no | Additional key-value pairs passed as prompt arguments |

```
prompt --name "docs/summarize" --topic "agent loop"
```

---

## Advanced Features

### Advisories

Advisories are structured recommendations that the agent (or external systems) can propose for human review. They are stored in the `advisories` table and follow a lifecycle: `proposed -> approved | dismissed | deferred -> applied`.

```typescript
import {
  createAdvisory,
  approveAdvisory,
  dismissAdvisory,
  deferAdvisory,
  applyAdvisory,
  getPendingAdvisories,
} from "@bound/agent/advisories";
```

**Creating an advisory:**

```typescript
const id = createAdvisory(db, {
  type:     "config-change",
  status:   "proposed",          // always overwritten to "proposed" in insert
  title:    "Enable rate limiting",
  detail:   "Current config has no rate limits on the public API.",
  action:   "Set RATE_LIMIT_RPM=100 in environment",
  impact:   "Prevents abuse and reduces LLM costs",
  evidence: "task-id-xyz produced 800 calls in 60 seconds",
}, siteId);
```

The `advisory` native tool exposes the same lifecycle via parameters (see [Native Agent Tools — advisory](#advisory) for details).

**Lifecycle transitions:**

| Function | New status | Notes |
|---|---|---|
| `approveAdvisory` | `approved` | Sets `resolved_at` |
| `dismissAdvisory` | `dismissed` | Sets `resolved_at` |
| `deferAdvisory` | `deferred` | Sets `defer_until` instead of `resolved_at` |
| `applyAdvisory` | `applied` | Sets `resolved_at` |

All mutating functions return `Result<void, Error>` from `@bound/shared`.

**Fetching actionable advisories:**

```typescript
const pending = getPendingAdvisories(db);
```

Returns all advisories in `proposed` status, plus `deferred` advisories whose `defer_until` timestamp is in the past. Results are ordered by `proposed_at ASC, rowid ASC`.

---

### Message Redaction

`redactMessage` and `redactThread` overwrite message content in-place with the literal string `"[redacted]"`.

```typescript
import { redactMessage, redactThread } from "@bound/agent/redaction";

// Redact a single message
redactMessage(db, messageId, siteId);

// Redact every message in a thread (and tombstone related memories)
const result = redactThread(db, threadId, siteId);
// result.value = { messagesRedacted: number, memoriesAffected: number, edgesAffected?: number }
```

**Thread redaction cascade:**

1. All `messages` rows where `thread_id` matches have their `content` set to `"[redacted]"` via `updateRow` (so a change-log entry is created and the redaction propagates via sync).
2. All `semantic_memory` rows where `source` matches the thread ID are soft-deleted (`deleted = 1`), and edges referencing those keys are cascade-tombstoned. This removes any facts the agent extracted from that conversation.

Both functions return `Result<void | RedactionResult, Error>`. The cascade is non-atomic — if the process is interrupted partway through, some messages may be redacted while others are not. Callers that require atomicity should wrap calls in a SQLite transaction.

---

### Thread Title Generation

`generateThreadTitle` uses the LLM to produce a concise title for a thread, storing it in the `threads` table.

```typescript
import { generateThreadTitle } from "@bound/agent/title-generation";

const result = await generateThreadTitle(db, threadId, llmBackend, siteId);
if (result.ok) {
  console.log(result.value); // "Refactoring the agent loop scheduler"
}
```

**Behaviour:**

- If `threads.title` is already non-null, the function returns the existing title immediately without calling the LLM (at-most-once guarantee).
- If no user message exists in the thread, the function returns an error.
- The LLM is called with `max_tokens: 100` and prompted to return only the title (5–10 words) with no additional text.
- The generated title is persisted to `threads.title` before returning.

The prompt structure:

```
Generate a short, single-line title (5-10 words) for this conversation.
No markdown, no quotes, no punctuation at the start. Return ONLY the title text on one line.

User: {first user message}
Assistant: {first assistant message}   <- omitted if not yet available
```

After the LLM responds, the output is sanitized (newlines collapsed, leading markdown/quote characters stripped) and capped at 80 characters. If the LLM returns empty output or throws, a fallback derives the title from the first user message (either via `titleFromPayload` for JSON task payloads or the first 50 characters).

---

### Summary Extraction

`extractSummaryAndMemories` summarises recent unsummarised messages and extracts key facts into `semantic_memory`.

```typescript
import { extractSummaryAndMemories } from "@bound/agent/summary-extraction";

const result = await extractSummaryAndMemories(db, threadId, llmBackend, siteId);
// result.value = { summaryGenerated: boolean, memoriesExtracted: number }
```

**Behaviour:**

- Reads `threads.summary_through` to find the high-water mark of the last summarisation.
- Fetches all messages created after that timestamp.
- If no new messages exist, returns `{ summaryGenerated: false, memoriesExtracted: 0 }` immediately.
- Calls the LLM with `max_tokens: 200` to produce a 2–3 sentence summary.
- Stores the summary in `threads.summary` and updates `summary_through` to the current time.
- Creates up to 3 `semantic_memory` rows for extracted facts (keyed as `thread_{threadId}_fact_{n}`).

**Cross-thread digest:**

`buildCrossThreadDigest(db, userId)` produces a plain-text summary of the user's 5 most recently active threads, suitable for injecting into a new session's context:

```
Recent Activity Digest:

- Refactoring the agent loop: 47 messages (last updated 2026-03-22T18:00:00Z)
- API design discussion: 12 messages (last updated 2026-03-21T09:15:00Z)
```

---

### File-Thread Tracking

The file-thread tracker records which thread last modified each file path. This enables the system to notify the agent when a file it is working with was also touched by a different thread.

```typescript
import {
  trackFilePath,
  getLastThreadForFile,
  getFileThreadNotificationMessage,
} from "@bound/agent/file-thread-tracker";
```

Storage uses `semantic_memory` with keys prefixed `_internal.file_thread.{filePath}`. The value is the `threadId`.

**Recording a file write:**

```typescript
trackFilePath(db, "/workspace/src/agent-loop.ts", currentThreadId, siteId);
```

Upserts the mapping. If an entry already exists for the path, its value is updated; otherwise a new row is inserted.

**Querying the last thread:**

```typescript
const lastThread = getLastThreadForFile(db, "/workspace/src/agent-loop.ts");
if (lastThread && lastThread !== currentThreadId) {
  const threadTitle = /* look up thread title */;
  const msg = getFileThreadNotificationMessage(
    "/workspace/src/agent-loop.ts",
    threadTitle,
  );
  // msg = 'File /workspace/src/agent-loop.ts was modified from thread "...".'
}
```

`getFileThreadNotificationMessage` returns a human-readable warning string intended to be surfaced to the user or appended to the volatile context before an LLM call.

---

## Relay Transport

The agent package contains all requester-side and target-side relay logic for cross-host operations.

### Model Resolution

**Source:** `packages/agent/src/model-resolution.ts`

`resolveModel(modelId, modelRouter, db, localSiteId, requirements?)` uses a three-phase pipeline to return a `ModelResolution` discriminated union:

```typescript
interface CapabilityRequirements {
  vision?:          boolean;
  tool_use?:        boolean;
  system_prompt?:   boolean;
  prompt_caching?:  boolean;
}

type ModelResolution =
  | { kind: "local";  backend: LLMBackend; modelId: string; reResolved?: boolean }
  | { kind: "remote"; hosts: EligibleHost[]; modelId: string; reResolved?: boolean }
  | { kind: "error";  error: string;
      reason?: "capability-mismatch" | "transient-unavailable";
      unmetCapabilities?: string[];
      alternatives?: string[];
      earliestRecovery?: number };
```

The three phases:

- **identify** — checks local backends first (via `modelRouter.tryGetBackend()`), then remote hosts (via `findEligibleHostsByModel()`). If `modelId` is undefined, the router's default ID is used.
- **qualify** — if `requirements` is provided, checks the identified backend's effective capabilities. On mismatch, attempts to re-route to an eligible alternative from `modelRouter.listEligible(requirements)`. Distinguishes permanent capability mismatch (no backend in the cluster has the required capability) from transient rate-limit unavailability (capable backends exist but are all rate-limited, `earliestRecovery` is set to the soonest recovery timestamp). When re-routing succeeds, the result carries `reResolved: true`. When `requirements` is omitted, this phase is a no-op (backward-compatible).
- **dispatch** — returns the qualified resolution.

The agent loop derives `CapabilityRequirements` before `ASSEMBLE_CONTEXT` on each turn: `tool_use` is set when tools are configured; `vision` is set when recent messages contain image content blocks. These requirements are passed to `resolveModel()`. On `LLM_CALL` 429/529 errors, the loop marks the backend rate-limited via `modelRouter.markRateLimited()`, using `LLMError.retryAfterMs` from the parsed `Retry-After` header or a 60-second default.

`findEligibleHostsByModel(db, modelId, localSiteId, requirements?)` queries the `hosts` table for hosts whose `models` JSON column contains the requested model ID. Hosts with `online_at` older than 5 minutes are excluded. When `requirements` is provided, hosts with verified capability metadata are filtered to those meeting all requirements; unverified hosts are included as a fallback. Results are sorted by tier then `online_at` descending.

### `RELAY_STREAM` — Remote Inference

**Source:** `packages/agent/src/agent-loop.ts`, method `relayStream()`

When `resolveModel()` returns `kind: "remote"`, `LLM_CALL` constructs an `InferenceRequestPayload` and enters `RELAY_STREAM`:

1. Writes an `inference` outbox entry with a UUID `stream_id`.
2. Waits for `relay:inbox` events (with a 500ms fallback timer) so sync-delivered chunks are processed immediately.
3. Reads `stream_chunk` / `stream_end` inbox entries via `readInboxByStreamId()`.
4. Buffers received `stream_chunk` entries by `seq`; yields contiguous chunks in order.
5. Gaps (missing seq) are skipped after `MAX_GAP_CYCLES = 6` polling cycles (~3s) with a warning log.
6. `stream_end` closes the generator.
7. On abort, writes a `cancel` outbox entry with `ref_id = inference outbox entry ID`.
8. Per-host timeout: `inference_timeout_ms` (default 300s, configurable via `sync.relay.inference_timeout_ms`). On timeout, generates a new `stream_id` and retries on the next eligible host.
9. After the first chunk, records `relay_target` and `relay_latency_ms` on the turn row via `recordTurnRelayMetrics`.

**Large prompts (AC1.9):** If the serialized `InferenceRequestPayload` exceeds 2MB, the messages array is written to the `files` table (path `cluster/relay/inference-{uuid}.json`) and the payload sets `messages_file_ref` / `messages: []`. The file syncs to all cluster hosts; the target reads it by path.

### `RELAY_WAIT` — Remote Tool Calls

**Source:** `packages/agent/src/agent-loop.ts`, method `relayWait()`

When a tool call targets a remote host (detected via `isRelayRequest()` in the MCP bridge), `TOOL_EXECUTE` enters `RELAY_WAIT`. The loop polls `relay_inbox` for a `result` or `error` response keyed by the outbox entry's `idempotency_key`. Per-host timeout: 30s; failover to next eligible host.

### `RelayProcessor` — Target-Side Execution

**Source:** `packages/agent/src/relay-processor.ts`

`RelayProcessor` runs on the target host, polling `relay_inbox` for unprocessed entries. It handles:

| Kind | Handler | Behaviour |
|------|---------|-----------|
| `tool_call` | `executeToolCall()` | Calls local MCP server via subcommand dispatch, writes `result`/`error` |
| `resource_read` | `executeResourceRead()` | Reads MCP resource |
| `prompt_invoke` | `executePromptInvoke()` | Invokes MCP prompt |
| `cache_warm` | `executeCacheWarm()` | Warms the file cache for requested paths. |
| `inference` | `executeInference()` | Runs local `LLMBackend.chat()`, writes streaming `stream_chunk`/`stream_end` outbox entries |
| `process` | `executeProcess()` | Starts a full `AgentLoop` on the delegated thread, emits `status_forward` outbox entries |
| `intake` | `handleIntake()` | Routes inbound platform messages to the appropriate spoke via a four-tier algorithm (thread affinity → model match → tool match → least-loaded fallback) and writes a `process` outbox entry targeting the selected host. |
| `platform_deliver` | `handlePlatformDeliver()` | Emits `platform:deliver` on the local event bus so the platform connector delivers the message to the external platform. |
| `event_broadcast` | `handleEventBroadcast()` | Fires the named event locally on the event bus; sync routes broadcast entries to all spokes except the source. |

`cancel` entries are special-cased: when encountered in the inbox, they abort any active inference stream for the referenced `ref_id` and are not routed through the dispatch table. `status_forward` entries originate from `executeProcess` and are consumed by the requester-side cache to serve `/api/threads/{id}/status`.

**`executeInference` buffering:** Chunks are flushed to outbox at 200ms timer OR 4KB buffer threshold, whichever fires first. The final flush is always `stream_end`. Each flush records a `relay_cycles` row. Cancel aborts the `for await` loop via `AbortController.signal.aborted` and writes an `error` response.

**`executeProcess` — platform tools:** When `payload.platform` is set and a `PlatformConnectorRegistry` has been injected, `executeProcess()` calls `getPlatformTools()` on the matching connector and passes the result into the delegated `AgentLoopConfig`. This allows the delegated loop to call platform tools (e.g., `discord_send_message`) explicitly. After the loop completes, a `platform:deliver` event with empty content is emitted to stop the typing indicator regardless of whether the agent produced output. When `payload.platform` is not set, the legacy auto-deliver path finds the last assistant message and emits it.

**`setPlatformConnectorRegistry(registry)`:** Wired at startup (after `PlatformConnectorRegistry` is created) to avoid circular initialization order. The `setAgentLoopFactory(factory)` method is wired similarly.

**Constructor:** `new RelayProcessor(db, siteId, mcpClients, modelRouter, keyringSiteIds, logger, eventBus, appCtx?, relayConfig?, threadAffinityMap?, agentLoopFactory?)`

### Loop Delegation

**Source:** `packages/agent/src/delegation.ts`, `packages/cli/src/commands/start/server.ts`

Before starting a local `AgentLoop`, `server.ts` checks `getDelegationTarget()` which returns a target `EligibleHost` when all AC6.1 conditions hold:

1. `resolveModel()` returns `kind: "remote"` for the thread's model.
2. Exactly one host has the model.
3. That host has ≥50% of the thread's 20 most-recent tool calls in its `mcp_tools`.
4. Vacuous match: threads with no tool history also delegate (condition 3 vacuously true).

When delegation fires, `dispatchDelegation()` writes a `process` outbox entry targeting the host and polls for a new assistant message to appear in the thread (indicating the delegated loop finished and synced back). The originator tracks the delegation in `activeDelegations` for cancel routing: cancel emits `agent:cancel` locally AND writes a `cancel` relay message with `ref_id` matching the `process` outbox entry ID.

**Status forwarding:** While the delegated loop runs on the target, `executeProcess()` writes `status_forward` outbox entries on each state change. These sync back and are received by the originating host's `RelayProcessor`, which emits `status:forward` events cached in `statusForwardCache`. The web server serves this from `/api/threads/{id}/status`.

**Confirmed tools on delegated loops:** `AgentLoop` instances created by `executeProcess()` use `taskId = "delegated-{id}"`, which does NOT start with `"interactive-"`. The MCP bridge blocks confirmed-tool prompts for non-interactive task IDs, so the delegated agent receives block errors instead of asking the user for confirmation.

**`ProcessPayload.message_id` resolution:** The `message_id` the spoke forwards must exist in the delegating host's `messages` table so `executeProcess()` can load it. User-message queue entries already store the real message id, but `enqueueNotification()` stores a synthetic UUID, so forwarding `dispatch_queue.message_id` directly drops notifications on the receiving side. `resolveDelegationMessageId()` in `packages/cli/src/commands/start/server.ts` injects any claimed notifications into `messages` and returns the id to forward. `executeProcess()` degrades gracefully (warns, proceeds on thread state) when it cannot resolve the row, but the spoke remains the source of truth — see critical invariant 18 in [CONTRIBUTING.md](../../CONTRIBUTING.md#critical-invariants).
