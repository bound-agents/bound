# Native Agent Tools Design

## Summary

This design promotes all 20 built-in agent commands from bash-dispatched shell strings to 14 native LLM tools with structured JSON schemas. Currently, the agent loop passes command invocations through a bash sandbox where arguments are parsed from space-delimited strings, creating a persistent class of bugs where special characters (cron expressions with spaces, SQL containing `=`, JSON payloads) are misparsed or word-split. The new architecture treats agent commands as first-class LLM tools alongside existing platform tools (e.g., `discord_send_message`), file tools (read/write/edit), and client tools. Each tool receives structured JSON parameters directly from the LLM, eliminating all string-parsing ambiguity.

The design introduces a unified tool registry (`Map<string, RegisteredTool>`) that replaces the current waterfall dispatch pattern (platform -> client -> builtin -> bash). Every tool is tagged with a `kind` discriminant (`"platform"`, `"client"`, `"builtin"`, `"sandbox"`) that controls execution behavior. The 14 native tools are registered as `kind: "builtin"` with execute handlers that receive type-safe JSON input. Three tool families (memory, cache, skill) use an `action` parameter to group related operations; eleven standalone tools map directly to existing commands (schedule, query, cancel, etc.). The old `CommandDefinition` dispatch infrastructure, `createDefineCommands()` wrapper, and orientation command-listing section are fully removed. MCP bridge commands remain bash-dispatched to avoid scope creep on their dynamic subcommand pattern. The relay inference path carries the new tools naturally through the existing `InferenceRequestPayload.tools` field with no relay-specific changes required.

## Definition of Done

Promote all 20 built-in agent commands (currently dispatched as bash strings through the sandbox shell) to 14 native LLM tools with structured JSON schemas, eliminating the entire class of argument-parsing bugs (e.g., cron expression word-splitting) and providing a consistent tool interface for agents across local and relay inference paths. MCP bridge commands remain unchanged. The bash command versions, their dispatch wiring, and orientation text listings are fully removed. Documentation is updated to reflect the new architecture.

**Deliverables:**
- 14 native LLM tool definitions with flat params (action params for grouped families: memory, cache, skill)
- Bash command dispatch path removed (CommandDefinitions, createDefineCommands wiring, orientation command listings)
- Tool dispatch integrated into the agent loop's existing tool dispatch path
- System prompt / orientation updated (commands self-describe via tool schemas, no text listing needed)
- Documentation updated (CLAUDE.md, CONTRIBUTING.md, design docs)
- Relay inference path carries new tools naturally (no special relay changes)
- Cron-string-splitting class of bugs structurally eliminated
- MCP bridge commands unchanged

## Acceptance Criteria

### native-tools.AC1: Unified tool registry dispatches all tool kinds
- **native-tools.AC1.1 Success:** Platform tool call resolves to correct handler and returns string result
- **native-tools.AC1.2 Success:** Client tool call returns `ClientToolCallRequest` sentinel without executing
- **native-tools.AC1.3 Success:** Built-in file tool call (read/write/edit/retrieve_task) dispatches and returns `string | ContentBlock[]`
- **native-tools.AC1.4 Success:** Built-in agent tool call (e.g., schedule, memory) dispatches and returns result
- **native-tools.AC1.5 Success:** Sandbox (bash) tool call delegates to `sandbox.exec()` and returns output
- **native-tools.AC1.6 Failure:** Unknown tool name returns error message with exit code 1
- **native-tools.AC1.7 Edge:** Duplicate tool name at registration time logs warning and keeps first registration

### native-tools.AC2: Standalone agent tools accept structured params
- **native-tools.AC2.1 Success:** `schedule` tool accepts `cron` as a single string field (e.g., `"0,30 * * * *"`) without word-splitting
- **native-tools.AC2.2 Success:** `query` tool accepts `sql` as a single string field containing `=` characters without misparsing
- **native-tools.AC2.3 Success:** `cancel` tool accepts `task_id` and cancels the specified task
- **native-tools.AC2.4 Success:** `emit` tool accepts `event` and `payload` as separate structured fields
- **native-tools.AC2.5 Success:** All 11 standalone tools produce equivalent output to the bash command versions for identical inputs
- **native-tools.AC2.6 Failure:** `schedule` tool rejects cron expression with fewer than 5 fields
- **native-tools.AC2.7 Failure:** Missing required params return descriptive error, not crash

### native-tools.AC3: Grouped agent tools dispatch by action
- **native-tools.AC3.1 Success:** `memory` tool with `action: "store"` persists a memory entry via outbox
- **native-tools.AC3.2 Success:** `memory` tool with `action: "search"` returns matching memories
- **native-tools.AC3.3 Success:** `cache` tool with each of 4 actions (warm, pin, unpin, evict) produces correct behavior
- **native-tools.AC3.4 Success:** `skill` tool with each of 4 actions (activate, list, read, retire) produces correct behavior
- **native-tools.AC3.5 Failure:** Invalid action value returns descriptive error listing valid actions
- **native-tools.AC3.6 Failure:** Missing action-specific required params return descriptive error

### native-tools.AC4: Old command dispatch path is fully removed
- **native-tools.AC4.1 Success:** No `CommandDefinition` handler files exist in `packages/agent/src/commands/` (except MCP bridge, registry, index)
- **native-tools.AC4.2 Success:** `createDefineCommands()` is removed from `packages/sandbox/src/commands.ts`
- **native-tools.AC4.3 Success:** `sandboxTool` description no longer lists built-in commands
- **native-tools.AC4.4 Success:** MCP bridge commands still dispatch correctly through bash

### native-tools.AC5: System prompt reflects native tool architecture
- **native-tools.AC5.1 Success:** Orientation contains "### Additional MCP Commands" section with only MCP bridge entries
- **native-tools.AC5.2 Success:** No "### Available Commands" section exists in the generated system prompt
- **native-tools.AC5.3 Success:** MCP bridge commands support `--help` via `formatHelp()`
- **native-tools.AC5.4 Success:** Native tools are discoverable through `ToolDefinition` schemas in the API `tools` parameter

### native-tools.AC6: Relay inference carries native tools
- **native-tools.AC6.1 Success:** `InferenceRequestPayload.tools` includes all 14 native tool definitions when forwarding to remote host
- **native-tools.AC6.2 Success:** Remote host dispatches relayed native tool calls through unified registry

### native-tools.AC7: Documentation is accurate
- **native-tools.AC7.1 Success:** CLAUDE.md references native tools, not bash commands, for agent tool dispatch
- **native-tools.AC7.2 Success:** CONTRIBUTING.md "Adding an agent tool" checklist describes the `RegisteredTool` factory pattern
- **native-tools.AC7.3 Success:** No documentation references the old `CommandDefinition` dispatch pattern (except historical design docs)

## Glossary

- **Agent loop**: The state machine in `packages/agent/src/agent-loop.ts` that processes user messages: hydrate filesystem -> assemble context -> call LLM -> parse response -> execute tools -> persist results.
- **Bash sandbox**: The shell environment (bash tool) that currently dispatches built-in commands as string-based invocations via `sandbox.exec()`. Commands run in a just-bash interpreter with access to an in-memory filesystem.
- **Built-in tools**: Tools implemented directly in Bound's agent package (currently read/write/edit/retrieve_task file operations). After this design, includes the 14 native agent tools.
- **Change-log outbox pattern**: The write path for synced tables (`insertRow()`, `updateRow()`, `softDelete()` in `@bound/core`) that ensures every database write generates a `change_log` entry for multi-host sync.
- **Client tools**: Tools that execute outside the agent loop (e.g., in the web UI or boundless client). The agent returns a `ClientToolCallRequest` sentinel; the client polls for results and sends them back.
- **CommandDefinition**: The old interface for bash-dispatched commands in `packages/sandbox/src/commands.ts`, with string-based argument parsing and `--help` support. Being removed in this design.
- **Context assembly**: The 8-stage pipeline in `packages/agent/src/context-assembly.ts` that builds the LLM prompt from thread history, volatile enrichment, tool definitions, and system prompt.
- **Cron expression word-splitting**: A historical bug class where cron schedules like `"0,30 * * * *"` were parsed as bash arguments, causing spaces to split into separate tokens.
- **MCP bridge commands**: Dynamically generated commands (one per connected MCP server) that dispatch via a `subcommand` parameter. These remain bash-dispatched in this design.
- **Orientation**: The system prompt section that lists available commands and describes the agent's environment. After this design, shows only "### Additional MCP Commands" for MCP bridge entries.
- **Platform tools**: Tools specific to a platform connector (e.g., Discord's `discord_send_message`). Registered as `kind: "platform"` with execute handlers that return strings.
- **RegisteredTool**: The new unified interface introduced in this design: `{ kind, toolDefinition, execute? }`. Replaces the heterogeneous tool dispatch patterns.
- **Relay inference**: The code path where a spoke host forwards an LLM call to a remote hub host via the sync protocol's relay mechanism. Tool definitions round-trip through `InferenceRequestPayload`.
- **ToolContext**: A type extending `CommandContext` with all fields needed by agent tools (db, siteId, eventBus, logger, threadId, taskId, mcpClients, modelRouter, fs). Passed via closure to tool factories.
- **ToolDefinition**: The JSON schema format used by LLM drivers to describe tool names, descriptions, and parameter shapes. Defined in `packages/llm/src/types.ts`.

## Architecture

### Unified Tool Registry

Replace the current multi-map waterfall dispatch in `executeToolCall()` (`packages/agent/src/agent-loop.ts:2106`) with a single `Map<string, RegisteredTool>`. Each entry carries a `kind` tag that controls dispatch behavior:

```typescript
interface RegisteredTool {
	kind: "platform" | "client" | "builtin" | "sandbox";
	toolDefinition: ToolDefinition;
	execute?: (input: Record<string, unknown>) => Promise<BuiltInToolResult>;
}
```

- **`platform`**: has `execute`, returns string (e.g., `discord_send_message`)
- **`client`**: no `execute` — returns `ClientToolCallRequest` sentinel for WS-deferred execution
- **`builtin`**: has `execute`, returns `string | ContentBlock[]` — includes existing file tools (read, write, edit, retrieve_task) AND the 14 new native agent tools
- **`sandbox`**: special singleton for the `bash` tool — delegates to `sandbox.exec()`

Dispatch becomes a single map lookup plus a switch on `kind`:

```typescript
const tool = this.toolRegistry.get(toolCall.name);
if (!tool) return { content: `Error: unknown tool "${toolCall.name}"`, exitCode: 1 };

switch (tool.kind) {
	case "client":
		return { clientToolCall: true, toolName: toolCall.name, callId: toolCall.id, arguments: toolCall.input };
	case "sandbox":
		return sandboxExec(toolCall);
	default:
		return executeWithResult(tool, toolCall);
}
```

Duplicate name detection at registration time: warn and skip (first registration wins).

### Native Tool Definitions

14 native tools replace 20 bash-dispatched commands. Three families use an `action` parameter to group related operations:

| Tool | Actions / Params | Replaces |
|------|-----------------|----------|
| `memory` | action: store, forget, search, connect, disconnect, traverse, neighbors | `memory` (7 subcommands) |
| `cache` | action: warm, pin, unpin, evict | `cache-warm`, `cache-pin`, `cache-unpin`, `cache-evict` |
| `skill` | action: activate, list, read, retire | `skill-activate`, `skill-list`, `skill-read`, `skill-retire` |
| `schedule` | task_description, cron, delay, on_event, model_hint, thread_id | `schedule` |
| `cancel` | task_id | `cancel` |
| `query` | sql | `query` |
| `emit` | event, payload | `emit` |
| `await_event` | event, timeout | `await` |
| `purge` | target, scope params | `purge` |
| `advisory` | title, detail, action, impact | `advisory` |
| `notify` | params | `notify` |
| `archive` | params | `archive` |
| `model_hint` | model | `model-hint` |
| `hostinfo` | (no params) | `hostinfo` |

All tools use flat parameter schemas. The LLM passes structured JSON — no bash string parsing, no word-splitting, no quoting issues.

### Context Binding

Each tool factory closes over `CommandContext` (db, siteId, eventBus, logger) at creation time, plus receives `threadId` and `taskId` per-loop. This follows the same pattern as existing built-in tools in `packages/agent/src/built-in-tools.ts`:

```typescript
function createScheduleTool(ctx: ToolContext): RegisteredTool {
	return {
		kind: "builtin",
		toolDefinition: { /* JSON schema */ },
		execute: async (input) => {
			// ctx.db, ctx.siteId, ctx.eventBus available via closure
		},
	};
}
```

A `ToolContext` type extends the existing `CommandContext` with all fields needed by agent tools (db, siteId, eventBus, logger, threadId, taskId, mcpClients, modelRouter, fs).

### Registry Assembly

A `createToolRegistry()` function in `packages/cli/src/commands/start/agent-factory.ts` assembles the single map from all sources:

1. Sandbox tool — one `kind: "sandbox"` entry for bash
2. File tools — `createBuiltInTools(fs)` returns read/write/edit/retrieve_task as `kind: "builtin"`
3. Agent tools — `createAgentTools(ctx)` returns 14 native tools as `kind: "builtin"`
4. Platform tools — from `connector.getPlatformTools()` as `kind: "platform"`
5. Client tools — from config as `kind: "client"`
6. MCP bridge tools — from config, added alongside everything else

### System Prompt Changes

The orientation section in `packages/agent/src/context-assembly.ts` currently generates "### Available Commands" listing all 20 built-in commands from `getCommandRegistry()`. This section is replaced with "### Additional MCP Commands" listing only MCP bridge commands. Built-in tools are self-describing through their `ToolDefinition` schemas.

`getCommandRegistry()` continues to exist but returns only MCP bridge `CommandDefinition` entries. `formatHelp()` and `--help` support are retained for MCP bridge commands.

### Relay Compatibility

Native tools are `ToolDefinition` objects, which already serialize through `InferenceRequestPayload.tools` (`packages/shared/src/relay-schemas.ts`). The relay path carries the expanded tool list naturally. No relay-specific changes required.

## Existing Patterns

### BuiltInTool pattern (followed)

The `BuiltInTool` interface in `packages/agent/src/built-in-tools.ts` defines `{ toolDefinition, execute }` with `execute: (input: Record<string, unknown>) => Promise<string | ContentBlock[]>`. The 14 new agent tools follow this exact pattern. The `RegisteredTool` type extends it with a `kind` discriminant.

### Tool dispatch priority (replaced)

The current waterfall in `executeToolCall()` (platform → client → builtin → bash) is replaced by a single map lookup. Priority is handled at registration time rather than dispatch time.

### CommandDefinition + createDefineCommands (removed)

The `CommandDefinition` interface (`packages/sandbox/src/commands.ts:49`), `createDefineCommands()` wrapper (`packages/sandbox/src/commands.ts:90`), and just-bash `CustomCommand` integration are removed entirely. The 20 command handler files in `packages/agent/src/commands/` are replaced by tool factory functions.

### loopContextStorage for commands (partially removed)

`loopContextStorage` (`packages/sandbox/src/commands.ts:16`) currently propagates `threadId`/`taskId` through AsyncLocalStorage for bash-dispatched commands. Agent tools receive context via closure instead. `loopContextStorage` is retained for MCP bridge commands that still go through the bash/sandbox path and for the relay request side-channel.

### Orientation command listing (replaced)

The "### Available Commands" block generated from `getCommandRegistry()` in context assembly (`packages/agent/src/context-assembly.ts:1464`) is replaced with "### Additional MCP Commands" listing only MCP bridge entries.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: RegisteredTool Type & Unified Registry

**Goal:** Introduce the `RegisteredTool` type and `createToolRegistry()` function, migrating existing tools (file built-ins, platform, client, sandbox) into the unified registry without changing behavior.

**Components:**
- `RegisteredTool` type and `ToolContext` type in `packages/agent/src/types.ts`
- `createToolRegistry()` in `packages/cli/src/commands/start/agent-factory.ts` — assembles single map from all tool sources
- Refactored `executeToolCall()` in `packages/agent/src/agent-loop.ts` — single map lookup + kind switch

**Dependencies:** None

**Done when:** All existing tools (read, write, edit, retrieve_task, bash, platform, client) dispatch through the unified registry with identical behavior. Existing agent + CLI tests pass.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Standalone Agent Tools

**Goal:** Implement the 11 standalone native tools (schedule, cancel, query, emit, await_event, purge, advisory, notify, archive, model_hint, hostinfo) as `RegisteredTool` factories.

**Components:**
- Tool factory functions in `packages/agent/src/tools/` (new directory) — one file per tool, each exporting a `create*Tool(ctx: ToolContext): RegisteredTool` function
- JSON schema definitions for each tool's parameters (flat params, proper types)
- Registration in `createToolRegistry()` as `kind: "builtin"`

**Dependencies:** Phase 1 (unified registry exists)

**Done when:** All 11 standalone tools dispatch through the registry, accept structured JSON input, and produce equivalent results to the bash command versions. Tests verify happy path, error cases, and that structured params eliminate parsing ambiguity (e.g., cron expressions with spaces).
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Grouped Agent Tools

**Goal:** Implement the 3 grouped native tools (memory, cache, skill) with action parameters.

**Components:**
- `createMemoryTool(ctx)` in `packages/agent/src/tools/memory.ts` — action enum for store, forget, search, connect, disconnect, traverse, neighbors
- `createCacheTool(ctx)` in `packages/agent/src/tools/cache.ts` — action enum for warm, pin, unpin, evict
- `createSkillTool(ctx)` in `packages/agent/src/tools/skill.ts` — action enum for activate, list, read, retire
- Registration in `createToolRegistry()` as `kind: "builtin"`

**Dependencies:** Phase 1 (unified registry), Phase 2 (establishes tool factory pattern)

**Done when:** All 3 grouped tools dispatch correctly for every action variant, with equivalent behavior to the bash command versions. Tests verify each action, including edge cases around action-specific parameter requirements.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Remove Old Command Dispatch Path

**Goal:** Remove the bash-dispatched command infrastructure now that all commands are native tools.

**Components:**
- Remove 20 command handler files from `packages/agent/src/commands/` (advisory.ts, archive.ts, await-cmd.ts, cache-*.ts, cancel.ts, emit.ts, hostinfo.ts, memory.ts, model-hint.ts, notify.ts, purge.ts, query.ts, schedule.ts, skill-*.ts)
- Remove `helpers.ts` from `packages/agent/src/commands/` (if only used by removed commands)
- Remove `createDefineCommands()` from `packages/sandbox/src/commands.ts`
- Trim `packages/agent/src/commands/index.ts` and `registry.ts` to only export MCP bridge command registration
- Update `sandboxTool` description in `agent-factory.ts` to remove built-in command listing
- Remove `loopContextStorage` propagation for command context (retain for MCP relay side-channel)

**Dependencies:** Phases 2 and 3 (all native tools implemented and tested)

**Done when:** Old command handler files are deleted. `bash` tool description no longer mentions built-in commands. `createDefineCommands()` is removed. MCP bridge commands still work through bash. All tests pass.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: System Prompt & Orientation Update

**Goal:** Update context assembly to reflect native tools and remove command-listing orientation.

**Components:**
- Orientation generation in `packages/agent/src/context-assembly.ts` (~line 1464) — replace "### Available Commands" with "### Additional MCP Commands" listing only MCP bridge entries
- `getCommandRegistry()` in `packages/agent/src/commands/registry.ts` — returns only MCP bridge commands
- Retain `formatHelp()` and `--help` for MCP bridge commands

**Dependencies:** Phase 4 (old commands removed)

**Done when:** System prompt no longer lists built-in commands. MCP bridge commands appear under "### Additional MCP Commands". Agent can discover native tools through tool schemas. Context assembly tests pass.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Documentation Update

**Goal:** Update all documentation to reflect the new native tool architecture.

**Components:**
- `CLAUDE.md` — update operational mental model (tool dispatch priority, command references)
- `CONTRIBUTING.md` — update "Adding an agent command" checklist to "Adding an agent tool" checklist, update critical invariants if any reference command dispatch
- `docs/design/agent-system.md` — update agent loop documentation to describe unified registry
- `docs/design/architecture.md` — update if it references command dispatch
- `README.md` — update if it references built-in commands

**Dependencies:** Phase 5 (system prompt updated, architecture stable)

**Done when:** All documentation accurately describes the native tool architecture. No references to the old CommandDefinition dispatch pattern remain (except in historical design docs and git history).
<!-- END_PHASE_6 -->

## Additional Considerations

**MCP bridge migration (future):** MCP bridge commands remain as bash-dispatched commands in this design. A future effort could promote them to native tools as well, but their dynamic subcommand dispatch pattern and per-server generation make them a distinct problem. Keeping them separate avoids scope creep.

**Tool count growth:** Adding 14 tools to the LLM's tool list increases token usage in the `tools` API parameter. At ~100-200 tokens per tool definition, this adds roughly 1,400-2,800 tokens. This is offset by removing the orientation command listing from the system prompt, which was comparable in size.

**Backward compatibility:** This is a clean break with no compatibility shim. Since Bound is a single-node deployment syncing to a hub, there is no rolling-upgrade concern. One deploy switches everything over. Existing threads will have historical `tool_call`/`tool_result` messages referencing `bash` with command strings — these are inert historical data and don't affect the new dispatch path.
