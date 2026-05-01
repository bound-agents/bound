# Native Agent Tools Implementation Plan — Phase 5

**Goal:** Update context assembly to reflect native tools and remove command-listing orientation. The "### Available Commands" section listing all 20+ commands is replaced with "### Additional MCP Commands" listing only MCP bridge entries. Native tools are self-describing through their `ToolDefinition` schemas in the API `tools` parameter.

**Architecture:** The orientation block in `context-assembly.ts` (lines 1458-1474) currently retrieves the full command registry via `getCommandRegistry()` and renders every command as a text listing. After Phase 4, the registry only contains MCP bridge commands. This phase updates the orientation to: (1) conditionally render the MCP section only when MCP commands exist, (2) rename the section header, and (3) remove the generic `--help` instruction in favor of MCP-specific guidance. The `formatHelp()` function in `packages/sandbox/src/commands.ts` is retained for MCP bridge `--help` support.

**Tech Stack:** TypeScript, bun:test, @bound/agent

**Scope:** 6 phases from original design (phase 5 of 6)

**Codebase verified:** 2026-04-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### native-tools.AC5: System prompt reflects native tool architecture
- **native-tools.AC5.1 Success:** Orientation contains "### Additional MCP Commands" section with only MCP bridge entries
- **native-tools.AC5.2 Success:** No "### Available Commands" section exists in the generated system prompt
- **native-tools.AC5.3 Success:** MCP bridge commands support `--help` via `formatHelp()`
- **native-tools.AC5.4 Success:** Native tools are discoverable through `ToolDefinition` schemas in the API `tools` parameter

### native-tools.AC6: Relay inference carries native tools
- **native-tools.AC6.1 Success:** `InferenceRequestPayload.tools` includes all 14 native tool definitions when forwarding to remote host
- **native-tools.AC6.2 Success:** Remote host dispatches relayed native tool calls through unified registry

---

<!-- START_TASK_1 -->
### Task 1: Update orientation block in context-assembly.ts

**Verifies:** native-tools.AC5.1, native-tools.AC5.2

**Files:**
- Modify: `packages/agent/src/context-assembly.ts`

**Implementation:**

Replace the orientation block at lines 1458-1474. The current code:

```typescript
const registry = getCommandRegistry();
const commandList = [...registry]
	.sort((a, b) => a.name.localeCompare(b.name))
	.map((c) => `  ${c.name} — ${c.description}`)
	.join("\n");

const orientationLines: string[] = [
	"## Orientation",
	"",
	"### Available Commands",
	commandList,
	"",
	"Run `<cmd> --help` for details on any command.",
	"",
	`### Host Identity\nHost: ${hostName || "unknown"}\nSite ID: ${siteId || "unknown"}`,
];
systemParts.push(orientationLines.join("\n"));
```

Replace with:

```typescript
const registry = getCommandRegistry();
const orientationLines: string[] = [
	"## Orientation",
	"",
];

// MCP bridge commands are the only commands still in the registry.
// Native agent tools are self-describing through their ToolDefinition schemas.
if (registry.length > 0) {
	const commandList = [...registry]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((c) => `  ${c.name} — ${c.description}`)
		.join("\n");
	orientationLines.push(
		"### Additional MCP Commands",
		commandList,
		"",
		"These are MCP server commands dispatched through the bash tool. Run `<server-name> --help` for details.",
		"",
	);
}

orientationLines.push(
	`### Host Identity\nHost: ${hostName || "unknown"}\nSite ID: ${siteId || "unknown"}`,
);

systemParts.push(orientationLines.join("\n"));
```

Key changes:
- Renamed "### Available Commands" → "### Additional MCP Commands"
- Section is now conditional — only rendered when MCP commands exist in the registry
- Help instruction updated to reference "server-name" instead of generic "cmd"
- Native tools no longer listed in text — they appear in the `tools` API parameter via their `ToolDefinition` schemas

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: Clean typecheck

**Commit:** `feat(agent): replace Available Commands with Additional MCP Commands in orientation`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Verify formatHelp still works for MCP bridge commands

**Verifies:** native-tools.AC5.3

**Files:** None (verification only)

**Implementation:**

Verify that `formatHelp()` in `packages/sandbox/src/commands.ts` (lines 62-88) is still called for MCP bridge commands when `--help` or `-h` is passed. This function is used inside `createDefineCommands()` (line 128-129 of commands.ts) which still processes MCP commands.

Check:
1. `createDefineCommands()` still exists and processes MCP CommandDefinitions
2. The `--help` interception logic (line 128-129) still works
3. `formatHelp()` is still exported and callable
4. MCP bridge test `mcp-bridge.test.ts` still passes

**Verification:**
Run: `bun test packages/agent/src/__tests__/mcp-bridge.test.ts`
Expected: All tests pass

**Commit:** No commit — verification only
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Verify native tools appear in LLM tool list

**Verifies:** native-tools.AC5.4

**Files:** None (verification only)

**Implementation:**

Verify that the 14 native tools appear in the LLM's tool list. This happens through the existing `getMergedTools()` method in `agent-loop.ts`, which extracts `toolDefinition` from the tool registry and passes them to the LLM via the `tools` parameter.

The chain is:
1. `createAgentTools(ctx)` returns 14 `RegisteredTool[]` (Phase 2+3)
2. `createToolRegistry()` registers them in the map (Phase 1)
3. `getMergedTools()` extracts `toolDefinition` from registry entries
4. Agent loop passes tools to LLM driver via `ChatParams.tools`

Verify by checking that a test creating an agent loop with the registry produces a `getMergedTools()` result containing all 14 native tool names.

If the existing tool-registry tests from Phase 1 already cover this, no new test needed. Otherwise, add a simple assertion.

**Verification:**
Run: `bun test packages/agent/src/__tests__/tool-registry.test.ts`
Expected: Tests verify tools appear in merged tool list

**Commit:** No commit — verification only
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update context-assembly tests

**Verifies:** native-tools.AC5.1, native-tools.AC5.2

**Files:**
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts`

**Implementation:**

Update existing context-assembly tests to reflect the new orientation structure. Tests should verify:
- **native-tools.AC5.1:** When MCP commands are in the registry, orientation contains "### Additional MCP Commands" with those commands listed
- **native-tools.AC5.2:** The string "### Available Commands" does NOT appear in the generated system prompt

Find existing tests that assert on orientation content and update them. If no orientation-specific tests exist, add:

1. A test that sets the command registry to empty and verifies the system prompt contains "## Orientation" and "### Host Identity" but NOT "### Available Commands" or "### Additional MCP Commands"
2. A test that sets the command registry to contain one MCP command and verifies "### Additional MCP Commands" appears with the command listed

Follow existing context-assembly test patterns (real temp DB, `applySchema`, minimal context setup).

**Verification:**
Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All tests pass

**Commit:** `test(agent): update context-assembly tests for native tool orientation`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Verify relay carries native tool definitions

**Verifies:** native-tools.AC6.1, native-tools.AC6.2

**Files:** None (verification only, possibly add test)

**Implementation:**

The design states relay inference carries native tools "naturally" through `InferenceRequestPayload.tools` (defined in `packages/shared/src/relay-schemas.ts:41` as `z.array(z.unknown()).optional()`). Since native tools are `ToolDefinition` objects (same type as existing tools), they serialize through the relay payload without code changes.

Verify this claim:

1. **AC6.1 — Serialization:** The 14 native tools are assembled into `config.tools` via `createToolRegistry()` → `getMergedTools()`. The agent loop passes this array to the LLM driver, and the relay path serializes it via `InferenceRequestPayload.tools`. Confirm that `ToolDefinition` objects from the registry round-trip through `inferenceRequestPayloadSchema.parse()` without data loss. Write a unit test:
   - Construct a `ToolDefinition` for one native tool (e.g., schedule)
   - Serialize it through `inferenceRequestPayloadSchema.parse({ ..., tools: [toolDef] })`
   - Verify the parsed output preserves `function.name`, `function.description`, and `function.parameters` including nested schema properties

2. **AC6.2 — Remote dispatch:** When a remote host receives a relayed inference request, the agent loop on that host creates its own `toolRegistry` via `createAgentTools()` during `createAgentLoopFactory()`. This means the remote host dispatches native tool calls through its own unified registry — no special relay handling needed. Verify by confirming that `createAgentLoopFactory` is called on both spoke and hub paths (it's the same factory used everywhere).

3. **Existing coverage check:** Review `packages/core/src/__tests__/hub-spoke-e2e.integration.test.ts` to see if relay inference scenarios exercise tool dispatch. If yes, note this as existing coverage. If no, add a note that multi-host relay testing of native tools should be verified during manual testing.

**Verification:**
Run: `bun test packages/shared` (for relay schema serialization test)
Expected: Native tool definitions round-trip through relay schema

**Commit:** `test(shared): verify native tool definitions serialize through relay payload`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Verify full test suite passes

**Files:** None (verification only)

**Verification:**
Run: `bun test --recursive`
Expected: Exit code 0, no new failures

Run: `tsc -p packages/agent --noEmit`
Expected: Clean typecheck

**Commit:** No commit — verification only. Fix any regressions before proceeding.
<!-- END_TASK_6 -->
