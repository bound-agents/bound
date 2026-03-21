# Bound System Architecture - Phase 4: Agent Loop & Scheduler

**Goal:** Complete agent loop processes a message end-to-end (user message in → assistant response out, with tool execution). Scheduler fires cron, deferred, and event-driven tasks. Task DAGs resolve dependencies correctly.

**Architecture:** `@bound/agent` package containing the agent loop state machine (IDLE → HYDRATE_FS → ASSEMBLE_CONTEXT → LLM_CALL → PARSE_RESPONSE → TOOL_EXECUTE/RESPONSE_PERSIST → FS_PERSIST → QUEUE_CHECK), context assembly pipeline, all defineCommand implementations (14 core + 4 MCP access commands), MCP Bridge client for connecting to external MCP servers, scheduler loop with eviction/schedule/sync/run phases, task DAG resolution, quiescence enforcement, and spending ceiling checks (spending ceiling is a stub until metrics tables are created in Phase 8).

**Tech Stack:** @bound/core (DB, DI), @bound/sandbox (ClusterFs, defineCommand, exec), @bound/llm (LLMBackend, streaming), bun:sqlite (task queries, transactions)

**Scope:** 8 phases from original design (phase 4 of 8)

**Codebase verified:** 2026-03-22 — Phases 1-3 plans provide all required foundations: types, DB, DI, sandbox factory, defineCommand framework, LLM interface, model router.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### system-arch.AC3: Phased build order produces working vertical slices
- **system-arch.AC3.3 Success:** Phase 4 completes with a full agent loop processing a message end-to-end (user message in -> assistant response out, with tool execution)

### system-arch.AC4: Testing strategy covers all packages with multi-instance sync validation
- **system-arch.AC4.1 Success:** Every package has unit tests that run via `bun test`

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: @bound/agent package setup

**Files:**
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/agent/src/index.ts`
- Modify: `tsconfig.json` (root) — add agent to references

**Step 1: Create package.json**

```json
{
  "name": "@bound/agent",
  "version": "0.0.1",
  "description": "Agent loop state machine, context assembly pipeline, defineCommand implementations, scheduler, and task DAG resolution for the Bound agent system",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@bound/shared": "workspace:*",
    "@bound/core": "workspace:*",
    "@bound/sandbox": "workspace:*",
    "@bound/llm": "workspace:*"
  }
}
```

**Step 2: Create tsconfig.json with references to shared, core, sandbox, llm**

**Step 3: Update root tsconfig.json references**

**Step 4: Verify**

Run: `bun install`
Expected: Installs without errors

**Step 5: Commit**

```bash
git add packages/agent/ tsconfig.json bun.lockb
git commit -m "chore(agent): initialize @bound/agent package"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Agent loop state machine

**Verifies:** system-arch.AC3.3

**Files:**
- Create: `packages/agent/src/agent-loop.ts`
- Create: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/index.ts` — add exports

**Implementation:**

`packages/agent/src/types.ts` — Agent loop types:
```typescript
export type AgentLoopState =
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

export interface AgentLoopConfig {
  threadId: string;
  taskId?: string;
  userId: string;
  modelId?: string;
  abortSignal?: AbortSignal;
}

export interface AgentLoopResult {
  messagesCreated: number;
  toolCallsMade: number;
  filesChanged: number;
  error?: string;
}
```

`packages/agent/src/agent-loop.ts` — The core loop per spec §4.5:

- `AgentLoop` class:
  ```typescript
  class AgentLoop {
    private state: AgentLoopState = "IDLE";

    constructor(
      private ctx: AppContext,
      private sandbox: Bash,
      private llmBackend: LLMBackend,
      private config: AgentLoopConfig,
    ) {}

    async run(): Promise<AgentLoopResult> { ... }
    cancel(): void { ... }
  }
  ```

  The `run()` method implements the state machine:
  1. **HYDRATE_FS:** Call `hydrateWorkspace()` from `@bound/sandbox` to load files into ClusterFs. Save pre-execution snapshot.
  2. **ASSEMBLE_CONTEXT:** Call context assembly pipeline (Task 3) to build LLM prompt.
  3. **LLM_CALL:** Call `llmBackend.chat()` with assembled context. Stream response. Implement 120s silence timeout (no streaming tokens for 120s → ERROR_PERSIST). Any chunk resets the timer.
  4. **PARSE_RESPONSE:** Accumulate StreamChunks. If tool_use detected → TOOL_EXECUTE. If text-only → RESPONSE_PERSIST.
  5. **TOOL_EXECUTE:** Execute tool command via `sandbox.exec()`. Capture stdout/stderr/exitCode. Non-zero exit does NOT terminate the loop — error feeds back to LLM.
  6. **TOOL_PERSIST:** Persist both tool_call and tool_result messages to DB immediately (spec R-E3). Uses `insertRow` from `@bound/core` with change_log.
  7. **RESPONSE_PERSIST:** Persist assistant message with model_id, host_origin, timestamp.
  8. **FS_PERSIST:** Call `persistWorkspaceChanges()` from `@bound/sandbox` for OCC diff.
  9. **QUEUE_CHECK:** Query for messages persisted during this loop but not yet in context. If found → loop back to ASSEMBLE_CONTEXT. If empty → return result.
  10. **ERROR_PERSIST:** Log error, persist alert message, attempt FS_PERSIST, return result with error.

  Tool execution loop: after TOOL_PERSIST, return to ASSEMBLE_CONTEXT for the next LLM turn (include tool result in context).

  Cancel: sets abort signal, interrupts current state, persists cancellation system message, runs FS_PERSIST, returns to IDLE.

**Testing:**
- system-arch.AC3.3: Create an AgentLoop with a mock LLMBackend that returns a text response. Run it with a test thread. Verify: user message persisted, assistant response persisted, loop returns to IDLE.
- Tool execution: mock LLMBackend returns a tool_use. Mock sandbox exec returns stdout. Verify: tool_call and tool_result messages persisted, LLM called again with tool result.
- Error handling: mock LLMBackend throws. Verify: error message persisted as alert, FS_PERSIST attempted.
- Cancel: start a loop, cancel during LLM_CALL. Verify: cancellation message persisted.

Test file: `packages/agent/src/__tests__/agent-loop.test.ts` (integration — mock LLM, real SQLite)

**Verification:**
Run: `bun test packages/agent/`
Expected: All tests pass

**Commit:** `feat(agent): add agent loop state machine`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Context assembly pipeline

**Verifies:** system-arch.AC3.3 (assembled context enables LLM responses)

**Files:**
- Create: `packages/agent/src/context-assembly.ts`
- Modify: `packages/agent/src/index.ts` — add exports

**Implementation:**

`packages/agent/src/context-assembly.ts` — Implements the 8-stage pipeline from spec §13.1:

- `assembleContext(params: ContextParams): LLMMessage[]` where `ContextParams` includes threadId, taskId, userId, currentModel, noHistory flag.

Stages:
1. **MESSAGE_RETRIEVAL:** Query messages by thread_id ordered by created_at. If task.no_history → skip.
2. **PURGE_SUBSTITUTION:** Find role='purge' messages, replace targeted IDs with summaries.
3. **TOOL_PAIR_SANITIZATION:** Ensure tool_call/tool_result pairs are correctly interleaved per spec §9.3. Inject synthetic tool_result for orphans. Relocate interleaved non-tool messages.
4. **MESSAGE_QUEUEING:** Exclude non-tool messages persisted during active tool-use.
5. **ANNOTATION:** Add model, host, timestamp annotations per message. Add reliability prefix to summaries from lower-tier models.
6. **ASSEMBLY:** Compose in order: system prompt → persona (if exists) → stable orientation (schema, commands, tools, tiers) → processed history → volatile context (user, timezone, budget, topology, digest, task header).
7. **BUDGET_VALIDATION:** Count tokens (approximate). If over context_window: truncate history from front, trigger summarization flag. For tasks: reduce dependency detail first.
8. **METRIC_RECORDING:** (Deferred — metrics.db not yet created. Record tokens_in to logger for now.)

Return the assembled message array ready for `LLMBackend.chat()`.

For Phase 4, implement a simplified system prompt and orientation block. Full prompt engineering is iterative and will be refined. The key is the pipeline structure.

**Testing:**
- Assemble context for a thread with user + assistant messages. Verify order, message count.
- Purge substitution: add a purge message targeting specific IDs. Verify targeted messages replaced with summary.
- Tool pair sanitization: add orphaned tool_call without tool_result. Verify synthetic result injected.
- No-history mode: assemble with no_history=true. Verify only system prompt + volatile context, no thread history.

Test file: `packages/agent/src/__tests__/context-assembly.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/agent/`
Expected: All tests pass

**Commit:** `feat(agent): add context assembly pipeline`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->
<!-- START_TASK_4 -->
### Task 4: defineCommand implementations — read and write commands

**Verifies:** system-arch.AC3.3 (tools available during agent loop)

**Files:**
- Create: `packages/agent/src/commands/query.ts`
- Create: `packages/agent/src/commands/memorize.ts`
- Create: `packages/agent/src/commands/forget.ts`
- Create: `packages/agent/src/commands/schedule.ts`
- Create: `packages/agent/src/commands/await-cmd.ts`
- Create: `packages/agent/src/commands/cancel.ts`
- Create: `packages/agent/src/commands/emit.ts`
- Create: `packages/agent/src/commands/purge.ts`
- Create: `packages/agent/src/commands/index.ts`
- Modify: `packages/agent/src/index.ts` — add exports

**Implementation:**

Each command file exports a `CommandDefinition` (from `@bound/sandbox`) implementing the handler per spec §6.1-6.2:

**Read commands:**
- `query` — Execute read-only SQL against the agent database. Validate query is SELECT-only. Return formatted results as stdout. Spec §6.1.
- `hostinfo` — Return host information from hosts table (read-only). Spec §6.1.

**Write commands:**
- `memorize` — Insert or update semantic_memory entry. Args: `--key` (required), `--value` (required). Uses `insertRow`/`updateRow` with deterministic UUID from key. Spec §6.2.
- `forget` — Soft-delete semantic_memory entry by key. Uses `softDelete`. Spec §6.2.
- `schedule` — Create a new task. Args: `--in` (deferred), `--every` (cron), `--on` (event-driven), `--payload`, `--requires`, `--model-hint`, `--no-history`, `--after` (depends_on), `--require-success`, `--quiet`, `--inject`. Creates task row with appropriate type and trigger_spec. Returns task ID as stdout. Spec §6.2.
- `await` — Block until specified task IDs reach terminal state. Args: task IDs (positional). Polls tasks table. Returns results JSON as stdout. Implements buffering to file if total > 50KB. Spec §6.2. The AWAIT_POLL sub-state of the agent loop handles the actual polling.
- `cancel` — Set task status to 'cancelled'. Args: `--task-id` (required). Spec §6.2.
- `emit` — Emit a custom event via the EventBus. Args: `--event` (required), `--payload` (JSON). Spec §6.2.
- `purge` — Create a purge message that replaces targeted tool interactions with a summary. Args: `--last N` or `--ids`. Spec §6.2.

**`packages/agent/src/commands/index.ts`** — Aggregates all command definitions into a single array and exports `getAllCommands(): CommandDefinition[]`.

**Testing:**
- `query`: execute SELECT on a seeded database, verify correct rows returned
- `memorize`: create a memory entry, verify it exists in semantic_memory table with change_log
- `forget`: create then forget a memory, verify soft-delete
- `schedule`: create a deferred task, verify task row created with correct fields
- `emit`: emit an event, verify EventBus listener receives it
- `purge`: create a purge message, verify it references the right target IDs

Test file: `packages/agent/src/__tests__/commands.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/agent/`
Expected: All tests pass

**Commit:** `feat(agent): add defineCommand implementations for all read/write commands`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: defineCommand implementations — cache and runtime commands

**Files:**
- Create: `packages/agent/src/commands/cache-warm.ts`
- Create: `packages/agent/src/commands/cache-pin.ts`
- Create: `packages/agent/src/commands/cache-unpin.ts`
- Create: `packages/agent/src/commands/cache-evict.ts`
- Create: `packages/agent/src/commands/model-hint.ts`
- Create: `packages/agent/src/commands/archive.ts`
- Modify: `packages/agent/src/commands/index.ts` — add to command list

**Implementation:**

**Cache commands (spec §6.4):**
- `cache-warm` — Fetch remote files via proxy channel and write to local files table cache. Args: glob patterns of paths to warm. For Phase 4: implement as a stub that logs "cache-warm requires remote host connectivity" since MCP proxy is not yet implemented.
- `cache-pin` — Mark files as pinned (never LRU-evicted). Stores pin flag in files table metadata.
- `cache-unpin` — Remove pin flag.
- `cache-evict` — Manually evict cached overlay files the agent no longer needs. Soft-delete files matching the pattern from the cache.

**Runtime commands (spec §6.4):**
- `model-hint` — Request a model switch for the next LLM call. Args: `--model` (model ID or tier). Stores the hint for the agent loop to read. `--reset` clears the hint.
- `archive` — Archive a thread (set deleted=1) or archive threads with no messages in N days. Args: `--thread-id` or `--older-than Nd`.

**Testing:**
- `cache-pin`: pin a file, verify it survives LRU eviction
- `model-hint`: set a hint, verify it's readable by the agent loop
- `archive`: archive a thread, verify it's soft-deleted

Test file: `packages/agent/src/__tests__/cache-commands.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/agent/`
Expected: All tests pass

**Commit:** `feat(agent): add cache and runtime defineCommand implementations`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-8) -->
<!-- START_TASK_6 -->
### Task 6: Scheduler loop

**Verifies:** system-arch.AC3.3 (scheduler fires tasks)

**Files:**
- Create: `packages/agent/src/scheduler.ts`
- Create: `packages/agent/src/task-resolution.ts`
- Modify: `packages/agent/src/index.ts` — add exports

**Implementation:**

`packages/agent/src/task-resolution.ts` — Task eligibility and DAG resolution:

- `isDependencySatisfied(db: Database, task: Task): boolean` — Check if all task IDs in `depends_on` have reached terminal state. If `require_success` and any dependency is non-completed → auto-fail.
- `canRunHere(db: Database, task: Task, hostName: string, siteId: string): boolean` — Check scheduling predicates: dependency satisfaction + node affinity (requires field matched against hosts table).
- `seedCronTasks(db: Database, cronConfig: CronSchedule[], siteId: string): void` — Seed cron tasks from `config/cron_schedules.json` with deterministic UUIDs. Idempotent via INSERT ON CONFLICT DO NOTHING.
- `computeNextRunAt(cronExpr: string, from: Date): Date` — Parse cron expression, compute next fire time. Use a simple cron parser (implement or use a lightweight library).

`packages/agent/src/scheduler.ts` — Scheduler loop per spec §10.3:

- `Scheduler` class:
  ```typescript
  class Scheduler {
    constructor(
      private ctx: AppContext,
      private agentLoopFactory: (config: AgentLoopConfig) => AgentLoop,
    ) {}

    start(pollInterval: number): { stop: () => void };
  }
  ```

  Each tick runs 4 phases:
  1. **Phase 0 — Eviction:** (a) Expire stale claimed tasks (claimed_at > LEASE_DURATION). (b) Evict crashed running tasks on reachable hosts (heartbeat_at > EVICTION_TIMEOUT and host reachable). (c) Spawn independent runs for missed recurring intervals.
  2. **Phase 1 — Schedule:** Query pending time-based tasks where next_run_at has passed. For each that canRunHere → claim (set claimed_by, claimed_at).
  3. **Phase 2 — Sync:** Trigger sync cycle if sync is enabled (exchanges claims with other hosts; LWW on claimed_at resolves contention).
  4. **Phase 3 — Run:** For each task claimed by this host: generate lease_id, set running + heartbeat_at, spawn agent loop. On completion: verify lease_id, write result, update run_count, compute next_run_at for cron tasks.

  Event handler: register on EventBus for all event types. On event: query pending event tasks matching trigger_spec. Re-entrancy guard prevents self-triggering. Event depth check (max 5).

  Heartbeat: update heartbeat_at every 30s for running tasks.

  Quiescence: reduce polling frequency based on time since last user interaction (spec §9.7). Scale from POLL_INTERVAL to 5×POLL_INTERVAL over 1 hour of inactivity. Tasks with no_quiescence=1 always run at normal frequency.

  Spending ceiling (STUB): The spending ceiling check requires metrics tables (turns, daily_summary) which are created in Phase 8. For Phase 4, implement the spending ceiling as a stub that always returns "within budget." The actual check will be wired in Phase 8 when metrics tables exist. This is intentional — the scheduler infrastructure is complete, only the cost data source is deferred.

**Testing:**
- Seed cron tasks, verify they appear in tasks table with deterministic UUIDs
- Schedule a deferred task for "now", verify it gets claimed and run
- Task DAG: create T1, T2 depending on T1. Complete T1. Verify T2 becomes eligible.
- Event-driven: emit an event, verify matching event task fires
- Quiescence: simulate 2 hours of inactivity, verify poll interval increases
- Eviction: create a claimed task with old claimed_at, verify it returns to pending

Test file: `packages/agent/src/__tests__/scheduler.test.ts` (integration — real SQLite, mock agent loop)
Test file: `packages/agent/src/__tests__/task-resolution.test.ts` (unit)

**Verification:**
Run: `bun test packages/agent/`
Expected: All tests pass

**Commit:** `feat(agent): add scheduler loop with eviction, DAG resolution, and quiescence`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: End-to-end agent loop integration test

**Verifies:** system-arch.AC3.3

**Files:**
- Create: `packages/agent/src/__tests__/integration.test.ts`

**Implementation:**

Full vertical slice test proving the agent loop works end-to-end:

1. Create temp database with schema, seed a user and thread
2. Create config files (allowlist.json, model_backends.json) in temp dir
3. Bootstrap AppContext via DI container
4. Create ClusterFs with workspace hydrated from DB
5. Register all defineCommands
6. Create sandbox via factory
7. Create a mock LLMBackend that:
   - On first call: returns a tool_use for `memorize --key test --value hello`
   - On second call (with tool_result): returns text "Memory saved!"
8. Create and run AgentLoop
9. Verify:
   - User message exists in DB
   - tool_call message exists in DB
   - tool_result message exists in DB
   - Assistant "Memory saved!" message exists in DB
   - semantic_memory table has entry with key="test", value="hello"
   - change_log has entries for all writes
   - Loop returned to IDLE with correct result counts

This single test proves system-arch.AC3.3: "a full agent loop processing a message end-to-end."

**Verification:**
Run: `bun test packages/agent/src/__tests__/integration.test.ts`
Expected: Test passes

**Commit:** `test(agent): add end-to-end agent loop integration test`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Scheduler integration test

**Files:**
- Create: `packages/agent/src/__tests__/scheduler.integration.test.ts`

**Implementation:**

Integration test proving the scheduler fires tasks correctly:

1. Create temp database with schema
2. Bootstrap AppContext
3. Create a mock agent loop factory that records when loops are spawned
4. Seed a deferred task with `next_run_at` in the past
5. Create and start Scheduler
6. Wait for one poll tick
7. Verify: the deferred task was claimed, run, and completed
8. Verify: the mock agent loop was called with the correct task config

Additional scenarios:
- Cron task: seed a cron task, verify it fires and next_run_at advances
- Event-driven: register an event task for "test.event", emit the event, verify task fires
- DAG: create T1 and T2 (depends_on T1). Complete T1 via mock. Verify T2 fires on next tick.

**Verification:**
Run: `bun test packages/agent/src/__tests__/scheduler.integration.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add scheduler integration tests`
<!-- END_TASK_8 -->
<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (tasks 9-10) -->
<!-- START_TASK_9 -->
### Task 9: MCP Bridge client and defineCommand auto-generation

**Verifies:** system-arch.AC3.3 (external tool integration)

**Files:**
- Create: `packages/agent/src/mcp-bridge.ts`
- Create: `packages/agent/src/mcp-client.ts`
- Modify: `packages/agent/src/commands/index.ts` — add MCP access commands
- Modify: `packages/agent/src/index.ts` — add exports

**Implementation:**

`packages/agent/src/mcp-client.ts` — MCP server connection lifecycle per spec §7.2:

- `MCPClient` class managing connections to MCP servers defined in `config/mcp.json`:
  - `connect(serverConfig: MCPServerConfig): Promise<void>` — Connect via stdio (spawn process) or SSE transport
  - `disconnect(): Promise<void>` — Graceful shutdown
  - `listTools(): Promise<ToolDefinition[]>` — Discover available tools from the server
  - `listResources(): Promise<ResourceDefinition[]>` — Discover available resources
  - `listPrompts(): Promise<PromptDefinition[]>` — Discover available prompts
  - `callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>` — Execute a tool
  - `readResource(uri: string): Promise<ResourceContent>` — Read a resource
  - `invokePrompt(name: string, args: Record<string, string>): Promise<PromptResult>` — Invoke a prompt

- `MCPServerConfig` type: `{ name: string; command?: string; args?: string[]; url?: string; transport: "stdio" | "sse"; allow_tools?: string[]; confirm?: string[] }`

`packages/agent/src/mcp-bridge.ts` — Auto-generation of defineCommands from MCP tools:

- `generateMCPCommands(clients: Map<string, MCPClient>, confirmGates: Map<string, string[]>): CommandDefinition[]` — For each connected MCP server:
  1. Call `listTools()` to discover available tools
  2. Apply `allow_tools` filter if configured (only register listed tools)
  3. Generate a `CommandDefinition` for each tool, named `{server-name}-{tool-name}` per spec §7.3
  4. The command handler calls `client.callTool()` and returns stdout/stderr/exitCode
  5. For tools in `confirm` list: during interactive sessions, the handler returns a confirmation prompt. During autonomous tasks, confirmed tools are blocked.

- MCP access defineCommands (spec §6.1):
  - `resources` — List all resources across all MCP servers or from a specific server
  - `resource` — Read a specific resource by URI
  - `prompts` — List all prompts across all MCP servers
  - `prompt` — Invoke a prompt with arguments

- `updateHostMCPInfo(db: Database, siteId: string, clients: Map<string, MCPClient>): void` — Update `hosts.mcp_servers` and `hosts.mcp_tools` with the connected server names and tool names.

**Testing:**
- Mock MCP server that returns tools/resources/prompts, verify defineCommands generated correctly
- allow_tools filter: configure allow_tools for a server, verify only listed tools registered
- confirm gate: call a confirmed tool in autonomous mode, verify it's blocked
- MCP access commands: list resources, read a resource, verify correct output

Test file: `packages/agent/src/__tests__/mcp-bridge.test.ts` (unit — mock MCP server)

**Verification:**
Run: `bun test packages/agent/`
Expected: All tests pass

**Commit:** `feat(agent): add MCP Bridge client with defineCommand auto-generation`
<!-- END_TASK_9 -->

<!-- START_TASK_10 -->
### Task 10: Persona support in context assembly

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` — add persona injection

**Implementation:**

Update the context assembly pipeline (Task 3) to inject `config/persona.md` into the stable orientation:

In Stage 6 (ASSEMBLY), after the system prompt and before the stable orientation:
1. Check if `config/persona.md` exists in the config directory
2. If it exists, read its content
3. Inject as a system message in the stable orientation section (cached)

The persona file is loaded once at startup and cached. It does not change during the process lifetime.

**Testing:**
- Assembly with persona: create a persona.md in temp config dir, assemble context, verify persona content appears in the stable section
- Assembly without persona: no persona.md, verify context assembly still works

Test file: Update `packages/agent/src/__tests__/context-assembly.test.ts`

**Verification:**
Run: `bun test packages/agent/`
Expected: All tests pass

**Commit:** `feat(agent): add persona.md injection in context assembly`
<!-- END_TASK_10 -->
<!-- END_SUBCOMPONENT_D -->
