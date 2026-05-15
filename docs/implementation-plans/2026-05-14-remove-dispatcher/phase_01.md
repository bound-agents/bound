# Remove Dispatcher Implementation Plan - Phase 1: Annotation Pipeline

**Goal:** Platform tools carry MCP annotations from server registration through discovery to the registered tool object, enabling annotation-based tool filtering.

**Architecture:** Extend `PlatformRegisteredTool` interface with an optional `annotations` field, preserve annotations during `discoverTools()`, add `annotations` at Discord tool registration, and expose a `getReadOnlyPlatformTools()` filtering method.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk ^1.28.0, bun:test

**Scope:** 4 phases from original design (phase 1 of 4)

**Codebase verified:** 2026-05-14

---

## Acceptance Criteria Coverage

This phase implements and tests:

### remove-dispatcher.AC3: Annotation-based tool filtering
- **remove-dispatcher.AC3.1 Success:** discord_list_channels is registered with readOnlyHint: true annotation
- **remove-dispatcher.AC3.2 Success:** discoverTools() preserves annotations from MCP listTools() response on PlatformRegisteredTool
- **remove-dispatcher.AC3.3 Success:** getReadOnlyPlatformTools() returns only tools where annotations.readOnlyHint === true
- **remove-dispatcher.AC3.6 Edge:** Tools with no annotations (readOnlyHint defaults to false) are excluded from user-facing threads

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Extend PlatformRegisteredTool interface with annotations field

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts:38-42`

**Implementation:**

Add an optional `annotations` field to the `PlatformRegisteredTool` interface. The type mirrors the MCP SDK's `ToolAnnotations` shape but is defined inline to avoid coupling to SDK internals:

```typescript
export interface PlatformRegisteredTool {
	kind: "platform";
	toolDefinition: ToolDefinition;
	execute?: (input: Record<string, unknown>) => Promise<string>;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}
```

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors (field is optional, existing code unaffected)

**Commit:** `feat(platforms): add annotations field to PlatformRegisteredTool interface`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Preserve annotations in discoverTools() and register annotations on discord_list_channels

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts:86-127` (discoverTools method)
- Modify: `packages/platforms/src/connectors/discord-server.ts:379-391` (discord_list_channels registration)

**Implementation:**

In `discoverTools()`, preserve the `annotations` field from the MCP `listTools()` response when constructing `PlatformRegisteredTool` objects. The MCP SDK's `Tool` type includes `annotations?: ToolAnnotations` in the response from `client.listTools()`.

In `discord-server.ts`, add `annotations: { readOnlyHint: true }` to the `discord_list_channels` registration config object (second parameter to `mcpServer.registerTool()`).

For `discoverTools()` at line 92, add after the `execute` field:

```typescript
const registeredTool: PlatformRegisteredTool = {
	kind: "platform",
	toolDefinition: { /* existing */ },
	execute: async (input) => { /* existing */ },
	annotations: tool.annotations as PlatformRegisteredTool["annotations"],
};
```

For `discord_list_channels` at line 379:

```typescript
mcpServer.registerTool(
	"discord_list_channels",
	{
		description: "List known DM channel IDs that have sent messages to this bot.",
		inputSchema: {},
		annotations: {
			readOnlyHint: true,
		},
	},
	async () => {
		const channels = Array.from(seenChannelIds);
		return {
			content: [{ type: "text", text: JSON.stringify(channels) }],
		};
	},
);
```

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `feat(platforms): preserve MCP annotations in discoverTools and annotate discord_list_channels`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add getReadOnlyPlatformTools() method and tests

**Verifies:** remove-dispatcher.AC3.1, remove-dispatcher.AC3.2, remove-dispatcher.AC3.3, remove-dispatcher.AC3.6

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts` (add method after `getAllPlatformTools()`)
- Create: `packages/platforms/src/__tests__/annotation-pipeline.test.ts`

**Implementation:**

Add a `getReadOnlyPlatformTools()` method to `PlatformMcpRegistry` that filters across all servers for tools with `annotations?.readOnlyHint === true`:

```typescript
/**
 * Returns platform tools annotated as read-only across all servers.
 * Tools without annotations or with readOnlyHint !== true are excluded.
 */
getReadOnlyPlatformTools(): Map<string, PlatformRegisteredTool> {
	const readOnly = new Map<string, PlatformRegisteredTool>();
	for (const [_serverName, tools] of this.platformTools) {
		for (const [toolName, tool] of tools) {
			if (tool.annotations?.readOnlyHint === true) {
				readOnly.set(toolName, tool);
			}
		}
	}
	return readOnly;
}
```

**Testing:**

Tests must verify each AC listed above:
- remove-dispatcher.AC3.1: After registering Discord server with annotated `discord_list_channels`, verify it appears in discovered tools with `readOnlyHint: true`
- remove-dispatcher.AC3.2: After `discoverTools()` runs, verify `PlatformRegisteredTool.annotations` matches what the MCP server registered
- remove-dispatcher.AC3.3: `getReadOnlyPlatformTools()` returns only tools where `annotations.readOnlyHint === true`, excludes write tools like `discord_send_message`
- remove-dispatcher.AC3.6: Tools registered without any annotations (or with `readOnlyHint: false`) do not appear in `getReadOnlyPlatformTools()`

Test structure follows the existing pattern in `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts` — create a `PlatformMcpRegistry` with real DB and mock MCP servers that register tools with/without annotations, then verify discovery and filtering.

Use the existing `createMockMcpServer()` pattern but include `annotations` in the tool definition returned by the mock's `tools/list` handler.

**Verification:**
Run: `bun test packages/platforms/src/__tests__/annotation-pipeline.test.ts`
Expected: All tests pass

**Commit:** `feat(platforms): add getReadOnlyPlatformTools method with annotation filtering`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
