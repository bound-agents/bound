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
| `ASSEMBLE_CONTEXT` | Runs the 8-stage context assembly pipeline (see below). |
| `LLM_CALL` | Streams tokens from the LLM backend, accumulating `StreamChunk` objects. |
| `PARSE_RESPONSE` | Iterates accumulated chunks to extract text content and detect tool-use starts. |
| `TOOL_EXECUTE` | Dispatches tool calls via the sandbox. |
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
  taskId?: string;
  userId: string;
  modelId?: string;
  abortSignal?: AbortSignal;
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
  -> ASSEMBLE_CONTEXT (8-stage pipeline)
  -> LLM_CALL         (streaming)
     [on error] -> ERROR_PERSIST -> return with error field
  -> PARSE_RESPONSE
  -> TOOL_EXECUTE     (if tool use detected)
  -> RESPONSE_PERSIST (writes assistant message row)
  -> FS_PERSIST       (workspace flush)
  -> QUEUE_CHECK
  -> IDLE             (return result)
```

During `LLM_CALL`, each `StreamChunk` is collected. If `this.aborted` is set at any point during streaming, the loop breaks out of the chunk iterator early (no error is raised; the partial response is still processed).

If the LLM backend throws, the loop transitions to `ERROR_PERSIST`, writes an `alert`-role message to `messages` with the error text, and returns immediately with the error populated in the result.

Any other unhandled error caught by the outer `try/catch` also transitions to `ERROR_PERSIST` and returns with the error field set.

### Cancel Support

```typescript
const ac = new AbortController();
const loop = new AgentLoop(ctx, sandbox, llm, {
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

`assembleContext(params: ContextParams): LLMMessage[]` is a pure, synchronous function that builds the full message array to be sent to the LLM. It runs in 8 stages described in spec §13.1.

```typescript
interface ContextParams {
  db:           Database;
  threadId:     string;
  taskId?:      string;
  userId:       string;
  currentModel?: string;
  noHistory?:   boolean;   // skip message retrieval (default: false)
  configDir?:   string;    // persona search root (default: "config")
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

### Stage 6 — ASSEMBLY

The final message array is composed in this order:

1. **Base system prompt** — a hardcoded instruction establishing the assistant identity and tool-use posture.
2. **Persona** (optional) — the contents of `{configDir}/persona.md` injected as a second `system` message. The persona file is loaded once and cached in module-level variables keyed by `configDir` path. If the file does not exist, this message is omitted.
3. **Message history** — all annotated messages from stage 5.
4. **Volatile context** — a trailing `system` message containing `User ID` and `Thread ID`. Omitted when `noHistory` is true.

```
[ system: base prompt ]
[ system: persona ]       <- only if config/persona.md exists
[ ... history messages ]
[ system: volatile ctx ]  <- only when noHistory is false
```

### Stage 7 — BUDGET_VALIDATION

Estimates token count using a 1-token-per-4-characters approximation across all assembled messages. The context window is set to 8,000 tokens. If the estimate exceeds this limit:

1. System messages are separated from history messages.
2. History is truncated to the most recent 10 non-system messages.
3. The truncated array `[...systemMessages, ...remaining]` is returned.

### Stage 8 — METRIC_RECORDING

Reserved for token usage recording when the metrics subsystem is available. Currently a no-op placeholder.

### Persona Injection

Place a Markdown file at `config/persona.md` (relative to the working directory, or at the path passed via `configDir`) to inject a custom persona into every LLM call. The file is read once on first use per `configDir` value and cached for subsequent calls.

```
config/
  persona.md   <- injected as a system message after the base prompt
```

---

## Built-in Commands

Commands are defined as `CommandDefinition` objects from `@bound/sandbox` and dispatched by the sandbox during tool execution. All 16 built-in commands are registered via `getAllCommands()` in `packages/agent/src/commands/index.ts`.

Each command returns a `CommandResult`:

```typescript
interface CommandResult {
  stdout:   string;
  stderr:   string;
  exitCode: number; // 0 = success, non-zero = error
}
```

---

### `query`

Execute a read-only SQL query against the agent database.

| Argument | Required | Description |
|---|---|---|
| `query` | yes | A SQL `SELECT` statement |

Only `SELECT` statements are permitted; the handler rejects any query that does not begin with `SELECT` after trimming and upper-casing. Results are printed as tab-separated values with a header row.

```
query --query "SELECT id, status FROM tasks WHERE status = 'pending'"
```

---

### `memorize`

Upsert a key-value pair in `semantic_memory`.

| Argument | Required | Description |
|---|---|---|
| `key` | yes | Memory key |
| `value` | yes | Memory value |
| `source` | no | Source of the memory entry (default: `"agent"`) |

The row ID is computed as a deterministic UUID derived from the key using `BOUND_NAMESPACE`. If a non-deleted entry with the same key already exists, its `value`, `source`, and `last_accessed_at` are updated; otherwise a new row is inserted.

```
memorize --key "project.language" --value "TypeScript" --source "user:conversation-id"
```

---

### `forget`

Soft-delete a key from `semantic_memory`.

| Argument | Required | Description |
|---|---|---|
| `key` | no | Memory key to remove |
| `prefix` | no | Delete all entries whose key starts with this prefix |

One of `key` or `prefix` must be provided. When `key` is supplied, looks up the entry by key and soft-deletes it if found. When `prefix` is supplied, all non-deleted entries whose key starts with that prefix are soft-deleted. Returns an error if neither is provided or if the key does not exist.

```
forget --key "project.language"
forget --prefix "config."
```

---

### `schedule`

Create a new task in the `tasks` table. Exactly one of `--in`, `--every`, or `--on` must be provided.

| Argument | Required | Description |
|---|---|---|
| `in` | one-of | Deferred run offset: `5m`, `2h`, `1d` |
| `every` | one-of | Cron expression (5-field) |
| `on` | one-of | Event name for event-driven trigger |
| `payload` | no | JSON string attached to the task |
| `requires` | no | Host affinity constraints (JSON) |
| `model-hint` | no | Preferred model ID for the run |
| `no-history` | no | Flag to suppress message history during run |
| `after` | no | Task ID this task depends on |
| `require-success` | no | Block if the dependency failed |
| `inject` | no | `results`, `status`, or `file` (default: `results`) |
| `alert-after` | no | Number of consecutive failures before an alert message is created |
| `quiet` | no | Suppress default output |

Returns the new task UUID on stdout.

```
# Run once in 30 minutes
schedule --in 30m --payload '{"action":"sweep"}'

# Run every night at midnight
schedule --every "0 0 * * *" --model-hint "claude-3-opus"

# Run whenever "deploy:finished" fires
schedule --on "deploy:finished" --after "task-uuid-abc" --require-success
```

---

### `cancel`

Cancel a pending or running task.

| Argument | Required | Description |
|---|---|---|
| `task-id` | no | UUID of the task to cancel |
| `payload-match` | no | Cancel all pending/claimed tasks whose payload contains this string |

One of `task-id` or `payload-match` must be provided. When `task-id` is supplied, that specific task is cancelled. When `payload-match` is supplied, all tasks in `pending` or `claimed` status whose `payload` field contains the match string are cancelled. Returns an error if neither is provided or if no matching task is found.

```
cancel --task-id "550e8400-e29b-41d4-a716-446655440000"
cancel --payload-match "cleanup:urgent"
```

---

### `emit`

Publish an event on the application event bus.

| Argument | Required | Description |
|---|---|---|
| `event` | yes | Event name |
| `payload` | no | JSON object to attach (default: `{}`) |

The payload is parsed and passed to `ctx.eventBus.emit`. Event-driven tasks whose `trigger_spec` matches the event name will be claimed by the scheduler on the next tick (see [Scheduler — Event-Driven Tasks](#event-driven-tasks)).

```
emit --event "data:ready" --payload '{"sourceId":"ds-42"}'
```

---

### `purge`

Insert a `purge`-role message that causes the context assembly pipeline to drop the targeted messages from subsequent LLM calls. One of `--ids` or (`--last` + `--thread-id`) must be provided.

| Argument | Required | Description |
|---|---|---|
| `ids` | one-of | Comma-separated message IDs |
| `last` | one-of | Number of most-recent messages to target |
| `thread-id` | with `last` | Thread to query for the last N messages |
| `create-summary` | no | Include a summary note in the purge record |

The purge message content is stored as:

```json
{ "target_ids": ["..."], "summary": "..." }
```

Stage 2 of context assembly reads this structure and excludes the listed IDs from the LLM context. The original message rows are not modified or deleted.

```
purge --last 10 --thread-id "t-abc123" --create-summary
```

---

### `await`

Poll until a set of tasks reach a terminal state (`completed`, `failed`, or `cancelled`).

| Argument | Required | Description |
|---|---|---|
| `task-ids` | yes | Comma-separated task UUIDs |

Returns a JSON object keyed by task ID, each containing `status`, `result`, and `error`. If the aggregated JSON exceeds 50 KB, the command reports the byte count instead of printing the full payload (to be buffered to a file in production).

```
await --task-ids "task-1,task-2,task-3"
```

---

### `cache-warm`

Pre-populate the file cache for a remote host by pulling files matching given glob patterns. Requires MCP proxy connectivity.

| Argument | Required | Description |
|---|---|---|
| `patterns` | no | Glob patterns of paths to warm |

```
cache-warm --patterns "src/**/*.ts"
```

---

### `cache-pin`

Mark a file as pinned so it is not evicted by cache pressure.

| Argument | Required | Description |
|---|---|---|
| `path` | yes | File path to pin |

Looks up the file by path in the `files` table. Returns an error if not found.

```
cache-pin --path "src/critical-module.ts"
```

---

### `cache-unpin`

Remove the pinned mark from a file, making it eligible for eviction.

| Argument | Required | Description |
|---|---|---|
| `path` | yes | File path to unpin |

```
cache-unpin --path "src/critical-module.ts"
```

---

### `cache-evict`

Immediately remove files from the cache that match a glob pattern.

| Argument | Required | Description |
|---|---|---|
| `pattern` | yes | Glob pattern (translated to SQL `LIKE`) |

`*` is converted to `%` and `?` to `_` for the underlying SQL `LIKE` clause. Matching non-deleted rows in `files` are soft-deleted.

```
cache-evict --pattern "dist/**"
```

---

### `model-hint`

Set or clear the preferred model for the current task. Requires `taskId` to be present in the command context.

| Argument | Required | Description |
|---|---|---|
| `model` | one-of | Model ID or tier string |
| `reset` | one-of | Pass `true` to clear the hint |

Updates `model_hint` on the task row. The agent loop reads this field when constructing its `AgentLoopConfig` for subsequent runs. If no task row exists yet (first run of an interactive session), a stub task row is inserted to carry the hint.

```
model-hint --model "claude-3-5-sonnet"
model-hint --reset true
```

---

### `archive`

Soft-delete one or more threads. One of `--thread-id` or `--older-than` must be provided.

| Argument | Required | Description |
|---|---|---|
| `thread-id` | one-of | Specific thread UUID to archive |
| `older-than` | one-of | Archive threads inactive for this long (e.g. `7d`, `2w`, `1m`) |

For `--older-than`, threads whose `last_message_at` is before the computed cutoff date are soft-deleted. Supports units: `d` (days), `w` (weeks), `m` (months).

```
archive --thread-id "t-abc123"
archive --older-than 30d
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

The scheduler starts two intervals on `start()`:

- **Main tick** — runs `tick()` at `pollInterval` (default 5 seconds).
- **Heartbeat** — runs `updateHeartbeats()` every 30 seconds, updating `heartbeat_at` for all currently running tasks to prevent eviction.

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
2. **Heartbeat timeout** — any task in `running` status whose `heartbeat_at` is older than 10 minutes is marked `failed` with error `"evicted due to heartbeat timeout"`. This reclaims tasks from crashed workers.

```
LEASE_DURATION    = 300_000 ms  (5 minutes)
EVICTION_TIMEOUT  = 600_000 ms  (10 minutes)
```

#### Phase 1 — Schedule

Fetches up to 100 tasks in `pending` status whose `next_run_at <= now`, ordered by `next_run_at ASC`. For each, `canRunHere()` is called to check:

- All dependencies listed in `depends_on` are `completed` (or don't exist, which is treated as failed).
- If `require_success` is set, no dependency may be in `failed` state.
- If `requires.host` is specified, it must match `ctx.hostName`.

Tasks that pass are updated to `claimed` with `claimed_by = ctx.hostName`.

#### Phase 2 — Sync

Reserved for cross-host synchronisation (not yet active).

#### Phase 3 — Run

Fetches up to 10 tasks in `claimed` status owned by this host, ordered by `created_at ASC`. Each is dispatched asynchronously via `setImmediate` to avoid blocking the tick. The run sequence for each task:

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

The scheduler adjusts its effective poll interval based on user inactivity. The `message:created` event resets the inactivity clock. After 1 hour of no user interaction, the poll interval scales linearly up to 5x the base rate.

```
effective = base * min(scale, 5)
scale     = 1 + ((inactivity - 1h) / 1h) * 4   (after the 1h threshold)
```

`getEffectivePollInterval()` exposes this value for inspection or external use. The main tick interval is fixed at startup; the quiescence factor is intended for callers that adjust the interval dynamically between starts.

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

Task IDs are derived as `deterministicUUID(BOUND_NAMESPACE, "cron-{name}")`.

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
});

await client.connect();
// ... use client
await client.disconnect();
```

**Configuration fields:**

| Field | Description |
|---|---|
| `name` | Logical name used to prefix generated command names |
| `transport` | `"stdio"` (subprocess) or `"sse"` (HTTP/SSE) |
| `command` | Executable to spawn (stdio only) |
| `args` | Arguments for the subprocess |
| `url` | Endpoint URL (SSE only) |
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

For testing, `registerTool`, `registerResource`, and `registerPrompt` allow injecting capabilities without a live server.

### Auto-Generated Commands from MCP Tools

`generateMCPCommands(clients, confirmGates)` iterates all connected clients and creates one `CommandDefinition` per exposed tool. The generated command name follows the pattern:

```
{server-name}-{tool-name}
```

For example, a server named `"search"` with a tool named `"web"` produces a command named `"search-web"`.

Tools not in `allow_tools` (if configured) are silently skipped.

**Confirmation gate:** If a tool appears in the server's `confirm` list and the current execution context has a `taskId` that does not start with `"interactive-"` (indicating autonomous mode), the command returns exit code 1 with an error message rather than invoking the tool.

```typescript
const mcpCommands = generateMCPCommands(clients, confirmGates);
const allCommands = addMCPCommands(getAllCommands(), mcpCommands);
```

### Host MCP Info

`updateHostMCPInfo(db, siteId, clients)` writes the current server names and flattened tool names to the `hosts` table:

```sql
UPDATE hosts
SET mcp_servers = ?,    -- JSON array of server names
    mcp_tools   = ?,    -- JSON array of "{server}-{tool}" strings
    modified_at = ?
WHERE site_id = ?
```

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
  status:   "proposed",          // always overridden to "proposed"
  title:    "Enable rate limiting",
  detail:   "Current config has no rate limits on the public API.",
  action:   "Set RATE_LIMIT_RPM=100 in environment",
  impact:   "Prevents abuse and reduces LLM costs",
  evidence: "task-id-xyz produced 800 calls in 60 seconds",
}, siteId);
```

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

Returns all advisories in `proposed` status, plus `deferred` advisories whose `defer_until` timestamp is in the past. Results are ordered by `proposed_at DESC`.

---

### Message Redaction

`redactMessage` and `redactThread` overwrite message content in-place with the literal string `"[redacted]"`.

```typescript
import { redactMessage, redactThread } from "@bound/agent/redaction";

// Redact a single message
redactMessage(db, messageId, siteId);

// Redact every message in a thread (and tombstone related memories)
const result = redactThread(db, threadId, siteId);
// result.value = { messagesRedacted: number, memoriesAffected: number }
```

**Thread redaction cascade:**

1. All `messages` rows where `thread_id` matches have their `content` set to `"[redacted]"`.
2. All `semantic_memory` rows where `source` matches the thread ID are soft-deleted (`deleted = 1`). This removes any facts the agent extracted from that conversation.

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
Based on the initial exchange below, generate a short title (5-10 words)
for this conversation thread. Return ONLY the title, nothing else.

User: {first user message}
Assistant: {first assistant message}   <- omitted if not yet available
```

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
trackFilePath(db, "/workspace/src/agent-loop.ts", currentThreadId);
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
