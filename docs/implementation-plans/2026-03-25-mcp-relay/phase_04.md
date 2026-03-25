# MCP Relay Transport — Phase 4: Target-Side Execution

**Goal:** Background inbox processor that executes incoming MCP requests on the target host and writes responses back to the outbox for delivery to the requester.

**Architecture:** A `RelayProcessor` class runs a background polling loop (similar to the existing Scheduler and startSyncLoop patterns). It reads unprocessed inbox entries, validates them (keyring, expiry, cancel), executes via local MCP clients, and writes result/error responses to the outbox with `ref_id` linking to the original request. An in-memory idempotency cache with 5-minute TTL prevents duplicate execution.

**Tech Stack:** TypeScript, bun:sqlite, MCPClient (local MCP server connections)

**Scope:** 8 phases from original design (phase 4 of 8)

**Codebase verified:** 2026-03-25

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-relay.AC1: Cross-host MCP calls via relay
- **mcp-relay.AC1.3 Success:** Resource read routes through relay and returns resource content
- **mcp-relay.AC1.4 Success:** Prompt invocation routes through relay and returns prompt result
- **mcp-relay.AC1.5 Success:** Cache-warm request routes through relay and returns file content

### mcp-relay.AC5: Idempotency
- **mcp-relay.AC5.1 Success:** Duplicate request with same idempotency_key returns cached result without re-execution
- **mcp-relay.AC5.3 Edge:** Idempotency cache entries expire after 5 minutes (re-execution allowed after TTL)

### mcp-relay.AC7: Cancel propagation
- **mcp-relay.AC7.3 Success:** Target discards pending request if cancel arrives before execution starts
- **mcp-relay.AC7.4 Edge:** Cancel arrives after tool execution — result sent normally, requester discards

### mcp-relay.AC9: Data integrity
- **mcp-relay.AC9.2 Success:** Expired requests discarded without execution on target

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Create RelayProcessor class with background loop

**Files:**
- Create: `packages/agent/src/relay-processor.ts`

**Implementation:**

Create a `RelayProcessor` class following the background loop pattern from `packages/agent/src/scheduler.ts` (start/stop, setTimeout recursion, graceful shutdown via stopped flag).

The processor:
1. Polls `readUnprocessed(db)` every `pollIntervalMs` (default 500ms)
2. For each unprocessed inbox entry, dispatches to `processEntry()`
3. Returns `{ stop: () => void }` handle for cleanup

```typescript
import type { Database } from "bun:sqlite";
import type { RelayInboxEntry, RelayConfig } from "@bound/shared";
import type { MCPClient } from "./mcp-client.js";
import type { Logger } from "@bound/shared";
import { readUnprocessed, markProcessed, writeOutbox } from "@bound/core";

const DEFAULT_POLL_INTERVAL_MS = 500;

interface IdempotencyCacheEntry {
	response: string;
	expiresAt: number;
}

export class RelayProcessor {
	private stopped = false;
	private idempotencyCache = new Map<string, IdempotencyCacheEntry>();
	private pendingCancels = new Set<string>();

	constructor(
		private db: Database,
		private siteId: string,
		private mcpClients: Map<string, MCPClient>,
		private keyringSiteIds: Set<string>,
		private logger: Logger,
		private relayConfig?: RelayConfig,
	) {}

	start(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): { stop: () => void } {
		this.stopped = false;
		const tick = async () => {
			if (this.stopped) return;
			try {
				await this.processPendingEntries();
				this.pruneIdempotencyCache();
			} catch (error) {
				this.logger.error("Relay processor tick failed", { error });
			}
			if (!this.stopped) {
				setTimeout(tick, pollIntervalMs);
			}
		};
		setTimeout(tick, pollIntervalMs);
		return {
			stop: () => {
				this.stopped = true;
			},
		};
	}

	private async processPendingEntries(): Promise<void> {
		const entries = readUnprocessed(this.db);
		if (entries.length === 0) return;

		// First pass: collect cancels to check against pending requests
		for (const entry of entries) {
			if (entry.kind === "cancel" && entry.ref_id) {
				this.pendingCancels.add(entry.ref_id);
				markProcessed(this.db, [entry.id]);
			}
		}

		// Second pass: process non-cancel entries
		for (const entry of entries) {
			if (entry.kind === "cancel") continue;
			await this.processEntry(entry);
		}
	}

	// ... processEntry, executeToolCall, etc. (see Task 2)

	private pruneIdempotencyCache(): void {
		const now = Date.now();
		for (const [key, value] of this.idempotencyCache) {
			if (value.expiresAt <= now) {
				this.idempotencyCache.delete(key);
			}
		}
	}
}
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors.

**Commit:** `feat(agent): create RelayProcessor class with background polling loop`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement entry processing with validation and execution

**Verifies:** mcp-relay.AC1.3, mcp-relay.AC1.4, mcp-relay.AC1.5, mcp-relay.AC5.1, mcp-relay.AC5.3, mcp-relay.AC7.3, mcp-relay.AC9.2

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (add processEntry and execution methods)

**Implementation:**

Add the `processEntry()` method and kind-specific execution methods to `RelayProcessor`. The processing pipeline for each inbox entry:

1. **Validate requester** — check `source_site_id` is in keyring. If not, write error response and mark processed.
2. **Check expiry** — if `expires_at < now`, discard without execution (AC9.2). Mark processed.
3. **Check cancel** — if `entry.id` is in `pendingCancels`, skip execution (AC7.3). Mark processed.
4. **Idempotency check** — if `idempotency_key` exists in cache and not expired, return cached response (AC5.1). If expired, remove from cache and proceed (AC5.3).
5. **Execute** — dispatch to kind-specific handler:
   - `tool_call` → resolve MCP client by tool name from `mcpClients` Map, call `client.callTool(toolName, args)`, capture `ToolResult`
   - `resource_read` → iterate clients, call `client.readResource(uri)`, capture `ResourceContent` (AC1.3)
   - `prompt_invoke` → resolve client by server name, call `client.invokePrompt(name, args)`, capture `PromptResult` (AC1.4)
   - `cache_warm` → read files from paths, return content (AC1.5). When the combined response exceeds `max_payload_bytes`, split into one result message per file (each under the limit, same `ref_id`). Mark the final chunk with `complete: true` in the payload so the requester knows reassembly is done.
6. **Write response** — write `result` or `error` outbox entry with `ref_id` = request ID
7. **Cache result** — if `idempotency_key` is set, store response in idempotency cache with 5-minute TTL
8. **Mark processed**

Tool name resolution: MCP commands are named `{serverName}-{toolName}`. Parse the tool name from `ToolCallPayload.tool` field, find the matching client in `mcpClients` Map by iterating clients and checking `client.listTools()`.

Response writing pattern:

```typescript
private writeResponse(
	requestEntry: RelayInboxEntry,
	kind: "result" | "error",
	payload: string,
): void {
	const now = new Date();
	writeOutbox(this.db, {
		id: crypto.randomUUID(),
		source_site_id: this.siteId,
		target_site_id: requestEntry.source_site_id,
		kind,
		ref_id: requestEntry.id,
		idempotency_key: null,
		payload,
		created_at: now.toISOString(),
		expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
	});
}
```

Cancel interaction with execution (AC7.4): If cancel arrives AFTER tool execution has already started or completed, the result is still written to outbox. The requester side (RELAY_WAIT in Phase 3) discards the result if it already cancelled. No special handling needed on the target side for this case.

**Testing:**

Tests must verify each AC:
- **mcp-relay.AC1.3:** Inbox entry with kind `resource_read` → processor calls `client.readResource(uri)` → writes result with resource content to outbox
- **mcp-relay.AC1.4:** Inbox entry with kind `prompt_invoke` → processor calls `client.invokePrompt()` → writes result to outbox
- **mcp-relay.AC1.5:** Inbox entry with kind `cache_warm` → processor reads file paths → writes content to outbox
- **mcp-relay.AC5.1:** Two inbox entries with same `idempotency_key` → first executes, second returns cached response without calling MCP client
- **mcp-relay.AC5.3:** Entry with `idempotency_key` processed → wait >5 min (advance clock) → same key re-executes
- **mcp-relay.AC7.3:** Cancel entry arrives first, then matching request → request skipped (not executed)
- **mcp-relay.AC7.4:** Tool execution completes, then cancel arrives → result already written, cancel is a no-op
- **mcp-relay.AC9.2:** Inbox entry with `expires_at` in the past → discarded without execution, marked processed

Additional tests:
- Unknown `source_site_id` (not in keyring) → error response written
- Unknown tool name → error response "tool not found"
- MCP client call fails with exception → error response with `retriable: true`

Use mock MCPClient objects that implement the methods with controllable returns. Test database with `applySchema()` and relay tables.

**Verification:**

Run: `bun test packages/agent`
Expected: All existing + new tests pass.

**Commit:** `feat(agent): implement relay inbox processing with validation, execution, and idempotency`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Add executeImmediate() to RelayProcessor

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (add public executeImmediate method)

**Implementation:**

Add an `executeImmediate()` public method to `RelayProcessor` that runs the same validation and execution pipeline as `processEntry()` but returns `RelayInboxEntry[]` directly instead of writing to the outbox. This enables hub-local execution to return results in the same sync response.

The method reuses the internal validation (keyring, expiry, cancel, idempotency) and execution logic, but collects results into an array rather than calling `writeResponse()`.

```typescript
public async executeImmediate(
	request: RelayOutboxEntry,
	hubSiteId: string,
): Promise<RelayInboxEntry[]> {
	// Same validation + execution as processEntry(), but returns results
	// instead of writing to outbox
}
```

**Important:** The `createRelayExecutor` factory that wires this method to the `RelayExecutor` callback type is NOT placed here (that would create a circular `sync -> agent` dependency). Instead, wiring happens in Task 4 (`start.ts` in `@bound/cli`, which imports both `@bound/agent` and `@bound/sync`).

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors.

**Commit:** `feat(agent): add executeImmediate() to RelayProcessor for hub-local execution`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Integrate RelayProcessor into startup sequence

**Files:**
- Modify: `packages/cli/src/commands/start.ts:230-677` (add relay processor startup)

**Implementation:**

Add `RelayProcessor` instantiation and startup to the bootstrap sequence in `start.ts`. Insert after MCP client creation (step 8, line ~269) and before web server setup (step 12, line ~411).

```typescript
// After MCP client creation (~line 269):
import { RelayProcessor } from "@bound/agent";
import { resolveRelayConfig } from "@bound/core";

const relayConfig = resolveRelayConfig(optionalConfigs.sync);
const relayProcessor = new RelayProcessor(
	db,
	siteId,
	mcpClientsMap,
	new Set(Object.keys(keyring.hosts)),
	logger,
	relayConfig,
);
const relayProcessorHandle = relayProcessor.start();
```

Create the `RelayExecutor` callback inline in `start.ts` (NOT in `@bound/sync` to avoid circular dependency). Import the `RelayExecutor` type from `@bound/sync` and wire it to the processor's `executeImmediate()` method:

```typescript
import type { RelayExecutor } from "@bound/sync";

const relayExecutor: RelayExecutor = async (request, hubSiteId) => {
	return relayProcessor.executeImmediate(request, hubSiteId);
};
// Pass relayExecutor to createSyncRoutes()
```

Add cleanup on SIGINT/SIGTERM alongside existing cleanup:

```typescript
// In shutdown handler (~line 697):
relayProcessorHandle.stop();
```

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No type errors.

Run: `bun packages/cli/src/bound.ts start --help` (or a smoke test)
Expected: No import errors.

**Commit:** `feat(cli): integrate RelayProcessor into startup sequence`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5) -->
<!-- START_TASK_5 -->
### Task 5: Relay processor tests

**Verifies:** mcp-relay.AC1.3, mcp-relay.AC1.4, mcp-relay.AC1.5, mcp-relay.AC5.1, mcp-relay.AC5.3, mcp-relay.AC7.3, mcp-relay.AC7.4, mcp-relay.AC9.2

**Files:**
- Create: `packages/agent/src/__tests__/relay-processor.test.ts` (unit)

**Testing:**

Create mock MCPClient instances that implement the key methods (`callTool`, `readResource`, `invokePrompt`, `listTools`) with controllable return values. Use temp database with `applySchema()` and relay tables.

Tests must verify each AC listed in the Verifies field above. See Task 2 testing section for specific test descriptions per AC.

Test structure:
- `describe("RelayProcessor")` with `beforeEach` creating fresh DB + processor instance
- `describe("validation")` — keyring check, expiry check (AC9.2)
- `describe("execution")` — tool_call, resource_read (AC1.3), prompt_invoke (AC1.4), cache_warm (AC1.5)
- `describe("idempotency")` — cache hit (AC5.1), cache expiry (AC5.3)
- `describe("cancel handling")` — cancel before execution (AC7.3), cancel after execution (AC7.4)

For AC5.3 (cache TTL expiry), use `Date.now()` mocking or set the cache entry's `expiresAt` to a past timestamp manually.

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-processor.test.ts`
Expected: All tests pass.

Run: `bun test packages/agent`
Expected: All existing + new tests pass.

**Commit:** `test(agent): add relay processor tests for execution, idempotency, cancel, and validation`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_C -->
