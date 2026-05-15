# Remove Dispatcher Implementation Plan - Phase 2: Connector Tool

**Goal:** A unified action-dispatcher tool replaces the 4 individual dispatcher tool factories, providing list/channels/attach/detach actions through a single entry point.

**Architecture:** Single `createConnectorTool(ctx)` factory function returning a `ConnectorToolDef` with Zod-validated action-dispatcher pattern. Execute bodies are lifted from existing `dispatcher-tools.ts` functions with minimal modification.

**Tech Stack:** TypeScript, Zod v4, bun:test, @bound/core (insertRow/softDelete)

**Scope:** 4 phases from original design (phase 2 of 4)

**Codebase verified:** 2026-05-14

---

## Acceptance Criteria Coverage

This phase implements and tests:

### remove-dispatcher.AC2: Connector tool available and functional
- **remove-dispatcher.AC2.1 Success:** `list` action returns all connected platform servers (local + cluster-wide from hosts.platforms)
- **remove-dispatcher.AC2.2 Success:** `channels` action returns events from a server annotated with bound/unbound status
- **remove-dispatcher.AC2.3 Success:** `channels` action falls back to remotePlatformRequest when server is not local
- **remove-dispatcher.AC2.4 Success:** `attach` action creates connector_handle, event task (type=event), and thread (interface=platform) with correct linkage
- **remove-dispatcher.AC2.5 Success:** `attach` action activates subscription immediately when local leader has the server
- **remove-dispatcher.AC2.6 Success:** `detach` action soft-deletes handle and associated task
- **remove-dispatcher.AC2.7 Failure:** `attach` returns error when handle already exists (idempotency check)
- **remove-dispatcher.AC2.8 Failure:** `detach` returns error when handle_id not found
- **remove-dispatcher.AC2.9 Failure:** `channels` returns error when server not found locally and no remote relay

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Create connector-tool.ts with action-dispatcher pattern

**Files:**
- Create: `packages/platforms/src/connector-tool.ts`

**Implementation:**

Create `createConnectorTool(ctx: ConnectorToolContext): ConnectorToolDef` following the action-dispatcher pattern from `packages/agent/src/tools/memory.ts`. The tool uses Zod for input validation and an exhaustive switch for dispatch.

The `ConnectorToolContext` interface is identical to the existing `DispatcherToolContext` from `dispatcher-tools.ts` (renamed for clarity in the new file). The `ConnectorToolDef` interface (the return type) is defined locally to avoid coupling to the soon-to-be-deleted `dispatcher-tools.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, softDelete } from "@bound/core";
import type { ToolDefinition } from "@bound/llm";
import { z } from "zod";
import { connectorHandleId } from "./connector-handle-id.js";
import {
	createConnectorHandle,
	getConnectorHandle,
	getConnectorHandlesByServer,
} from "./connector-handle.js";
import type { PlatformMcpRegistry } from "./mcp-registry.js";

/**
 * Return type for the connector tool factory.
 * Structurally compatible with RegisteredTool from @bound/agent.
 */
export interface ConnectorToolDef {
	kind: "builtin";
	toolDefinition: ToolDefinition;
	execute?: (input: Record<string, unknown>) => Promise<string>;
}
```

**ConnectorToolContext interface** (same shape as existing `DispatcherToolContext`):
```typescript
export interface ConnectorToolContext {
	registry: PlatformMcpRegistry;
	db: Database;
	siteId: string;
	remotePlatformRequest?: (
		serverName: string,
		method: string,
		params: Record<string, unknown>,
	) => Promise<unknown>;
}
```

**Zod schema:**
```typescript
const connectorSchema = z.object({
	action: z.enum(["list", "channels", "attach", "detach"]).describe(
		"Connector operation: list servers, list event channels, attach to event, detach from event",
	),
	server_name: z.string().optional().describe("Platform server name (required for channels, attach)"),
	event_name: z.string().optional().describe("Event type to subscribe to (required for attach)"),
	event_args: z.record(z.string(), z.unknown()).optional().describe(
		"Subscription filter parameters (required for attach, e.g. { channel_id: '123' })",
	),
	handle_id: z.string().optional().describe("Connector handle ID to detach (required for detach)"),
});
```

**Tool definition** uses `zodToToolParams` pattern but since this is in `@bound/platforms` (not `@bound/agent`), convert Zod schema to JSON Schema manually using `z.toJSONSchema()`:

```typescript
const { $schema: _, ...parameters } = z.toJSONSchema(connectorSchema) as Record<string, unknown>;
```

**ConnectorToolDef return value:**
```typescript
export function createConnectorTool(ctx: ConnectorToolContext): ConnectorToolDef {
	const { $schema: _, ...parameters } = z.toJSONSchema(connectorSchema) as Record<string, unknown>;

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "connector",
				description:
					"Manage platform event subscriptions. Actions: list (show servers), channels (show events), attach (subscribe), detach (unsubscribe).",
				parameters,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const result = connectorSchema.safeParse(raw);
			if (!result.success) {
				const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
				return `Error: invalid parameters for "connector": ${issues}`;
			}
			const input = result.data;

			switch (input.action) {
				case "list":
					return handleList(ctx);
				case "channels":
					return handleChannels(ctx, input);
				case "attach":
					return handleAttach(ctx, input);
				case "detach":
					return handleDetach(ctx, input);
				default: {
					const _exhaustive: never = input.action;
					return `Error: unknown action`;
				}
			}
		},
	};
}
```

**Handler functions** — lift directly from existing `dispatcher-tools.ts` execute bodies:

`handleList`: Lines 48-68 of dispatcher-tools.ts (cluster-wide server discovery from local registry + hosts table)

`handleChannels`: Lines 96-134 of dispatcher-tools.ts (local client → events/list, or remotePlatformRequest fallback, annotate with bound status). Add validation that `server_name` is provided.

`handleAttach`: Lines 171-271 of dispatcher-tools.ts (idempotency check, create thread/task/handle, activate subscription). Add validation that `server_name`, `event_name`, and `event_args` are all provided.

`handleDetach`: Lines 302-328 of dispatcher-tools.ts (lookup handle, soft-delete handle + task). Add validation that `handle_id` is provided.

Each handler that requires a parameter not present returns an error string like `"Error: server_name is required for the 'channels' action"`.

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `feat(platforms): add unified connector tool with action-dispatcher pattern`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Connector tool tests

**Verifies:** remove-dispatcher.AC2.1, remove-dispatcher.AC2.2, remove-dispatcher.AC2.3, remove-dispatcher.AC2.4, remove-dispatcher.AC2.5, remove-dispatcher.AC2.6, remove-dispatcher.AC2.7, remove-dispatcher.AC2.8, remove-dispatcher.AC2.9

**Files:**
- Create: `packages/platforms/src/__tests__/connector-tool.test.ts`

**Testing:**

Tests must verify each AC listed above:

- remove-dispatcher.AC2.1: `list` action returns server names from both local registry and remote hosts table
- remove-dispatcher.AC2.2: `channels` action returns events annotated with `bound: true/false` based on existing connector_handles
- remove-dispatcher.AC2.3: `channels` falls back to `remotePlatformRequest` when `getClient()` returns null
- remove-dispatcher.AC2.4: `attach` creates rows in connector_handles, tasks (type=event), and threads (interface=platform) with correct foreign key linkage
- remove-dispatcher.AC2.5: `attach` calls `registry.activateSubscription()` when local client exists for the server
- remove-dispatcher.AC2.6: `detach` soft-deletes both the connector_handle row and associated task row
- remove-dispatcher.AC2.7: `attach` returns error string containing "already exists" when handle with same (server, event, args) exists
- remove-dispatcher.AC2.8: `detach` returns error string containing "not found" when handle_id doesn't match any active handle
- remove-dispatcher.AC2.9: `channels` returns error when server not in local registry AND `remotePlatformRequest` is undefined

Follow the testing pattern from `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts`:
- Real SQLite DB with `applySchema(db)` from `@bound/core`
- Random hex temp path for DB file
- Mock `PlatformMcpRegistry` (or create real one with mock MCP server)
- For AC2.3 and AC2.9: test with/without `remotePlatformRequest` closure
- For AC2.5: spy on `registry.activateSubscription` to verify it's called

**Verification:**
Run: `bun test packages/platforms/src/__tests__/connector-tool.test.ts`
Expected: All tests pass

**Commit:** `test(platforms): add connector tool tests covering all AC2 cases`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Export connector tool from platforms package

**Files:**
- Modify: `packages/platforms/src/index.ts`

**Implementation:**

Add the export for the new connector tool factory and its types:

```typescript
export { createConnectorTool, type ConnectorToolContext, type ConnectorToolDef } from "./connector-tool.js";
```

This export is needed by Phase 3 (scheduler.ts will import `createConnectorTool` to wire it into the tool resolver).

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `feat(platforms): export createConnectorTool from package index`
<!-- END_TASK_3 -->
