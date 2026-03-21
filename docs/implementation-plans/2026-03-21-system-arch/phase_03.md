# Bound System Architecture - Phase 3: Sandbox & LLM

**Goal:** Execute commands in a sandboxed environment with persistent filesystem and stream responses from an LLM backend. ClusterFs provides unified filesystem routing; the Ollama driver enables local model interaction.

**Architecture:** Two packages — `@bound/sandbox` wraps just-bash with ClusterFs (MountableFs routing `/home/user/` to InMemoryFs and `/mnt/` to OverlayFs), defineCommand registration, and OCC filesystem persistence. `@bound/llm` implements the `LLMBackend` interface with an Ollama driver that streams NDJSON responses and translates tool_use to the common format.

**Tech Stack:** just-bash 2.13+ (InMemoryFs, MountableFs, defineCommand, exec), Ollama REST API (/api/chat with streaming NDJSON), bun:sqlite (OCC transactions)

**Scope:** 8 phases from original design (phase 3 of 8)

**Codebase verified:** 2026-03-22 — Phase 1 plan provides files table, config loader, DI container. Phase 2 provides no direct dependencies for this phase. This phase depends only on Phase 1.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### system-arch.AC2: Technology stack is confirmed with specific libraries
- **system-arch.AC2.4 Success:** just-bash sandbox executes defineCommands, returns stdout/stderr/exitCode, and persists filesystem changes

### system-arch.AC4: Testing strategy covers all packages with multi-instance sync validation
- **system-arch.AC4.1 Success:** Every package has unit tests that run via `bun test`
- **system-arch.AC4.7 Success:** Tests that depend on external services (real LLM, real Discord) are skippable via environment flag without breaking the test suite

---

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->
<!-- START_TASK_1 -->
### Task 1: @bound/sandbox package setup

**Files:**
- Create: `packages/sandbox/package.json`
- Create: `packages/sandbox/tsconfig.json`
- Create: `packages/sandbox/src/index.ts`
- Modify: `tsconfig.json` (root) — add sandbox to references

**Step 1: Create package.json**

```json
{
  "name": "@bound/sandbox",
  "version": "0.0.1",
  "description": "just-bash wrapper with ClusterFs, defineCommand registration, and OCC filesystem persistence for the Bound agent sandbox",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@bound/shared": "workspace:*",
    "@bound/core": "workspace:*",
    "just-bash": "^2.14.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../shared" },
    { "path": "../core" }
  ]
}
```

**Step 3: Update root tsconfig.json**

Add `{ "path": "packages/sandbox" }` to root references.

**Step 4: Verify operationally**

Run: `bun install`
Expected: Installs without errors, just-bash resolved.

**Step 5: Commit**

```bash
git add packages/sandbox/ tsconfig.json bun.lockb
git commit -m "chore(sandbox): initialize @bound/sandbox package"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: ClusterFs implementation

**Verifies:** system-arch.AC2.4 (filesystem component)

**Files:**
- Create: `packages/sandbox/src/cluster-fs.ts`
- Modify: `packages/sandbox/src/index.ts` — add exports

**Implementation:**

`packages/sandbox/src/cluster-fs.ts` — Custom filesystem using just-bash's `MountableFs` to route paths:

The ClusterFs unifies three filesystem domains per spec §4.3:
- `/home/user/` → InMemoryFs (agent's read-write workspace, hydrated from `files` table)
- `/mnt/{this-host}/` → OverlayFs (read-only local overlay, auto-caches reads to DB)
- `/mnt/{other-host}/` → InMemoryFs (served from cached copies in `files` table)

```typescript
import { Bash, InMemoryFs } from "just-bash";
import { OverlayFs } from "just-bash/fs/overlay-fs";
import { MountableFs } from "just-bash";

interface ClusterFsConfig {
  hostName: string;
  overlayMounts?: Record<string, string>; // real path → mount path from overlay.json
  syncEnabled: boolean;
}
```

Functions to implement:

- `createClusterFs(config: ClusterFsConfig): MountableFs` — Constructs the MountableFs with appropriate mounts:
  1. Base: InMemoryFs for `/home/user/`
  2. For each entry in `overlayMounts`: create an OverlayFs at `/mnt/{hostName}/{path}`
  3. For remote hosts: InMemoryFs instances populated from cached `files` table entries

- `hydrateWorkspace(fs: MountableFs, db: Database): void` — Load all files from `files` table where `path LIKE '/home/user/%' AND deleted = 0` into the InMemoryFs. Save content hashes as the pre-execution snapshot for OCC.

- `hydrateRemoteCache(fs: MountableFs, db: Database, hostName: string): void` — Load cached remote files from `files` table where `path LIKE '/mnt/{hostName}/%' AND deleted = 0` into the corresponding InMemoryFs.

- `snapshotWorkspace(fs: MountableFs): Map<string, string>` — Extract current content hashes from the `/home/user/` filesystem for OCC diffing.

- `diffWorkspace(before: Map<string, string>, after: Map<string, string>): FileChange[]` — Compare pre-execution and post-execution snapshots. Returns list of changes: `{ path: string; operation: "created" | "modified" | "deleted"; content?: string; sizeBytes?: number }`.

**Testing:**
- system-arch.AC2.4 (filesystem): Create a ClusterFs, write a file to `/home/user/test.txt`, read it back. Verify `/mnt/` paths are read-only. Hydrate from a test database, verify files appear in the virtual filesystem. Diff a workspace before and after modifications.

Test file: `packages/sandbox/src/__tests__/cluster-fs.test.ts` (integration — real just-bash + real SQLite)

**Verification:**
Run: `bun test packages/sandbox/`
Expected: All tests pass

**Commit:** `feat(sandbox): add ClusterFs with MountableFs path routing`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Filesystem persist lifecycle with OCC

**Verifies:** system-arch.AC2.4 (persists filesystem changes)

**Files:**
- Create: `packages/sandbox/src/fs-persist.ts`
- Modify: `packages/sandbox/src/index.ts` — add exports

**Implementation:**

`packages/sandbox/src/fs-persist.ts` — OCC-based filesystem persistence per spec §4.2:

- `persistWorkspaceChanges(db: Database, siteId: string, preSnapshot: Map<string, string>, postSnapshot: Map<string, string>, eventBus: TypedEventEmitter): Result<PersistResult, PersistError>` — The full persist lifecycle:
  1. Compute diff between pre and post snapshots
  2. If no changes → return early with `{ changes: 0 }`
  3. `BEGIN IMMEDIATE` transaction (acquires WAL write lock)
  4. For each changed file:
     - Read current DB state for that path
     - Compare DB state against pre-snapshot (OCC check)
     - If DB differs from pre-snapshot → CONFLICT → resolve via LWW timestamp, log warning
     - If DB matches pre-snapshot → CLEAN UPDATE
  5. Write changes via `insertRow`/`updateRow`/`softDelete` from `@bound/core` (transactional outbox produces change_log entries)
  6. `COMMIT`
  7. Emit `file:changed` events for each modification
  8. Return `{ changes: number; conflicts: number }`

- `PersistResult` type: `{ changes: number; conflicts: number; conflictPaths: string[] }`
- `PersistError` type: extends Error with `{ failedPaths: string[] }`

Size budget enforcement:
- Per-file limit: reject files > 1MB (configurable)
- Aggregate limit: reject if total `/home/user/` size exceeds 50MB (configurable)
- Return error with clear message identifying which files exceeded limits

**Testing:**
- Persist changes from a sandbox session, verify files appear in the database with change_log entries
- OCC conflict: modify a file in the DB between snapshot and persist, verify LWW resolution occurs and conflict is logged
- Size limit: attempt to persist a file > 1MB, verify rejection with clear error

Test file: `packages/sandbox/src/__tests__/fs-persist.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/sandbox/`
Expected: All tests pass

**Commit:** `feat(sandbox): add OCC filesystem persist lifecycle`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: defineCommand registration framework and sandbox factory

**Verifies:** system-arch.AC2.4 (executes defineCommands, returns stdout/stderr/exitCode)

**Files:**
- Create: `packages/sandbox/src/commands.ts`
- Create: `packages/sandbox/src/sandbox-factory.ts`
- Modify: `packages/sandbox/src/index.ts` — add exports

**Implementation:**

`packages/sandbox/src/commands.ts` — defineCommand registration framework:

- `CommandDefinition` interface:
  ```typescript
  interface CommandDefinition {
    name: string;
    args: Array<{ name: string; required: boolean; description?: string }>;
    handler: (args: Record<string, string>, ctx: CommandContext) => Promise<CommandResult>;
  }
  ```

- `CommandContext` type: `{ db: Database; siteId: string; eventBus: TypedEventEmitter; logger: Logger; threadId?: string; taskId?: string }`

- `CommandResult` type: `{ stdout: string; stderr: string; exitCode: number }`

- `createDefineCommands(definitions: CommandDefinition[]): ReturnType<typeof defineCommand>[]` — Translates `CommandDefinition` array into just-bash `defineCommand` instances. Each command: parses args from the bash argv array, validates required args, calls the handler, returns `{ stdout, stderr, exitCode }`.

Note: The actual command implementations (query, memorize, schedule, etc.) are Phase 4 work. This task creates the FRAMEWORK for registering them.

`packages/sandbox/src/sandbox-factory.ts` — Factory for creating configured Bash instances:

- `createSandbox(config: SandboxConfig): Promise<Bash>` where `SandboxConfig` includes:
  - `clusterFs: MountableFs` — the hydrated ClusterFs
  - `commands: ReturnType<typeof defineCommand>[]` — registered defineCommands
  - `networkConfig?: NetworkConfig` — URL allowlists and transforms from `network.json`
  - `executionLimits?: ExecutionLimits` — configurable limits (defaults from spec: maxCallDepth=50, maxCommandCount=10000, maxLoopIterations=10000)

The factory creates a `new Bash({ fs: clusterFs, customCommands: commands, executionLimits, network })` and returns it ready for `exec()`.

**Testing:**
- system-arch.AC2.4: Register a test defineCommand, exec it in the sandbox, verify stdout/stderr/exitCode are returned correctly.
- Register a command that accesses the database (via CommandContext), verify it works through the sandbox.
- Pipes work: `testcmd | grep pattern` filters output correctly.
- Network lockdown: curl to non-allowlisted URL fails, curl to allowlisted URL succeeds.
- Execution limits: infinite loop hits maxLoopIterations.

Test file: `packages/sandbox/src/__tests__/commands.test.ts` (integration — real just-bash)
Test file: `packages/sandbox/src/__tests__/sandbox-factory.test.ts` (integration)

**Verification:**
Run: `bun test packages/sandbox/`
Expected: All tests pass

**Commit:** `feat(sandbox): add defineCommand framework and sandbox factory`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 5-8) -->
<!-- START_TASK_5 -->
### Task 5: @bound/llm package setup and LLMBackend interface

**Files:**
- Create: `packages/llm/package.json`
- Create: `packages/llm/tsconfig.json`
- Create: `packages/llm/src/index.ts`
- Create: `packages/llm/src/types.ts`
- Modify: `tsconfig.json` (root) — add llm to references

**Step 1: Create package.json**

```json
{
  "name": "@bound/llm",
  "version": "0.0.1",
  "description": "LLM backend drivers, model router, and streaming response parser for the Bound agent system",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@bound/shared": "workspace:*"
  }
}
```

**Step 2: Create tsconfig.json and update root references**

Same pattern as other packages, referencing `../shared`.

**Step 3: Create types**

`packages/llm/src/types.ts` — LLM interface contract from spec §4.6:

```typescript
export interface LLMBackend {
  chat(params: ChatParams): AsyncIterable<StreamChunk>;
  capabilities(): BackendCapabilities;
}

export interface ChatParams {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  system?: string;
  cache_breakpoints?: number[];
}

export type LLMMessage = {
  role: "user" | "assistant" | "system" | "tool_call" | "tool_result";
  content: string | ContentBlock[];
  tool_use_id?: string;
  model_id?: string;
  host_origin?: string;
};

export type StreamChunk =
  | { type: "text"; content: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_args"; id: string; partial_json: string }
  | { type: "tool_use_end"; id: string }
  | { type: "done"; usage: { input_tokens: number; output_tokens: number } }
  | { type: "error"; error: string };

export interface BackendCapabilities {
  streaming: boolean;
  tool_use: boolean;
  system_prompt: boolean;
  prompt_caching: boolean;
  vision: boolean;
  max_context: number;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
```

**Step 4: Verify operationally**

Run: `bun install && bun run tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/llm/ tsconfig.json bun.lockb
git commit -m "feat(llm): add LLMBackend interface and stream chunk types"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Ollama driver

**Verifies:** (foundation for system-arch.AC3.3 — enables end-to-end agent loop in Phase 4)

**Files:**
- Create: `packages/llm/src/ollama-driver.ts`
- Modify: `packages/llm/src/index.ts` — add exports

**Implementation:**

`packages/llm/src/ollama-driver.ts` — Ollama LLMBackend implementation:

The Ollama driver connects to a local Ollama server via the `/api/chat` REST endpoint. It translates between the common message format and Ollama's native format (which mirrors OpenAI's).

Key implementation details:

- `OllamaDriver` class implementing `LLMBackend`:
  - Constructor takes `{ baseUrl: string; model: string; contextWindow: number }`
  - `chat()` method: POST to `${baseUrl}/api/chat` with `stream: true`, translate messages from common format to Ollama format (role mapping: tool_call → assistant with tool_calls array, tool_result → tool with tool_name), parse streaming NDJSON response
  - `capabilities()` returns `{ streaming: true, tool_use: true, system_prompt: true, prompt_caching: false, vision: false, max_context: contextWindow }`

- Message translation functions:
  - `toOllamaMessages(messages: LLMMessage[]): OllamaMessage[]` — Converts common format to Ollama format. Key translations: `role: "tool_call"` → `role: "assistant"` with `tool_calls` array, `role: "tool_result"` → `role: "tool"` with `tool_name`.
  - `parseOllamaStream(response: Response): AsyncIterable<StreamChunk>` — Reads NDJSON chunks from the response body. For each chunk: if `message.content` is non-empty → yield `{ type: "text", content }`. If `message.tool_calls` present → yield `tool_use_start`, `tool_use_args` (full JSON), `tool_use_end` for each. When `done: true` → yield `{ type: "done", usage: { input_tokens: prompt_eval_count, output_tokens: eval_count } }`.

- Error handling per spec §4.6:
  - Connection refused → throw typed `LLMError` with provider name
  - Non-200 response → throw with status and body
  - Streaming interruption → throw with last received chunk info

**Testing:**
- Message translation: verify common format → Ollama format round-trip for user, assistant, tool_call, tool_result messages
- Stream parsing: mock a ReadableStream of NDJSON chunks, parse them, verify correct StreamChunk sequence
- Error cases: mock connection refused, 500 response

Note: Tests with a real Ollama server should be skippable via `SKIP_OLLAMA=1` env var (AC4.7).

Test file: `packages/llm/src/__tests__/ollama-driver.test.ts` (unit — mock HTTP)

**Verification:**
Run: `bun test packages/llm/`
Expected: All tests pass (Ollama server not required)

**Commit:** `feat(llm): add Ollama driver with streaming NDJSON parser`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Model router

**Verifies:** (foundation for multi-model support)

**Files:**
- Create: `packages/llm/src/model-router.ts`
- Modify: `packages/llm/src/index.ts` — add exports

**Implementation:**

`packages/llm/src/model-router.ts` — Selects and manages LLM backends:

- `ModelRouter` class:
  ```typescript
  class ModelRouter {
    constructor(private backends: Map<string, LLMBackend>, private defaultId: string) {}

    getBackend(modelId?: string): Result<LLMBackend, Error>;
    getDefault(): LLMBackend;
    listBackends(): Array<{ id: string; capabilities: BackendCapabilities }>;
  }
  ```

- `createModelRouter(config: ModelBackendsConfig): ModelRouter` — Factory that:
  1. Iterates over `config.backends`
  2. Creates the appropriate driver based on `provider` field (Phase 3 only has Ollama; other drivers added in Phase 8)
  3. Registers each backend by its `id`
  4. Sets the default from `config.default`

- `createBackendFromConfig(backend: BackendConfig): LLMBackend` — Factory function that creates the correct driver based on `provider` field. For now only handles `"ollama"`. Other providers throw `"Provider not yet implemented"`.

**Testing:**
- Create router with multiple backends, resolve by ID, verify correct backend returned
- Default backend used when no ID specified
- Unknown backend ID returns error Result
- Unsupported provider throws clear error

Test file: `packages/llm/src/__tests__/model-router.test.ts` (unit)

**Verification:**
Run: `bun test packages/llm/`
Expected: All tests pass

**Commit:** `feat(llm): add model router for backend selection`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: @bound/sandbox and @bound/llm integration tests

**Verifies:** system-arch.AC2.4, system-arch.AC4.1, system-arch.AC4.7

**Files:**
- Create: `packages/sandbox/src/__tests__/integration.test.ts`
- Create: `packages/llm/src/__tests__/integration.test.ts`

**Implementation:**

`packages/sandbox/src/__tests__/integration.test.ts` — Full sandbox lifecycle:
1. Create a temp database with schema and seed a few files
2. Create ClusterFs, hydrate from database
3. Register a test defineCommand (e.g., `echo-args` that returns its arguments)
4. Create sandbox via factory
5. Execute commands: write a file, read it, use defineCommand, pipe output
6. Diff workspace, persist via OCC
7. Verify: files in database match sandbox state, change_log entries exist
8. This test proves the full hydrate → exec → diff → persist lifecycle from AC2.4

`packages/llm/src/__tests__/integration.test.ts` — Optional real Ollama test:
- Skip entire file if `SKIP_OLLAMA=1` or Ollama server unreachable
- Send a simple chat message, verify streaming response
- Test tool_use with a simple function definition
- This verifies AC4.7 (skippable external service tests)

**Verification:**
Run: `bun test --recursive`
Expected: All tests pass (Ollama tests skipped if server unavailable)

**Commit:** `test(sandbox,llm): add integration tests for sandbox lifecycle and LLM streaming`
<!-- END_TASK_8 -->
<!-- END_SUBCOMPONENT_B -->
