# Native Agent Tools Implementation Plan — Phase 1

**Goal:** Introduce the `RegisteredTool` type and unified tool registry, migrating all existing tools (file built-ins, platform, client, sandbox) into a single `Map<string, RegisteredTool>` without changing behavior.

**Architecture:** Replace the waterfall dispatch pattern in `executeToolCall()` (platform → client → built-in → bash) with a single map lookup + `kind` switch. Each tool is tagged with a discriminant (`"platform"`, `"client"`, `"builtin"`, `"sandbox"`) that controls execution behavior. The `createToolRegistry()` function in `agent-factory.ts` assembles the registry from all tool sources at agent loop creation time.

**Tech Stack:** TypeScript, bun:test, @bound/agent, @bound/llm, @bound/sandbox, @bound/cli

**Scope:** 6 phases from original design (phase 1 of 6)

**Codebase verified:** 2026-04-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### native-tools.AC1: Unified tool registry dispatches all tool kinds
- **native-tools.AC1.1 Success:** Platform tool call resolves to correct handler and returns string result
- **native-tools.AC1.2 Success:** Client tool call returns `ClientToolCallRequest` sentinel without executing
- **native-tools.AC1.3 Success:** Built-in file tool call (read/write/edit/retrieve_task) dispatches and returns `string | ContentBlock[]`
- **native-tools.AC1.5 Success:** Sandbox (bash) tool call delegates to `sandbox.exec()` and returns output
- **native-tools.AC1.6 Failure:** Unknown tool name returns error message with exit code 1
- **native-tools.AC1.7 Edge:** Duplicate tool name at registration time logs warning and keeps first registration

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add RegisteredTool and ToolContext types

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/built-in-tools.ts` (re-export)

**Implementation:**

Add the following types to `packages/agent/src/types.ts` after the existing `AgentLoopResult` interface (after line 123):

```typescript
import type { ToolDefinition } from "@bound/llm";
import type { BuiltInToolResult } from "./built-in-tools.js";

export interface RegisteredTool {
	kind: "platform" | "client" | "builtin" | "sandbox";
	toolDefinition: ToolDefinition;
	execute?: (input: Record<string, unknown>) => Promise<BuiltInToolResult>;
}
```

Note: the `ToolDefinition` import already exists at line 1. The `BuiltInToolResult` type is `string | ContentBlock[]` (defined in `built-in-tools.ts:4`). Platform tools return `Promise<string>` which is a subtype of `BuiltInToolResult`. Client tools have no `execute` (deferred to WS client). Sandbox has no `execute` (delegates to `sandbox.exec()`).

Do NOT add `ToolContext` yet — that type will be introduced in Phase 2 when native agent tools need it. Phase 1 only needs `RegisteredTool` to wrap existing tools.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: Clean typecheck

**Commit:** `feat(agent): add RegisteredTool type for unified tool dispatch`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Export RegisteredTool from @bound/agent package

**Files:**
- Modify: `packages/agent/src/index.ts`

**Implementation:**

Add `RegisteredTool` to the exports from `packages/agent/src/index.ts`. Find the existing export line for types (should be exporting `AgentLoopConfig`, `AgentLoopResult`, `ClientToolCallRequest`, etc. from `./types.js`) and add `RegisteredTool` to it.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: Clean typecheck

**Commit:** `feat(agent): export RegisteredTool from package index`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Implement createToolRegistry() in agent-factory.ts

**Files:**
- Modify: `packages/cli/src/commands/start/agent-factory.ts`

**Implementation:**

Add a `createToolRegistry()` function that assembles a `Map<string, RegisteredTool>` from all tool sources. This function is called once per agent loop creation inside the existing factory function.

The function takes the existing tool sources already available in `createAgentLoopFactory`:
- `sandboxTool` constant (the bash tool definition, lines 20-37)
- `builtInTools` map (from `createBuiltInTools(fs)`, line 56)
- `config.platformTools` map (from `AgentLoopConfig`, line 68-74 of types.ts)
- `config.clientTools` map (from `AgentLoopConfig`, line 81-91 of types.ts)

Assemble the registry in this order (matching current dispatch priority):
1. Platform tools as `kind: "platform"` — these have `execute` returning `Promise<string>`
2. Client tools as `kind: "client"` — no `execute`, sentinel returned at dispatch
3. Built-in file tools as `kind: "builtin"` — read/write/edit/retrieve_task
4. Sandbox bash tool as `kind: "sandbox"` — single entry for the bash tool

Duplicate name detection: if a tool name is already registered, log a warning via `appContext.logger.warn()` and skip the duplicate (first registration wins).

The function signature:

```typescript
// Import BuiltInTool from @bound/agent (packages/agent/src/built-in-tools.ts)
function createToolRegistry(
	builtInTools: Map<string, BuiltInTool> | undefined,
	platformTools: AgentLoopConfig["platformTools"],
	clientTools: AgentLoopConfig["clientTools"],
	logger: AppContext["logger"],
): Map<string, RegisteredTool>
```

The sandbox tool is always registered first (it's a constant, not per-invocation). Platform tools wrap their `execute` to match `BuiltInToolResult` (platform execute returns `string`, which is already a subtype). Client tools have `execute: undefined`. Built-in tools already match the interface.

Place this function above the `createAgentLoopFactory` function (before line 41).

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: Clean typecheck

**Commit:** `feat(cli): implement createToolRegistry for unified tool dispatch`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Wire createToolRegistry into agent loop creation

**Files:**
- Modify: `packages/cli/src/commands/start/agent-factory.ts`
- Modify: `packages/agent/src/types.ts` (add `toolRegistry` to `AgentLoopConfig`)
- Modify: `packages/agent/src/agent-loop.ts` (add registry-based dispatch alongside existing waterfall)

**Implementation:**

**Step 1: Add `toolRegistry` to `AgentLoopConfig`**

In `packages/agent/src/types.ts`, add an optional field to `AgentLoopConfig` (after line 113):

```typescript
toolRegistry?: Map<string, RegisteredTool>;
```

**Step 2: Call createToolRegistry in the factory**

In `agent-factory.ts`, inside the returned factory closure (around line 139, before `new AgentLoop`), call:

```typescript
const toolRegistry = createToolRegistry(
	builtInTools,
	config.platformTools,
	config.clientTools,
	appContext.logger,
);
```

Pass `toolRegistry` into the `AgentLoop` config spread:

```typescript
return new AgentLoop(appContext, loopSandbox, modelRouter, {
	...config,
	tools: [sandboxTool, ...builtInToolDefs, ...extraTools, ...platformToolDefs],
	toolRegistry,
});
```

**Step 3: Add registry-based dispatch to executeToolCall**

In `packages/agent/src/agent-loop.ts`, refactor `executeToolCall()` (lines 2106-2165). The new implementation uses the registry when available, falling back to the existing waterfall for backward compatibility (in case something creates an AgentLoop without the registry):

```typescript
private async executeToolCall(
	toolCall: ParsedToolCall,
): Promise<{ content: string; exitCode: number } | RelayToolCallRequest | ClientToolCallRequest> {
	// Registry-based dispatch (new path)
	if (this.config.toolRegistry) {
		const tool = this.config.toolRegistry.get(toolCall.name);
		if (!tool) {
			return {
				content: `Error: unknown tool "${toolCall.name}"`,
				exitCode: 1,
			};
		}

		switch (tool.kind) {
			case "client":
				return {
					clientToolCall: true,
					toolName: toolCall.name,
					callId: toolCall.id,
					arguments: toolCall.input,
				} satisfies ClientToolCallRequest;

			case "sandbox": {
				if (!this.sandbox.exec) {
					return { content: "Error: sandbox execution not available", exitCode: 1 };
				}
				const command = toolCall.input.command;
				if (typeof command !== "string") {
					return {
						content: `Error: bash tool requires a "command" string parameter`,
						exitCode: 1,
					};
				}
				const result = await this.sandbox.exec(command);
				if (isRelayRequest(result)) {
					return result;
				}
				return {
					content: buildCommandOutput(result.stdout, result.stderr, result.exitCode),
					exitCode: result.exitCode,
				};
			}

			default: {
				// "platform" and "builtin" both have execute handlers
				if (!tool.execute) {
					return { content: `Error: tool "${toolCall.name}" has no execute handler`, exitCode: 1 };
				}
				const result = await tool.execute(toolCall.input);
				if (Array.isArray(result)) {
					const hasError = result.some(
						(b) => b.type === "text" && "text" in b && (b.text as string).startsWith("Error:"),
					);
					return { content: JSON.stringify(result), exitCode: hasError ? 1 : 0 };
				}
				const exitCode = result.startsWith("Error:") ? 1 : 0;
				return { content: result, exitCode };
			}
		}
	}

	// Legacy waterfall dispatch (fallback when no registry)
	const platformTool = this.config.platformTools?.get(toolCall.name);
	// ... existing code from lines 2110-2164 unchanged ...
}
```

Keep the existing waterfall code intact below the new registry block — this ensures backward compat for any code path that creates an `AgentLoop` without passing `toolRegistry`.

**Verification:**
Run: `tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit`
Expected: Clean typecheck on both

**Commit:** `feat(agent): wire unified tool registry into agent loop dispatch`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Implement getMergedTools using registry

**Files:**
- Modify: `packages/agent/src/agent-loop.ts`

**Implementation:**

Update `getMergedTools()` (line 2098) to use the registry when available.

**Key insight:** MCP bridge tools are NOT dispatched as individual tool_use blocks. The LLM calls them via the `bash` tool with `{"command": "github list-repos ..."}`. MCP bridge tool definitions in `config.tools` are informational only — they tell the LLM what's available, but execution always goes through the bash sandbox. This means:
- The registry handles platform, client, builtin (file + agent tools), and sandbox (bash) — these are the only tools that dispatch as their own tool_use blocks
- MCP bridge tool definitions just need to appear in the merged tool list sent to the LLM
- Unknown tool names in registry dispatch → error (correct, the LLM should call `bash`)

The registry-based `getMergedTools()` extracts tool definitions from the registry, then appends any `config.tools` entries not already in the registry (MCP bridge tool definitions):

```typescript
private getMergedTools(): Array<ToolDefinition> | undefined {
	if (this.config.toolRegistry) {
		const registryTools: ToolDefinition[] = [];
		for (const registered of this.config.toolRegistry.values()) {
			registryTools.push(registered.toolDefinition);
		}
		// config.tools may contain MCP bridge tool definitions that
		// appear in the LLM tool list but dispatch through the bash tool.
		// Include any config.tools entries not already in the registry.
		const registryNames = new Set(this.config.toolRegistry.keys());
		const extras = (this.config.tools ?? []).filter(
			(t) => !registryNames.has(t.function.name),
		);
		const merged = [...registryTools, ...extras];
		return merged.length > 0 ? merged : undefined;
	}

	// Legacy path (when no registry provided)
	const serverTools = this.config.tools ?? [];
	const clientTools = this.config.clientTools ? Array.from(this.config.clientTools.values()) : [];
	const merged: Array<ToolDefinition> = [...serverTools, ...clientTools];
	return merged.length > 0 ? merged : undefined;
}
```

No changes needed to `executeToolCall` for MCP bridge compat — the registry-based dispatch correctly returns an error for unknown tool names, and the LLM invokes MCP bridge commands via the `bash` tool (which IS in the registry as `kind: "sandbox"`).

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: Clean typecheck

**Commit:** `feat(agent): use tool registry for getMergedTools with MCP bridge compat`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Tests for unified tool registry

**Verifies:** native-tools.AC1.1, native-tools.AC1.2, native-tools.AC1.3, native-tools.AC1.5, native-tools.AC1.6, native-tools.AC1.7

**Files:**
- Create: `packages/agent/src/__tests__/tool-registry.test.ts`

**Implementation:**

Test the `createToolRegistry()` function and the registry-based dispatch behavior. Use the existing test patterns from `built-in-tools.test.ts` and `client-tool-dispatch.test.ts`.

**Testing:**
Tests must verify each AC listed above:
- **native-tools.AC1.1:** Register a platform tool, call `executeToolCall` with its name → returns string result from the platform tool's execute handler
- **native-tools.AC1.2:** Register a client tool, call `executeToolCall` with its name → returns `ClientToolCallRequest` sentinel (verify `clientToolCall: true`, correct `toolName`, `callId`, `arguments`)
- **native-tools.AC1.3:** Register built-in file tools via `createBuiltInTools(fs)`, call `executeToolCall` with `read` → dispatches and returns file content. Test with `InMemoryFs` from `just-bash`.
- **native-tools.AC1.5:** Register the sandbox tool, call `executeToolCall` with `bash` and `{command: "echo hello"}` → delegates to `sandbox.exec()` mock and returns output
- **native-tools.AC1.6:** Call `executeToolCall` with unregistered tool name `"nonexistent"` → returns `{ content: 'Error: unknown tool "nonexistent"', exitCode: 1 }`
- **native-tools.AC1.7:** Register two tools with the same name → second registration is skipped, first handler is called. Verify a warning was logged.

Test structure follows the existing pattern:
- Use `describe`/`it` blocks with `bun:test`
- Create real temp SQLite DB for context (or stub as needed)
- Use `InMemoryFs` for file tool tests
- Stub logger with `{ debug: () => {}, info: () => {}, warn: jest.fn(), error: () => {} }` (use `vi.fn()` equivalent — in bun:test, use a tracking array or `mock()`)
- Stub eventBus with `{ on: () => {}, off: () => {}, emit: () => {} }`

For testing `executeToolCall` through the registry, you may need to either:
- Test `createToolRegistry()` directly (unit test the registry assembly) and then test the dispatch logic separately
- Or create a minimal `AgentLoop` with a mock model router (heavier, but tests the full path)

Prefer testing `createToolRegistry()` directly for AC1.7 (duplicate detection) and test the dispatch path through the agent loop for AC1.1-AC1.6 if feasible, otherwise test the dispatch logic extracted as a helper.

**Verification:**
Run: `bun test packages/agent/src/__tests__/tool-registry.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add unified tool registry tests covering AC1.1-AC1.7`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_TASK_7 -->
### Task 7: Verify full test suite passes

**Files:** None (verification only)

**Verification:**
Run: `bun test --recursive`
Expected: Exit code 0, no new failures (the pre-existing flaky model-resolution sort test is acceptable)

Run: `tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit`
Expected: Clean typecheck on both packages

**Commit:** No commit needed — this is verification only. If any tests fail, fix them before proceeding.
<!-- END_TASK_7 -->
