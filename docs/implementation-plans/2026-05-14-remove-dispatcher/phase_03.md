# Remove Dispatcher Implementation Plan - Phase 3: Tool Resolver Rewrite

**Goal:** Replace the dispatcher-special-cased `platformToolResolver` with a two-branch annotation-filtered version. Event task threads get their scoped server's full tools; all other threads get the connector tool plus read-only platform tools.

**Architecture:** Rewrite the `platformToolResolver` callback in `scheduler.ts` (lines 231-243) to use `getReadOnlyPlatformTools()` and `createConnectorTool()` from Phase 1 and 2. Remove `isDispatcherThread()` usage. The connector tool is created once at startup using the existing `remotePlatformRequest` closure.

**Tech Stack:** TypeScript, @bound/platforms (createConnectorTool, getReadOnlyPlatformTools)

**Scope:** 4 phases from original design (phase 3 of 4)

**Codebase verified:** 2026-05-14

---

## Acceptance Criteria Coverage

This phase implements and tests:

### remove-dispatcher.AC3: Annotation-based tool filtering
- **remove-dispatcher.AC3.4 Success:** User-facing threads receive readOnly platform tools + connector tool from platformToolResolver
- **remove-dispatcher.AC3.5 Failure:** User-facing threads do NOT receive write tools (discord_send_message, discord_respond_interaction)

### remove-dispatcher.AC4: Event task scoping preserved
- **remove-dispatcher.AC4.1 Success:** Event task threads with a connector handle receive all tools from their bound server
- **remove-dispatcher.AC4.2 Success:** Event task threads do NOT receive the connector tool or tools from other servers

---

<!-- START_TASK_1 -->
### Task 1: Rewrite platformToolResolver to two-branch model

**Verifies:** remove-dispatcher.AC3.4, remove-dispatcher.AC3.5, remove-dispatcher.AC4.1, remove-dispatcher.AC4.2

**Files:**
- Modify: `packages/cli/src/commands/start/scheduler.ts:106-243`

**Implementation:**

Replace the current dispatcher tools creation block (lines 106-193) and the `platformToolResolver` callback (lines 231-243) with the new two-branch model.

**What to remove:**
- Lines 106-193: the entire `dispatcherTools` creation block (4 individual tool factories, the adaptation from DispatcherTool to PlatformRegisteredTool)
- Lines 231-243: the current `platformToolResolver` callback that uses `isDispatcherThread()`

**What to add in place of lines 106-193:**

Create the connector tool once at startup using `createConnectorTool()` from `@bound/platforms`:

```typescript
// Create unified connector tool (replaces 4 dispatcher-specific tools)
let connectorTool: PlatformRegisteredTool | null = null;
if (platformMcpRegistry) {
	const connectorCtx: ConnectorToolContext = {
		registry: platformMcpRegistry,
		db: appContext.db,
		siteId: appContext.siteId,
		remotePlatformRequest: async (
			serverName: string,
			method: string,
			params: Record<string, unknown>,
		): Promise<unknown> => {
			// [existing remotePlatformRequest closure body — lines 119-178 unchanged]
		},
	};
	const rawConnectorTool = createConnectorTool(connectorCtx);
	// Adapt ConnectorToolDef (kind: "builtin") to PlatformRegisteredTool (kind: "platform") for the platform tools array
	connectorTool = {
		kind: "platform" as const,
		toolDefinition: rawConnectorTool.toolDefinition,
		execute: rawConnectorTool.execute,
	};
}
```

**What to add in place of lines 231-243** (the new resolver):

```typescript
platformToolResolver: platformMcpRegistry
	? (threadId: string) => {
			// Event task threads: scoped to their bound server's full tool set
			const scopedTools = platformMcpRegistry.getToolsForThread(threadId);
			if (scopedTools.size > 0) {
				return Array.from(scopedTools.values());
			}
			// All other threads: read-only platform tools + connector tool
			const readOnlyTools = Array.from(
				platformMcpRegistry.getReadOnlyPlatformTools().values(),
			);
			if (connectorTool) {
				return [...readOnlyTools, connectorTool];
			}
			return readOnlyTools;
		}
	: undefined,
```

**Key behavioral change:** `getToolsForThread()` returns an empty map for threads NOT bound to a connector handle (line 582 of mcp-registry.ts: "no event task → no platform tools"). So when `scopedTools.size > 0`, the thread is an event task and gets scoped tools. Otherwise it's a user-facing thread and gets read-only + connector.

**Import changes at file top:**
- Remove: `createConnectorListTool`, `createConnectorChannelsTool`, `createConnectorAttachTool`, `createConnectorDetachTool`, `type DispatcherToolContext`
- Add: `createConnectorTool`, `type ConnectorToolContext`

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

Run: `bun test packages/platforms`
Expected: Existing tests still pass (event task scoping unchanged)

**Commit:** `feat(platforms): rewrite platformToolResolver to annotation-based two-branch model`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tool resolver integration tests

**Verifies:** remove-dispatcher.AC3.4, remove-dispatcher.AC3.5, remove-dispatcher.AC4.1, remove-dispatcher.AC4.2

**Files:**
- Modify: `packages/platforms/src/__tests__/tool-scoping.integration.test.ts`

**Testing:**

Add new test cases to the existing tool-scoping integration test. These tests verify the two-branch resolver logic by constructing the resolver callback inline (matching the pattern from `scheduler.ts`) and exercising it with different thread IDs.

The test constructs the resolver as a local function that uses `registry.getToolsForThread()` and `registry.getReadOnlyPlatformTools()` — this tests the same logic paths as the production resolver without importing from `@bound/cli`:

```typescript
// Construct the resolver logic under test (mirrors scheduler.ts platformToolResolver)
function resolverUnderTest(threadId: string): PlatformRegisteredTool[] {
	const scopedTools = registry.getToolsForThread(threadId);
	if (scopedTools.size > 0) {
		return Array.from(scopedTools.values());
	}
	const readOnlyTools = Array.from(registry.getReadOnlyPlatformTools().values());
	return connectorTool ? [...readOnlyTools, connectorTool] : readOnlyTools;
}
```

Tests must verify each AC:
- remove-dispatcher.AC3.4: Call resolver with a user-facing thread ID (no connector handle in DB). Result should include tools with `annotations.readOnlyHint === true` and the connector tool.
- remove-dispatcher.AC3.5: Same call — result should NOT include `discord_send_message` or `discord_respond_interaction` (write tools without readOnlyHint annotation).
- remove-dispatcher.AC4.1: Call resolver with an event task thread ID (linked via task → connector_handle → server). Result should include ALL tools from the bound server (including write tools).
- remove-dispatcher.AC4.2: Same event task thread — result should NOT include the connector tool or tools from other servers.

Setup requires: a `PlatformMcpRegistry` with mock MCP servers that register tools with and without annotations, a real DB with `connector_handles` and `tasks` rows linking a thread to a server, and a mock `ConnectorToolDef` adapted to `PlatformRegisteredTool`.

**Verification:**
Run: `bun test packages/platforms/src/__tests__/tool-scoping.integration.test.ts`
Expected: All tests pass

**Commit:** `test(platforms): add tool resolver integration tests for two-branch model`
<!-- END_TASK_2 -->
