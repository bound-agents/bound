# Sandbox and LLM Packages

This document covers the `@bound/sandbox` and `@bound/llm` packages, which together provide the sandboxed execution environment and language model integration for the Bound agent system.

---

## @bound/sandbox

The sandbox package provides a controlled Bash execution environment built on top of the `just-bash` library. It manages a virtual filesystem, persists workspace changes to a SQLite database, defines custom commands that agents can invoke, and maintains an indexed view of overlay-mounted host directories.

### ClusterFs

**Source:** `packages/sandbox/src/cluster-fs.ts`

`createClusterFs` constructs a `MountableFs` instance that routes filesystem paths to different underlying storage backends.

The layout is fixed:

| Mount path | Backend | Notes |
|---|---|---|
| `/` (base) | `InMemoryFs` | Catch-all for everything not otherwise mounted |
| `/home/user` | `InMemoryFs` | The agent's primary working directory |
| `/mnt/<name>` (optional) | `OverlayFs` | Read-write overlay onto a real host directory |

```typescript
import { createClusterFs } from "@bound/sandbox";

const fs = createClusterFs({
  hostName: "worker-1",
  syncEnabled: true,
  overlayMounts: {
    // realPath on the host -> virtual mount point inside the sandbox
    "/projects/myapp": "/mnt/myapp",
  },
});
```

`overlayMounts` is a `Record<string, string>` mapping real host paths to their virtual mount points. Each entry becomes a read-write `OverlayFs`. Omitting the field means no overlay mounts are created.

#### Snapshotting and diffing

The OCC (Optimistic Concurrency Control) persistence model relies on before/after snapshots of the in-memory workspace. Two functions handle this:

- **`snapshotWorkspace(fs, options?)`** — Returns a `Map<string, string>` of `path -> SHA-256 hash`. When `options.paths` is provided, only those specific paths are snapshotted — used by the agent loop to scope pre-execution snapshots to in-memory (agent-written) files only, avoiding unnecessary hashing of overlay content. Without `paths`, falls back to scanning all `/home/user/` paths via `fs.getAllPaths()`. Directories and unreadable entries are skipped.

  ```typescript
  snapshotWorkspace(fs: IFileSystem, options?: { paths?: string[] }): Promise<Map<string, string>>
  ```

- **`diffWorkspace(before, after)`** — Synchronously compares two snapshots and returns a `FileChange[]` listing which paths were `"created"`, `"modified"`, or `"deleted"`. No filesystem access is needed; it operates purely on the hash maps.
- **`diffWorkspaceAsync(before, after, fs?)`** — Same diff logic, but if an `IFileSystem` is provided it also reads each changed file and populates the `content` and `sizeBytes` fields on each `FileChange`. This is the variant used by the persistence layer.

```typescript
interface FileChange {
  path: string;
  operation: "created" | "modified" | "deleted";
  content?: string;    // populated by diffWorkspaceAsync when fs is supplied
  sizeBytes?: number;
}
```

#### Hydration

Two helpers restore previously persisted files into a fresh filesystem at startup:

- **`hydrateWorkspace(fs, db)`** — Loads all non-deleted rows from the `files` table whose `path` does NOT start with `/mnt/` and writes them into `fs`. This covers all agent-written paths (including any outside `/home/user/`), allowing the VFS to persist arbitrary paths across restarts.

  ```typescript
  hydrateWorkspace(fs: MountableFs, db: Database): Promise<void>
  ```

- **`hydrateRemoteCache(fs, db, hostName)`** — Loads rows whose path matches `/mnt/<hostName>/%`. Used to warm the in-memory cache for a remote worker's file tree.

#### Per-loop snapshot isolation

The bootstrap sequence creates a `loopSandbox` wrapper per `AgentLoop` invocation via `agentLoopFactory`. Each invocation receives its own closure over the `ClusterFsResult`, providing two lifecycle hooks:

- **`capturePreSnapshot(paths?)`** — Called at the HYDRATE_FS agent loop state. Calls `snapshotWorkspace` scoped to the provided `paths` (the set of in-memory paths returned by `ClusterFsResult.getInMemoryPaths()`), capturing a before-image of the VFS for that specific loop run.
- **`persistFs()`** — Called at the FS_PERSIST agent loop state. Takes a post-execution snapshot of the same paths, diffs it against the pre-snapshot captured above, and calls `persistWorkspaceChanges` to flush any changes to the `files` table.

Because each loop invocation gets its own snapshot state via a closure, concurrent agent loops running against the same `ClusterFs` do not interfere with each other's pre/post snapshots.

---

### Filesystem Persistence (OCC)

**Source:** `packages/sandbox/src/fs-persist.ts`

`persistWorkspaceChanges` is the single entry point for flushing an agent's in-memory workspace changes to the database. It implements an optimistic concurrency control protocol to detect conflicting concurrent writes, enforces per-file and total-workspace size limits, and emits `file:changed` events after a successful commit.

#### Function signature

```typescript
async function persistWorkspaceChanges(
  db: Database,
  siteId: string,
  preSnapshot: Map<string, string>,
  postSnapshot: Map<string, string>,
  eventBus: TypedEventEmitter,
  options?: PersistOptions,
  fs?: IFileSystem,
): Promise<Result<PersistResult, PersistError>>
```

#### Lifecycle

1. **Diff** — `diffWorkspaceAsync` is called with the pre- and post-snapshots, plus the live `IFileSystem` so file contents are available for insert/update.
2. **Size checks** — Each changed file is checked against `maxFileSizeBytes` (default 1 MB). If any file exceeds the limit, the function returns an `err` without touching the database. If no individual file is too large, the total size of all changes is checked against `maxTotalSizeBytes` (default 50 MB).
3. **OCC conflict detection** — Inside a `BEGIN IMMEDIATE` transaction, each changed path is read from the database. If the current database content hashes differently from the pre-snapshot hash for that path, a conflict is recorded. The resolution strategy is last-write-wins (LWW): if the database row's `modified_at` timestamp is newer than the current time, the incoming write is skipped; otherwise it proceeds.
4. **Apply** — Created and modified files call `insertRow` or `updateRow` from `@bound/core`. Deleted files call `softDelete`, which sets `deleted = 1` rather than removing the row.
5. **Commit and emit** — After a successful `COMMIT`, `file:changed` events are emitted for each affected path on the provided `eventBus`.

#### Return types

```typescript
interface PersistResult {
  changes: number;       // number of rows written
  conflicts: number;     // number of OCC conflicts detected
  conflictPaths: string[];
}

interface PersistError extends Error {
  failedPaths: string[]; // paths that triggered a size limit violation
}
```

#### Size limit options

```typescript
interface PersistOptions {
  maxFileSizeBytes?: number;  // default: 1_048_576  (1 MB)
  maxTotalSizeBytes?: number; // default: 52_428_800 (50 MB)
}
```

---

### Command Framework

**Source:** `packages/sandbox/src/commands.ts`

Custom commands give agents access to system capabilities (database queries, event publishing, etc.) that are not available through standard shell utilities. The framework wraps the `just-bash` `defineCommand` primitive with typed argument parsing and a shared context object.

#### Types

```typescript
interface CommandDefinition {
  name: string;
  args: Array<{ name: string; required: boolean; description?: string }>;
  handler: (args: Record<string, string>, ctx: CommandContext) => Promise<CommandResult>;
}

interface CommandContext {
  db: Database;
  siteId: string;
  eventBus: TypedEventEmitter;
  logger: Logger;
  threadId?: string;
  taskId?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

`CommandContext` is injected at registration time and shared across all commands in the set. It provides access to the database, the CRDT site identifier, the event bus, and optional thread/task scoping.

#### createDefineCommands

`createDefineCommands(definitions, context)` takes an array of `CommandDefinition` objects and a single `CommandContext` and returns a list of `just-bash` `CustomCommand` objects ready to be passed to `createSandbox`.

Argument parsing is positional: `argv[0]` maps to the first declared argument, `argv[1]` to the second, and so on. If a required argument is absent, the handler returns `exitCode: 1` immediately with an appropriate message on `stderr`. Handler exceptions are caught and surfaced as `exitCode: 1` with the error message on `stderr`.

#### Example — registering a custom command

```typescript
import { createDefineCommands } from "@bound/sandbox";
import type { CommandDefinition, CommandContext } from "@bound/sandbox";

const definitions: CommandDefinition[] = [
  {
    name: "db-query",
    args: [
      { name: "sql", required: true, description: "SQL statement to run" },
    ],
    handler: async (args, ctx) => {
      try {
        const rows = ctx.db.query(args.sql).all();
        return {
          stdout: JSON.stringify(rows, null, 2),
          stderr: "",
          exitCode: 0,
        };
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }
    },
  },
];

const context: CommandContext = {
  db,
  siteId: "site-abc",
  eventBus,
  logger,
};

const commands = createDefineCommands(definitions, context);
```

---

### Sandbox Factory

**Source:** `packages/sandbox/src/sandbox-factory.ts`

`createSandbox` assembles a `just-bash` `Bash` instance from a `ClusterFs`, a set of custom commands, and optional network and execution limit configuration.

```typescript
interface SandboxConfig {
  clusterFs: MountableFs;
  commands: CustomCommand[];
  networkConfig?: NetworkConfig;
  executionLimits?: ExecutionLimits;
}

interface ExecutionLimits {
  maxCallDepth?: number;
  maxCommandCount?: number;
  maxLoopIterations?: number;
}
```

When `executionLimits` is omitted, the following defaults are applied:

| Limit | Default |
|---|---|
| `maxCallDepth` | 50 |
| `maxCommandCount` | 10 000 |
| `maxLoopIterations` | 10 000 |

When `executionLimits` is provided, any omitted fields fall back to those same defaults.

`networkConfig` is passed through directly to `just-bash` and controls whether the sandbox can make outbound network requests.

#### End-to-end sandbox creation example

```typescript
import { createClusterFs, createDefineCommands, createSandbox } from "@bound/sandbox";

// 1. Build the filesystem
const clusterFs = createClusterFs({
  hostName: "worker-1",
  syncEnabled: true,
  overlayMounts: {
    "/projects/myapp": "/mnt/myapp",
  },
});

// 2. Hydrate from the database so prior state is available
await hydrateWorkspace(clusterFs, db);

// 3. Take a pre-snapshot before the agent runs (scope to in-memory paths only)
const preSnapshot = await snapshotWorkspace(clusterFs, { paths: clusterFs.getInMemoryPaths() });

// 4. Register commands
const commands = createDefineCommands(definitions, context);

// 5. Create the sandbox
const sandbox = await createSandbox({
  clusterFs,
  commands,
  executionLimits: {
    maxCommandCount: 5000,
  },
});

// 6. Run the agent's shell script inside the sandbox
await sandbox.exec('echo "hello from the sandbox"');

// 7. Persist any changes the agent made
const postSnapshot = await snapshotWorkspace(clusterFs, { paths: clusterFs.getInMemoryPaths() });
const result = await persistWorkspaceChanges(
  db, siteId, preSnapshot, postSnapshot, eventBus, {}, clusterFs
);
```

---

### Overlay Index Scanner

**Source:** `packages/sandbox/src/overlay-scanner.ts`

The overlay scanner maintains an `overlay_index` table in the database that mirrors the content of host directories mounted via `OverlayFs`. It detects new files, changed files, and files that have been removed since the last scan.

#### scanOverlayIndex

```typescript
function scanOverlayIndex(
  db: Database,
  siteId: string,
  overlayMounts: Record<string, string>,
): ScanResult
```

For each mount path in `overlayMounts`, `scanOverlayIndex` recursively walks the directory tree on the host filesystem. For every file found:

- A deterministic UUID v5 is derived from the file's path using the fixed Bound namespace UUID (`550e8400-e29b-41d4-a716-446655440000`), so IDs are stable across restarts.
- A SHA-256 hash of the file content is computed.
- If no existing non-deleted row exists for that ID, a new row is inserted.
- If a row exists but the stored content hash differs, the row is updated with the new hash and size.

After the directory walk, any rows in `overlay_index` for this `siteId` that were not encountered during the scan are soft-deleted (`deleted = 1`). This handles files that were removed from the host since the last scan.

```typescript
interface ScanResult {
  created: number;
  updated: number;
  tombstoned: number;
}
```

#### startOverlayScanLoop

```typescript
function startOverlayScanLoop(
  db: Database,
  siteId: string,
  overlayMounts: Record<string, string>,
  intervalMs?: number,   // default: 300_000 (5 minutes)
): { stop: () => void }
```

Starts a `setInterval` loop that calls `scanOverlayIndex` on the given interval. Returns a handle with a `stop()` method to cancel the loop.

```typescript
const scanner = startOverlayScanLoop(db, siteId, { "/projects/myapp": "/mnt/myapp" });

// Later, when shutting down:
scanner.stop();
```

---

## @bound/llm

The LLM package provides a unified streaming interface over multiple model providers. All drivers implement the same `LLMBackend` interface, and a `ModelRouter` selects the appropriate driver at call time.

### Core Types

**Source:** `packages/llm/src/types.ts`

#### LLMBackend

```typescript
interface LLMBackend {
  chat(params: ChatParams): AsyncIterable<StreamChunk>;
  capabilities(): BackendCapabilities;
}
```

Every driver is an `LLMBackend`. `chat` returns an async iterable so callers can process tokens as they arrive without buffering the entire response.

#### ChatParams

```typescript
interface ChatParams {
  model?: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  system?: string;
  cache_breakpoints?: number[];
  signal?: AbortSignal;
}
```

`model` is optional; if omitted, the driver uses the model from its constructor config. `cache_breakpoints` is an array of message indices at which to insert Anthropic prompt caching markers — ignored by drivers that do not support prompt caching. `signal` is an optional `AbortSignal`; all four drivers accept it and will abort the in-progress stream when it fires.

#### LLMMessage

```typescript
type LLMMessage = {
  role: "user" | "assistant" | "system" | "tool_call" | "tool_result";
  content: string | ContentBlock[];
  tool_use_id?: string;   // set on tool_result messages
  model_id?: string;
  host_origin?: string;
};
```

`tool_call` and `tool_result` are Bound-internal roles that each driver translates into its provider's native representation before sending the request.

#### ContentBlock

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "image"; source: ImageSource; description?: string }
  | { type: "document"; source: ImageSource; text_representation: string; title?: string };
```

#### ImageSource

```typescript
type ImageSource =
  | { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }
  | { type: "file_ref"; file_id: string };
```

`base64` is used for inline images under 1 MB. `file_ref` is used when an image is stored in the `files` table (at or above 1 MB), referencing it by its file ID rather than embedding the data directly. The context assembly pipeline substitutes unsupported blocks when `ContextParams.targetCapabilities` is set: image blocks become `[Image: description]` text annotations for non-vision backends, and document blocks always become their `text_representation` regardless of backend.

#### StreamChunk

All drivers emit the same discriminated union:

```typescript
type StreamChunk =
  | { type: "text";           content: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_args";  id: string; partial_json: string }
  | { type: "tool_use_end";   id: string }
  | { type: "done"; usage: {
      input_tokens: number;
      output_tokens: number;
      cache_write_tokens: number | null;
      cache_read_tokens: number | null;
      estimated: boolean;
    }}
  | { type: "error"; error: string };
```

A complete tool call sequence is: `tool_use_start` -> one or more `tool_use_args` -> `tool_use_end`. The stream always terminates with `done`.

`cache_write_tokens` and `cache_read_tokens` are only populated by the AnthropicDriver and BedrockDriver when prompt caching is active; other drivers set them to `null`. `estimated: true` indicates the values were estimated rather than returned directly by the API.

#### BackendCapabilities

```typescript
interface BackendCapabilities {
  streaming: boolean;
  tool_use: boolean;
  system_prompt: boolean;
  prompt_caching: boolean;
  vision: boolean;
  max_context: number;
}
```

Used by callers to determine which features are available before constructing a request.

#### LLMError

```typescript
class LLMError extends Error {
  constructor(
    message: string,
    public provider: string,
    public statusCode?: number,
    public originalError?: Error,
    public retryAfterMs?: number,
  )
}
```

All drivers throw `LLMError` on connection failures and non-2xx HTTP responses. `retryAfterMs` is populated by `checkHttpError` in `error-utils.ts`, which parses the `Retry-After` header on 429 and 529 responses (converting seconds to milliseconds, defaulting to 60 000 ms if the header is absent or non-numeric). The agent loop passes this value to `modelRouter.markRateLimited()` when retrying with a different backend.

---

### OllamaDriver

**Source:** `packages/llm/src/ollama-driver.ts`

Targets a locally running Ollama instance. Streams responses over NDJSON: the response body is read line-by-line, and each line is parsed as a separate JSON object.

```typescript
const driver = new OllamaDriver({
  baseUrl: "http://localhost:11434",  // default if using createModelRouter
  model: "llama3.2",
  contextWindow: 4096,
});
```

**Protocol details:**
- POST to `<baseUrl>/api/chat` with `stream: true`.
- Each line in the response body is a complete `OllamaStreamResponse` JSON object.
- The final object has `done: true` and carries `prompt_eval_count` / `eval_count` for token usage.
- Tool calls arrive in a single non-streaming chunk on the `message.tool_calls` array; the driver synthesises the `tool_use_start` / `tool_use_args` / `tool_use_end` sequence from them.

**Capabilities:** streaming, tool use, system prompt. No prompt caching or vision.

---

### AnthropicDriver

**Source:** `packages/llm/src/anthropic-driver.ts`

Targets the Anthropic Messages API at `https://api.anthropic.com/v1/messages`. Streams responses over SSE (Server-Sent Events).

```typescript
const driver = new AnthropicDriver({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-4-5",
  contextWindow: 200000,
});
```

**Protocol details:**
- POST to `https://api.anthropic.com/v1/messages` with `stream: true`.
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`.
- Each SSE line prefixed with `data: ` carries an `AnthropicStreamEvent`. Relevant event types:
  - `content_block_start` with `content_block.type === "tool_use"` — emits `tool_use_start`.
  - `content_block_delta` with `delta.type === "text_delta"` — emits `text`.
  - `content_block_delta` with `delta.type === "input_json_delta"` — accumulates partial tool arguments.
  - `content_block_stop` — if a tool was in progress, emits `tool_use_args` with the accumulated JSON, then `tool_use_end`.
  - `message_stop` — emits `done`.

**Prompt caching:** When `cache_breakpoints` is set in `ChatParams`, the driver attaches `cache_control: { type: "ephemeral" }` to the messages at those indices before sending the request. This instructs Anthropic's API to cache the KV state up to those points.

**Capabilities:** streaming, tool use, system prompt, prompt caching, vision.

---

### BedrockDriver

**Source:** `packages/llm/src/bedrock-driver.ts`

Targets the AWS Bedrock Converse Stream API. Uses IAM credentials from the environment (the standard AWS SDK credential chain applies to the underlying HTTP call).

```typescript
const driver = new BedrockDriver({
  region: "us-east-1",
  model: "anthropic.claude-opus-4-5-20251101-v1:0",
  contextWindow: 200000,
});
```

**Protocol details:**
- POST to `https://bedrock-runtime.<region>.amazonaws.com/model/<modelId>/converse-stream`.
- The response body is a stream of JSON event objects. Because Bedrock does not use a line-delimited or SSE framing, the driver uses a brace-counting parser to extract complete JSON objects from the raw byte stream.
- Tool use follows the same `content_block_start` / `content_block_delta` / `content_block_stop` event shape as Anthropic. Tool parameters use `inputSchema.json` rather than `input_schema`.
- Token usage is reported on the `message_stop` event.

**Capabilities:** streaming, tool use, system prompt, vision. No prompt caching.

---

### OpenAICompatibleDriver

**Source:** `packages/llm/src/openai-driver.ts`

Targets any endpoint that speaks the OpenAI Chat Completions API. Suitable for OpenAI itself, Azure OpenAI, vLLM, and other compatible servers.

```typescript
const driver = new OpenAICompatibleDriver({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o",
  contextWindow: 128000,
});
```

**Protocol details:**
- POST to `<baseUrl>/chat/completions` with `stream: true` and `Authorization: Bearer <apiKey>`.
- Streams SSE. The sentinel `data: [DONE]` terminates the stream.
- Tool calls stream incrementally: each chunk may carry a `tool_calls` array with a `function.arguments` fragment. The driver maintains a per-index state map and emits `tool_use_start` on the first chunk for a given tool index, `tool_use_args` for each argument fragment, and `tool_use_end` when the stream finishes (detected via `finish_reason`).

**Capabilities:** streaming, tool use, system prompt. No prompt caching or vision.

---

### ModelRouter

**Source:** `packages/llm/src/model-router.ts`

`ModelRouter` holds a registry of named backends and routes `chat` calls to the right one. It is constructed from a `ModelBackendsConfig` using `createModelRouter`.

#### Configuration

```typescript
interface BackendConfig {
  id: string;
  provider: string;  // "anthropic" | "bedrock" | "openai-compatible" | "ollama"
  model: string;
  baseUrl?: string;
  contextWindow?: number;
  capabilities?: Partial<BackendCapabilities>;  // merges over driver-reported capabilities
  [key: string]: unknown;  // provider-specific fields, e.g. apiKey, region
}

interface ModelBackendsConfig {
  backends: BackendConfig[];
  default: string;  // must match one of the ids in backends
}
```

Provider-specific extra fields:

| Provider | Required extra fields | Optional extra fields |
|---|---|---|
| `anthropic` | `apiKey` | `contextWindow` (default 200 000) |
| `bedrock` | `region` | `contextWindow` (default 200 000) |
| `openai-compatible` | `apiKey` | `baseUrl` (default `http://localhost:8000`), `contextWindow` (default 8 192) |
| `ollama` | — | `baseUrl` (default `http://localhost:11434`), `contextWindow` (default 4 096) |

#### createModelRouter

`createModelRouter(config)` instantiates all configured backends, verifies that the `default` ID exists, and returns a `ModelRouter`. Throws `LLMError` if the default backend ID is not present in the backends list.

```typescript
import { createModelRouter } from "@bound/llm";

const router = createModelRouter({
  backends: [
    {
      id: "primary",
      provider: "anthropic",
      model: "claude-opus-4-5",
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    {
      id: "local",
      provider: "ollama",
      model: "llama3.2",
      baseUrl: "http://localhost:11434",
    },
  ],
  default: "primary",
});
```

#### ModelRouter methods

| Method | Description |
|---|---|
| `getBackend(modelId?)` | Returns the backend registered under `modelId`, or the default backend if `modelId` is omitted. Throws if the ID is not found. |
| `tryGetBackend(modelId)` | Returns the backend registered under `modelId`, or `null` if not found (non-throwing variant). |
| `getDefault()` | Returns the default backend directly. |
| `getDefaultId()` | Returns the default backend ID string. |
| `listBackends()` | Returns `BackendInfo[]` — an array of `{ id, capabilities }` for every registered backend, using effective capabilities (driver baseline merged with config override). |
| `listEligible(requirements?)` | Returns backends that are not currently rate-limited, optionally filtered by `CapabilityRequirements`. Sorted by registration order. |
| `markRateLimited(id, retryAfterMs)` | Marks a backend as rate-limited for `retryAfterMs` milliseconds. The backend is excluded from `listEligible()` until the window expires. |
| `isRateLimited(id)` | Returns `true` if the backend is currently rate-limited. Automatically clears expired entries. |
| `getEarliestCapableRecovery(requirements?)` | Returns the earliest expiry timestamp (ms) among rate-limited backends that satisfy `requirements`, or `null` if none exists. Used by `resolveModel()` to populate `earliestRecovery` on transient-unavailable errors. |
| `getEffectiveCapabilities(id)` | Returns the merged capabilities (driver-reported baseline plus any config `capabilities` override) for the given backend ID, or `null` if not found. |

#### Streaming a response

```typescript
const backend = router.getDefault();

const stream = backend.chat({
  model: "claude-opus-4-5",
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Explain monads in one paragraph." }],
  max_tokens: 512,
});

for await (const chunk of stream) {
  switch (chunk.type) {
    case "text":
      process.stdout.write(chunk.content);
      break;
    case "tool_use_start":
      console.log(`Tool call started: ${chunk.name} (${chunk.id})`);
      break;
    case "tool_use_args":
      // Accumulate chunk.partial_json for the tool with chunk.id
      break;
    case "tool_use_end":
      console.log(`Tool call complete: ${chunk.id}`);
      break;
    case "done":
      console.log(`\nTokens used — in: ${chunk.usage.input_tokens}, out: ${chunk.usage.output_tokens}`);
      break;
    case "error":
      console.error(`Stream error: ${chunk.error}`);
      break;
  }
}
```

To use a non-default backend by ID:

```typescript
const localBackend = router.getBackend("local");
```

To inspect available backends and their capabilities before selecting one:

```typescript
for (const { id, capabilities } of router.listBackends()) {
  console.log(id, capabilities);
}
```
