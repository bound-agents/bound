# Test Requirements -- Native Agent Tools

Maps each acceptance criterion from `docs/design-plans/2026-04-30-native-tools.md` to specific tests with classification, file paths, and verification descriptions.

---

## AC1: Unified tool registry dispatches all tool kinds

### native-tools.AC1.1

**Criterion:** Platform tool call resolves to correct handler and returns string result.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Register a platform tool with `kind: "platform"` and an execute handler that returns a known string. Invoke `executeToolCall` with the platform tool's name. Assert the result contains the expected string content and `exitCode: 0`.

---

### native-tools.AC1.2

**Criterion:** Client tool call returns `ClientToolCallRequest` sentinel without executing.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Register a client tool with `kind: "client"` and no execute handler. Invoke `executeToolCall` with the client tool's name and arbitrary input `{ foo: "bar" }`. Assert the return value satisfies `ClientToolCallRequest` shape: `clientToolCall === true`, `toolName` matches the registered name, `callId` matches the tool call id, and `arguments` matches the input. Confirm that no execute function was called (the tool has no execute handler).

---

### native-tools.AC1.3

**Criterion:** Built-in file tool call (read/write/edit/retrieve_task) dispatches and returns `string | ContentBlock[]`.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Create an `InMemoryFs` instance from `just-bash`, write a file to it. Register built-in file tools via `createBuiltInTools(fs)` into the registry as `kind: "builtin"`. Invoke `executeToolCall` with tool name `"read"` and input `{ path: "/test-file.txt" }`. Assert the result content contains the file contents and `exitCode: 0`. Verify the return type accommodates both `string` and `ContentBlock[]` (the read tool returns a string; an image read would return ContentBlock[]).

---

### native-tools.AC1.4

**Criterion:** Built-in agent tool call (e.g., schedule, memory) dispatches and returns result.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Create a `ToolContext` with a real temp SQLite DB (schema applied). Register all 14 native agent tools via `createAgentTools(ctx)`. Invoke `executeToolCall` with tool name `"hostinfo"` (the simplest no-param tool). Assert the result contains a string (the host report or "No hosts registered.") and `exitCode: 0`. This verifies built-in agent tools dispatch through the unified registry.

**Note:** Individual tool behavior is covered by per-tool tests (AC2 and AC3). This test only verifies the registry dispatch path.

---

### native-tools.AC1.5

**Criterion:** Sandbox (bash) tool call delegates to `sandbox.exec()` and returns output.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Register the sandbox tool with `kind: "sandbox"`. Provide a mock `sandbox.exec` function that returns `{ stdout: "hello", stderr: "", exitCode: 0 }`. Invoke `executeToolCall` with tool name `"bash"` and input `{ command: "echo hello" }`. Assert the mock was called with `"echo hello"` and the result content contains `"hello"` with `exitCode: 0`.

---

### native-tools.AC1.6

**Criterion:** Unknown tool name returns error message with exit code 1.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Create a tool registry with at least one registered tool. Invoke `executeToolCall` with an unregistered tool name `"nonexistent"`. Assert the return value is `{ content: 'Error: unknown tool "nonexistent"', exitCode: 1 }`.

---

### native-tools.AC1.7

**Criterion:** Duplicate tool name at registration time logs warning and keeps first registration.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Provide two tools with the same name but different execute handlers to `createToolRegistry()`. Use a tracking logger (e.g., array-backed `warn` function) to capture warnings. Assert: (1) the logger's `warn` was called with a message containing the duplicate tool name, (2) only one entry exists in the registry for that name, (3) invoking the tool calls the first handler (not the second). Verify by having the first handler return `"first"` and the second return `"second"`, then asserting the result contains `"first"`.

---

## AC2: Standalone agent tools accept structured params

### native-tools.AC2.1

**Criterion:** `schedule` tool accepts `cron` as a single string field (e.g., `"0,30 * * * *"`) without word-splitting.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/tools/__tests__/schedule.test.ts` |

**What to verify:** Create a `ToolContext` with a real temp SQLite DB (schema applied, minimal thread/user seeded). Call the schedule tool's execute handler with `{ task_description: "test task", cron: "0,30 * * * *" }`. Assert: (1) the call succeeds (no error), (2) a row exists in the `tasks` table, (3) the stored `trigger_spec` JSON contains `expression: "0,30 * * * *"` as a single intact string (the comma and spaces were not word-split). This is the key structural bug fix -- cron expressions with commas and spaces no longer break.

---

### native-tools.AC2.2

**Criterion:** `query` tool accepts `sql` as a single string field containing `=` characters without misparsing.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/tools/__tests__/query.test.ts` |

**What to verify:** Create a `ToolContext` with a real temp SQLite DB (schema applied). Seed the `hosts` table with a known row (e.g., `site_id = 'abc'`). Call the query tool's execute handler with `{ sql: "SELECT * FROM hosts WHERE site_id = 'abc'" }`. Assert: (1) the call succeeds, (2) the result contains the seeded host data in TSV format. The `=` character in the SQL is preserved as part of the single `sql` string -- no `key=value` flag misparsing.

---

### native-tools.AC2.3

**Criterion:** `cancel` tool accepts `task_id` and cancels the specified task.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/tools/__tests__/cancel.test.ts` |

**What to verify:** Create a `ToolContext` with a real temp SQLite DB. Insert a task row with `status: "pending"` via `insertRow()`. Call the cancel tool's execute handler with `{ task_id: "<the-task-id>" }`. Assert: (1) the call succeeds, (2) querying the task row shows `status: "cancelled"`.

---

### native-tools.AC2.4

**Criterion:** `emit` tool accepts `event` and `payload` as separate structured fields.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/tools/__tests__/emit.test.ts` |

**What to verify:** Create a `ToolContext` with a real temp SQLite DB and a tracking eventBus (record emitted events). Call the emit tool's execute handler with `{ event: "test:fired", payload: '{"key": "value"}' }`. Assert: (1) the call succeeds with a result like `"Event emitted: test:fired"`, (2) the eventBus recorded an emission of event `"test:fired"` with parsed payload `{ key: "value" }`. The `event` and `payload` arrive as separate structured fields -- no positional argument confusion.

---

### native-tools.AC2.5

**Criterion:** All 11 standalone tools produce equivalent output to the bash command versions for identical inputs.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | Multiple (one per tool, see table below) |

This criterion is covered by the union of per-tool happy-path tests. Each tool's test file verifies that the native tool produces functionally equivalent results to the old command handler for the same inputs.

| Tool | Test file | Key verification |
|---|---|---|
| `schedule` | `packages/agent/src/tools/__tests__/schedule.test.ts` | Task row created with correct trigger_spec |
| `cancel` | `packages/agent/src/tools/__tests__/cancel.test.ts` | Task status set to cancelled |
| `query` | `packages/agent/src/tools/__tests__/query.test.ts` | TSV output with headers, LIMIT 1000 auto-appended |
| `emit` | `packages/agent/src/tools/__tests__/emit.test.ts` | Event emitted on eventBus |
| `await_event` | `packages/agent/src/tools/__tests__/await-event.test.ts` | Returns completed task status JSON |
| `purge` | `packages/agent/src/tools/__tests__/purge.test.ts` | Purge message created with correct target IDs |
| `advisory` | `packages/agent/src/tools/__tests__/advisory.test.ts` | Advisory row created, list returns it |
| `notify` | `packages/agent/src/tools/__tests__/notify.test.ts` | Notification enqueued for target thread |
| `archive` | `packages/agent/src/tools/__tests__/archive.test.ts` | Thread soft-deleted |
| `model_hint` | `packages/agent/src/tools/__tests__/model-hint.test.ts` | Task model_hint column updated |
| `hostinfo` | `packages/agent/src/tools/__tests__/hostinfo.test.ts` | Formatted host report returned |

---

### native-tools.AC2.6

**Criterion:** `schedule` tool rejects cron expression with fewer than 5 fields.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/tools/__tests__/schedule.test.ts` |

**What to verify:** Call the schedule tool's execute handler with `{ task_description: "test", cron: "0 * *" }` (only 3 fields). Assert the result is an error string (starts with `"Error:"`) describing the invalid cron format. No task row should be created in the database.

---

### native-tools.AC2.7

**Criterion:** Missing required params return descriptive error, not crash.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | Multiple (one per tool) |

This criterion is verified across all 11 standalone tool test files. Each must include at least one test for missing required parameters.

| Tool | Test file | Missing-param scenario |
|---|---|---|
| `schedule` | `packages/agent/src/tools/__tests__/schedule.test.ts` | No trigger (no `cron`, `delay`, or `on_event`) -- returns error |
| `cancel` | `packages/agent/src/tools/__tests__/cancel.test.ts` | Neither `task_id` nor `payload_match` -- returns error |
| `query` | `packages/agent/src/tools/__tests__/query.test.ts` | Empty/missing `sql` -- returns error |
| `emit` | `packages/agent/src/tools/__tests__/emit.test.ts` | Missing `event` -- returns error |
| `await_event` | `packages/agent/src/tools/__tests__/await-event.test.ts` | Empty `task_ids` -- returns error |
| `purge` | `packages/agent/src/tools/__tests__/purge.test.ts` | Neither `message_ids` nor `last_n` -- returns error |
| `advisory` | `packages/agent/src/tools/__tests__/advisory.test.ts` | `title` without `detail` -- returns error |
| `notify` | `packages/agent/src/tools/__tests__/notify.test.ts` | Missing `platform` -- returns error |
| `archive` | `packages/agent/src/tools/__tests__/archive.test.ts` | Neither `thread_id` nor `older_than` -- returns error |
| `model_hint` | `packages/agent/src/tools/__tests__/model-hint.test.ts` | No `ctx.taskId` in context -- returns error |
| `hostinfo` | `packages/agent/src/tools/__tests__/hostinfo.test.ts` | N/A (no required params); verify graceful output on empty DB |

In every case, the assert is: the execute handler returns an error string (not throws), the error message is descriptive (contains the missing parameter name or guidance), and no database mutation occurs.

---

## AC3: Grouped agent tools dispatch by action

### native-tools.AC3.1

**Criterion:** `memory` tool with `action: "store"` persists a memory entry via outbox.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/tools/__tests__/memory.test.ts` |

**What to verify:** Create a `ToolContext` with a real temp SQLite DB (schema applied). Call the memory tool's execute handler with `{ action: "store", key: "test_key", value: "test_value" }`. Assert: (1) the call succeeds, (2) a row exists in `semantic_memory` where `key = 'test_key'` and `content = 'test_value'`, (3) a corresponding row exists in `change_log` (proving the outbox path was used, not a raw INSERT).

---

### native-tools.AC3.2

**Criterion:** `memory` tool with `action: "search"` returns matching memories.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/tools/__tests__/memory.test.ts` |

**What to verify:** Seed the `semantic_memory` table with a few entries (e.g., keys `"project_goals"`, `"project_timeline"`, `"unrelated_data"`). Call the memory tool with `{ action: "search", key: "project" }`. Assert the result string contains `"project_goals"` and `"project_timeline"` but not `"unrelated_data"`. The search uses keyword tokenization and LIKE matching.

---

### native-tools.AC3.3

**Criterion:** `cache` tool with each of 4 actions (warm, pin, unpin, evict) produces correct behavior.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/tools/__tests__/cache.test.ts` |

**What to verify (4 sub-tests):**

- **warm:** Call with `{ action: "warm" }`. Assert the result is an informational message (no error). No database mutation required (existing stub behavior).
- **pin:** Seed the `files` table with a file at path `/src/main.ts`. Call with `{ action: "pin", path: "/src/main.ts" }`. Assert `cluster_config` contains a `pinned_files` entry that includes `/src/main.ts`.
- **unpin:** After pinning, call with `{ action: "unpin", path: "/src/main.ts" }`. Assert `pinned_files` no longer contains `/src/main.ts`.
- **evict:** Seed the `files` table with files matching a pattern (e.g., `/tmp/cache-1.dat`, `/tmp/cache-2.dat`). Call with `{ action: "evict", pattern: "/tmp/cache-*" }`. Assert both files are soft-deleted (`deleted = 1`).

---

### native-tools.AC3.4

**Criterion:** `skill` tool with each of 4 actions (activate, list, read, retire) produces correct behavior.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/tools/__tests__/skill.test.ts` |

**What to verify (4 sub-tests):**

- **activate:** Create an `InMemoryFs` from `just-bash`. Write a valid `SKILL.md` file at `/home/user/skills/test-skill/SKILL.md` containing frontmatter with `description` and a body. Set `ctx.fs` to the InMemoryFs. Call with `{ action: "activate", name: "test-skill" }`. Assert a row exists in the `skills` table with `name = 'test-skill'` and `status = 'active'`.
- **list:** After activation, call with `{ action: "list" }`. Assert the result contains `"test-skill"` in a formatted table.
- **read:** Call with `{ action: "read", name: "test-skill" }`. Assert the result contains skill metadata and the SKILL.md content.
- **retire:** Call with `{ action: "retire", name: "test-skill" }`. Assert the `skills` row now has `status = 'retired'`.

---

### native-tools.AC3.5

**Criterion:** Invalid action value returns descriptive error listing valid actions.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | Multiple (one per grouped tool) |

| Tool | Test file | Invalid action input | Expected error content |
|---|---|---|---|
| `memory` | `packages/agent/src/tools/__tests__/memory.test.ts` | `{ action: "invalid" }` | Lists valid actions: store, forget, search, connect, disconnect, traverse, neighbors |
| `cache` | `packages/agent/src/tools/__tests__/cache.test.ts` | `{ action: "unknown" }` | Lists valid actions: warm, pin, unpin, evict |
| `skill` | `packages/agent/src/tools/__tests__/skill.test.ts` | `{ action: "garbage" }` | Lists valid actions: activate, list, read, retire |

---

### native-tools.AC3.6

**Criterion:** Missing action-specific required params return descriptive error.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | Multiple (one per grouped tool) |

| Tool | Test file | Scenario | Expected error |
|---|---|---|---|
| `memory` | `packages/agent/src/tools/__tests__/memory.test.ts` | `{ action: "store" }` (missing `key` and `value`) | Error naming `key` as required |
| `memory` | `packages/agent/src/tools/__tests__/memory.test.ts` | `{ action: "connect" }` (missing `source_key`, `target_key`, `relation`) | Error naming required params |
| `cache` | `packages/agent/src/tools/__tests__/cache.test.ts` | `{ action: "pin" }` (missing `path`) | Error naming `path` as required |
| `skill` | `packages/agent/src/tools/__tests__/skill.test.ts` | `{ action: "activate" }` (missing `name`) | Error naming `name` as required |
| `skill` | `packages/agent/src/tools/__tests__/skill.test.ts` | `{ action: "activate", name: "test" }` (missing `ctx.fs`) | Error about filesystem unavailable |

---

## AC4: Old command dispatch path is fully removed

### native-tools.AC4.1

**Criterion:** No `CommandDefinition` handler files exist in `packages/agent/src/commands/` (except MCP bridge, registry, index).

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit (static assertion) |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** A test that lists all `.ts` files in `packages/agent/src/commands/` (using `fs.readdirSync` or a glob) and asserts the remaining files are only: `index.ts`, `registry.ts`, and optionally `helpers.ts` (if still referenced by other code). No command handler files (advisory.ts, archive.ts, await-cmd.ts, cache-*.ts, cancel.ts, emit.ts, hostinfo.ts, memory.ts, model-hint.ts, notify.ts, purge.ts, query.ts, schedule.ts, skill-*.ts) should exist.

---

### native-tools.AC4.2

**Criterion:** `createDefineCommands()` is only called with MCP bridge commands (built-in command definitions no longer pass through it).

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit (static assertion + integration) |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Two-part verification:

1. **Static:** Grep `packages/cli/src/commands/start/sandbox.ts` for calls to `getAllCommands()`. Assert zero matches -- the function is no longer imported or called.
2. **Behavioral:** Confirm the MCP bridge path still works. The existing `packages/agent/src/__tests__/mcp-bridge.test.ts` tests cover this. After Phase 4, run the MCP bridge tests and assert they pass (proving MCP commands still flow through `createDefineCommands()`).

---

### native-tools.AC4.3

**Criterion:** `sandboxTool` description no longer lists built-in commands.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Import the `sandboxTool` constant from `agent-factory.ts` (or read the tool registry's `"bash"` entry). Assert the `toolDefinition.function.description` string does NOT contain any of: `"query"`, `"memorize"`, `"schedule"`, `"cancel"`, `"purge"`, `"cache-warm"`, `"cache-pin"`, `"model-hint"`, `"hostinfo"`. Assert it DOES contain `"MCP"` (to verify MCP tools are still mentioned).

---

### native-tools.AC4.4

**Criterion:** MCP bridge commands still dispatch correctly through bash.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/mcp-bridge.test.ts` (existing) |

**What to verify:** The existing MCP bridge test suite passes without modification after Phase 4. This suite tests that MCP bridge `CommandDefinition` objects generate correctly, dispatch via the bash sandbox, handle `--help` flags, and propagate errors. No new test needed -- existing coverage is sufficient.

---

## AC5: System prompt reflects native tool architecture

### native-tools.AC5.1

**Criterion:** Orientation contains "### Additional MCP Commands" section with only MCP bridge entries.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |

**What to verify:** Set the command registry (via `setCommandRegistry()`) to contain one MCP bridge command (e.g., `{ name: "github", description: "GitHub MCP tools" }`). Run `assembleContext()` with minimal params. Assert the resulting `systemPrompt` string: (1) contains `"### Additional MCP Commands"`, (2) contains `"github"` in that section, (3) contains `"These are MCP server commands dispatched through the bash tool"`.

---

### native-tools.AC5.2

**Criterion:** No "### Available Commands" section exists in the generated system prompt.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |

**What to verify:** Two sub-tests:

1. **Empty registry:** Set the command registry to empty (`setCommandRegistry([])`). Run `assembleContext()`. Assert the `systemPrompt` does NOT contain `"### Available Commands"`. Assert it does NOT contain `"### Additional MCP Commands"` either (the section is conditional).
2. **With MCP commands:** Set the registry with one MCP command. Run `assembleContext()`. Assert the `systemPrompt` does NOT contain `"### Available Commands"` (only `"### Additional MCP Commands"` should appear).

---

### native-tools.AC5.3

**Criterion:** MCP bridge commands support `--help` via `formatHelp()`.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/mcp-bridge.test.ts` (existing) |

**What to verify:** The existing MCP bridge test suite includes tests that invoke MCP bridge commands with `--help` and verify `formatHelp()` output. Confirm these tests still pass after Phase 5. If no explicit `--help` test exists in `mcp-bridge.test.ts`, add one: register an MCP bridge command via `createDefineCommands()`, invoke it with `"github --help"` through the sandbox, assert the output contains the command description and parameter documentation.

---

### native-tools.AC5.4

**Criterion:** Native tools are discoverable through `ToolDefinition` schemas in the API `tools` parameter.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify:** Create a tool registry with all 14 native agent tools registered (via `createAgentTools(ctx)`). Call `getMergedTools()` (or the equivalent method that produces the LLM tool list). Assert the returned array contains 14 entries whose `function.name` values match the expected set: `schedule`, `cancel`, `query`, `emit`, `await_event`, `purge`, `advisory`, `notify`, `archive`, `model_hint`, `hostinfo`, `memory`, `cache`, `skill`. Each entry must have `function.parameters` defined (the JSON schema). This proves native tools are discoverable by the LLM through its `tools` parameter.

---

## AC6: Relay inference carries native tools

### native-tools.AC6.1

**Criterion:** `InferenceRequestPayload.tools` includes all 14 native tool definitions when forwarding to remote host.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/shared/src/__tests__/relay-schemas.test.ts` |

**What to verify:** Construct a representative `ToolDefinition` for a native tool (e.g., the `schedule` tool with its full parameter schema including nested `properties`, `required`, and `type` fields). Serialize it through `inferenceRequestPayloadSchema.parse()` as part of the `tools` array:

```typescript
const payload = {
    model: "opus",
    messages: [{ role: "user", content: "hello" }],
    tools: [scheduleToolDef],
};
const parsed = inferenceRequestPayloadSchema.parse(payload);
```

Assert: (1) parse succeeds, (2) `parsed.tools` has length 1, (3) `parsed.tools[0]` preserves `function.name`, `function.description`, and `function.parameters` including all nested schema properties. This proves that native tool definitions round-trip through the relay serialization layer without data loss.

Additionally test with all 14 tool definitions at once to verify the array serializes correctly at full size.

---

### native-tools.AC6.2

**Criterion:** Remote host dispatches relayed native tool calls through unified registry.

| Field | Value |
|---|---|
| Verification | Automated + Human |
| Test type | Integration |
| Test file | `packages/agent/src/__tests__/tool-registry.test.ts` |

**What to verify (automated):** Verify that `createAgentLoopFactory` (the factory used on both spoke and hub) creates an `AgentLoop` with a populated `toolRegistry`. This can be tested by: (1) calling `createAgentLoopFactory()` with minimal config, (2) creating a loop from the factory, (3) asserting the loop's config includes a `toolRegistry` with the expected native tool entries. This proves that any host (spoke or hub) running the agent loop will have the unified registry for dispatching native tool calls -- whether the call originates locally or arrives via relay.

**Why partial human verification:** Full end-to-end relay dispatch (spoke sends request, hub receives it, dispatches a native tool call, returns result via relay_inbox) depends on network, sync protocol, and two running instances. The automated test verifies the necessary condition (both sides have the registry), but exercising the full relay round-trip requires either the existing `hub-spoke-e2e.integration.test.ts` infrastructure or a live multi-node deployment. See the Human Verification section below.

---

## AC7: Documentation is accurate

### native-tools.AC7.1

**Criterion:** CLAUDE.md references native tools, not bash commands, for agent tool dispatch.

| Field | Value |
|---|---|
| Verification | Human |

**Why not automated:** Documentation accuracy requires human judgment to assess whether the wording correctly conveys the architecture, not just whether specific keywords are present.

**Verification approach:** Read the "Tool dispatch priority" and "MCP subcommand dispatch" sections of CLAUDE.md. Confirm: (1) "Tool dispatch priority" describes the unified `RegisteredTool` registry with the four kind discriminants (`platform`, `client`, `builtin`, `sandbox`), (2) the old waterfall description (`platform -> client -> builtin -> bash`) is gone, (3) MCP subcommand dispatch is explicitly scoped as "the only commands still dispatched through the bash sandbox", (4) the orientation reference mentions `"### Additional MCP Commands"` not `"### Available Commands"`.

**Supplementary automated check:** Grep CLAUDE.md for `"Platform tools .* client tools .* built-in tools .* sandbox/MCP"` (the old waterfall phrasing). Assert zero matches.

---

### native-tools.AC7.2

**Criterion:** CONTRIBUTING.md "Adding an agent tool" checklist describes the `RegisteredTool` factory pattern.

| Field | Value |
|---|---|
| Verification | Human |

**Why not automated:** The checklist must be evaluated for correctness, completeness, and clarity of the instructions -- not just keyword presence.

**Verification approach:** Read the "Adding an agent tool" section of CONTRIBUTING.md. Confirm it includes: (1) create a factory function `create<Name>Tool(ctx: ToolContext): RegisteredTool` in `packages/agent/src/tools/`, (2) define a `ToolDefinition` with JSON schema parameters, (3) implement the `execute` handler, (4) register in `createAgentTools()` array, (5) add tests in `packages/agent/src/tools/__tests__/`, (6) mention grouped tool pattern with `action` enum for related operations. Confirm the old "Adding an agent command" heading and `CommandDefinition` references are gone.

**Supplementary automated check:** Grep CONTRIBUTING.md for `"Adding an agent command"`. Assert zero matches. Grep for `"Adding an agent tool"`. Assert one match.

---

### native-tools.AC7.3

**Criterion:** No documentation references the old `CommandDefinition` dispatch pattern (except historical design docs).

| Field | Value |
|---|---|
| Verification | Automated + Human |
| Test type | Static grep |
| Test file | N/A (run as a verification script) |

**What to verify (automated):** Run:

```bash
grep -rn "CommandDefinition\|getAllCommands\|Available Commands\|20+ built-in\|20 commands\|bash-dispatched command" \
  CLAUDE.md CONTRIBUTING.md README.md docs/design/*.md \
  | grep -v "MCP\|bridge\|historical\|Note:\|only\|design-plans/\|implementation-plans/\|design/specs/"
```

Assert zero matches. Any remaining unqualified reference to the old command dispatch in active documentation (excluding historical specs and implementation plans) is a documentation bug.

**Why partial human verification:** The grep catches obvious stale references, but a human must also verify that the framing in `docs/design/agent-system.md`, `docs/design/sandbox-and-llm.md`, and `docs/design/architecture.md` accurately describes the new architecture in context, not just that old keywords were removed. In particular: (1) `agent-system.md` should have a "Native Agent Tools" section describing the `RegisteredTool` pattern, (2) `sandbox-and-llm.md` Command Framework section should note `CommandDefinition` is MCP-only, (3) `architecture.md` should mention native tools before describing MCP subcommand dispatch.

---

## Human Verification

| AC | Why Not Fully Automated | Verification Approach |
|----|------------------------|----------------------|
| native-tools.AC6.2 | Full relay round-trip (spoke -> hub -> native tool dispatch -> result return) requires two running nodes and network sync. The automated test verifies both sides create the unified registry, but the multi-hop dispatch depends on the sync protocol, relay_outbox/relay_inbox, and WebSocket transport. | Deploy a two-node cluster (spoke + hub). Send a message that triggers a native tool call (e.g., `schedule`). Verify via the spoke's `messages` table that the tool result was returned from the hub. Alternatively, extend `hub-spoke-e2e.integration.test.ts` to include a native tool call scenario if the test infrastructure supports it. |
| native-tools.AC7.1 | Documentation accuracy requires human judgment -- keywords can be present but the wording may be misleading or incomplete. | Read CLAUDE.md sections manually. Supplementary grep can catch obvious stale references. |
| native-tools.AC7.2 | Checklist must be evaluated for correctness and completeness, not just keyword presence. | Read CONTRIBUTING.md section manually. Supplementary grep can verify the old heading is gone. |
| native-tools.AC7.3 | Grep catches stale keywords but cannot assess whether replacement text accurately describes the architecture. | Run the automated grep. Then manually read the three updated design docs (`agent-system.md`, `sandbox-and-llm.md`, `architecture.md`) to verify the new sections are accurate. |

---

## Test File Summary

All new test files created by this implementation:

| Test file | AC coverage | Phase |
|---|---|---|
| `packages/agent/src/__tests__/tool-registry.test.ts` | AC1.1-AC1.7, AC1.4, AC4.1-AC4.3, AC5.4 | 1, 2, 4, 5 |
| `packages/agent/src/tools/__tests__/schedule.test.ts` | AC2.1, AC2.5, AC2.6, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/query.test.ts` | AC2.2, AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/cancel.test.ts` | AC2.3, AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/emit.test.ts` | AC2.4, AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/await-event.test.ts` | AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/purge.test.ts` | AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/advisory.test.ts` | AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/notify.test.ts` | AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/archive.test.ts` | AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/model-hint.test.ts` | AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/hostinfo.test.ts` | AC2.5, AC2.7 | 2 |
| `packages/agent/src/tools/__tests__/index.test.ts` | AC1.4 (count verification) | 2, 3 |
| `packages/agent/src/tools/__tests__/memory.test.ts` | AC3.1, AC3.2, AC3.5, AC3.6 | 3 |
| `packages/agent/src/tools/__tests__/cache.test.ts` | AC3.3, AC3.5, AC3.6 | 3 |
| `packages/agent/src/tools/__tests__/skill.test.ts` | AC3.4, AC3.5, AC3.6 | 3 |
| `packages/agent/src/__tests__/context-assembly.test.ts` | AC5.1, AC5.2 (modifications to existing file) | 5 |
| `packages/shared/src/__tests__/relay-schemas.test.ts` | AC6.1 (additions to existing file) | 5 |

### Existing test files providing coverage

| Test file | AC coverage | Notes |
|---|---|---|
| `packages/agent/src/__tests__/mcp-bridge.test.ts` | AC4.4, AC5.3 | Existing tests verify MCP bridge dispatch and --help |

### Test files deleted during Phase 4

| Test file | Replaced by |
|---|---|
| `packages/agent/src/__tests__/commands.test.ts` | Per-tool tests in `packages/agent/src/tools/__tests__/` |
| `packages/agent/src/__tests__/cache-commands.test.ts` | `packages/agent/src/tools/__tests__/cache.test.ts` |
| `packages/agent/src/__tests__/skill-commands.test.ts` | `packages/agent/src/tools/__tests__/skill.test.ts` |
