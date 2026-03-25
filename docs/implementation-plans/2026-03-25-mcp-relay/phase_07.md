# MCP Relay Transport — Phase 7: Metrics & Config

**Goal:** Observability for relay operations — record per-turn relay metadata, cycle-level metrics, pruning for bounded storage, and updated commands display with LOCAL/REMOTE tiers.

**Architecture:** Extend the existing `turns` table with optional `relay_target` and `relay_latency_ms` columns. Create a new `relay_cycles` metrics table for detailed per-message tracking. Instrument RELAY_WAIT (Phase 3) and the inbox processor (Phase 4) to record metrics. Add 30-day pruning for `relay_cycles` alongside existing change_log pruning. Update the `commands` command to show LOCAL and REMOTE tool tiers.

**Tech Stack:** bun:sqlite, TypeScript

**Scope:** 8 phases from original design (phase 7 of 8)

**Codebase verified:** 2026-03-25

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-relay.AC8: Metrics & observability
- **mcp-relay.AC8.1 Success:** Relayed tool calls record `relay_target` and `relay_latency_ms` on turns
- **mcp-relay.AC8.2 Success:** Local tool calls have NULL `relay_target` and `relay_latency_ms`
- **mcp-relay.AC8.3 Success:** `relay_cycles` records every relay message with direction, peer, kind
- **mcp-relay.AC8.4 Success:** `relay_cycles` pruned after 30 days
- **mcp-relay.AC8.5 Success:** `commands` command shows LOCAL and REMOTE (via relay) tiers

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add turns columns and relay_cycles table

**Files:**
- Modify: `packages/core/src/metrics-schema.ts:15-27` (add ALTER TABLE for turns columns)
- Modify: `packages/core/src/schema.ts` (add relay_cycles table alongside relay_outbox/relay_inbox)

**Implementation:**

Add `relay_target` and `relay_latency_ms` columns to the existing `turns` table in `applyMetricsSchema()`. Create the `relay_cycles` table in `applySchema()` (alongside relay_outbox and relay_inbox) to ensure it exists before the relay processor starts — this avoids bootstrap ordering issues since `applySchema()` runs before `applyMetricsSchema()` and before any background loops.

Add to `applyMetricsSchema()` for the turns column additions:

```typescript
// Add relay columns to turns (idempotent — no-op if already exists)
try {
	db.run("ALTER TABLE turns ADD COLUMN relay_target TEXT");
} catch {
	// Column already exists
}
try {
	db.run("ALTER TABLE turns ADD COLUMN relay_latency_ms INTEGER");
} catch {
	// Column already exists
}

```

Add to `applySchema()` in `packages/core/src/schema.ts` (after the relay_inbox table from Phase 1):

```typescript
// Relay cycles metrics table (non-synced, alongside other relay tables)
db.run(`
	CREATE TABLE IF NOT EXISTS relay_cycles (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		direction TEXT NOT NULL,
		peer_site_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		delivery_method TEXT NOT NULL,
		latency_ms INTEGER,
		expired INTEGER NOT NULL DEFAULT 0,
		success INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	) STRICT
`);

db.run(`
	CREATE INDEX IF NOT EXISTS idx_relay_cycles_created
	ON relay_cycles(created_at)
`);
```

The `direction` column is `"outbound"` (we sent a message) or `"inbound"` (we received one). The `delivery_method` column is `"sync"` or `"eager_push"`.

**Verification:**

Run: `bun test packages/core/src/__tests__/schema.test.ts`
Expected: All tests pass (idempotent schema application).

**Commit:** `feat(core): add relay_target/relay_latency_ms to turns and relay_cycles table`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add relay_cycles CRUD and pruning

**Files:**
- Create: `packages/core/src/relay-metrics.ts`
- Modify: `packages/core/src/index.ts` (add exports)

**Implementation:**

Create helpers for recording relay cycles and pruning old entries:

```typescript
import type { Database } from "bun:sqlite";

export interface RelayCycleEntry {
	direction: "outbound" | "inbound";
	peer_site_id: string;
	kind: string;
	delivery_method: "sync" | "eager_push";
	latency_ms: number | null;
	expired: boolean;
	success: boolean;
}

export function recordRelayCycle(
	db: Database,
	entry: RelayCycleEntry,
): void {
	db.run(
		`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, expired, success, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			entry.direction,
			entry.peer_site_id,
			entry.kind,
			entry.delivery_method,
			entry.latency_ms,
			entry.expired ? 1 : 0,
			entry.success ? 1 : 0,
			new Date().toISOString(),
		],
	);
}

export function recordTurnRelayMetrics(
	db: Database,
	turnId: number,
	relayTarget: string,
	relayLatencyMs: number,
): void {
	db.run(
		"UPDATE turns SET relay_target = ?, relay_latency_ms = ? WHERE id = ?",
		[relayTarget, relayLatencyMs, turnId],
	);
}

export function pruneRelayCycles(
	db: Database,
	retentionDays: number = 30,
): number {
	const cutoff = new Date(
		Date.now() - retentionDays * 24 * 60 * 60 * 1000,
	).toISOString();
	const result = db.run(
		"DELETE FROM relay_cycles WHERE created_at < ?",
		[cutoff],
	);
	return result.changes;
}
```

Export from `packages/core/src/index.ts`.

**Verification:**

Run: `tsc -p packages/core --noEmit`
Expected: No type errors.

**Commit:** `feat(core): add relay cycle recording, turn metrics, and 30-day pruning`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Instrument RELAY_WAIT and inbox processor with metrics

**Verifies:** mcp-relay.AC8.1, mcp-relay.AC8.2, mcp-relay.AC8.3

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (record turn relay metrics in RELAY_WAIT path)
- Modify: `packages/agent/src/relay-processor.ts` (record relay cycles on inbox processing)
- Modify: `packages/sync/src/sync-loop.ts` (record relay cycles on outbound send/receive)

**Implementation:**

**Agent loop (RELAY_WAIT path):** After RELAY_WAIT completes and the response is received, record the relay metadata on the current turn:

```typescript
// After relay response received:
const latencyMs = Date.now() - relayStartTime;
recordTurnRelayMetrics(db, currentTurnId, targetHostName, latencyMs);
```

Local tool calls do not call `recordTurnRelayMetrics()`, so `relay_target` and `relay_latency_ms` remain NULL (AC8.2).

**Sync loop (relay phase):** Record `relay_cycles` for each outbound message sent and each inbound message received during the relay sync phase:

```typescript
// After sending outbox entries:
for (const entry of entriesToSend) {
	recordRelayCycle(db, {
		direction: "outbound",
		peer_site_id: entry.target_site_id,
		kind: entry.kind,
		delivery_method: "sync",
		latency_ms: null,
		expired: false,
		success: true,
	});
}

// After receiving inbox entries:
for (const entry of relayResponse.relay_inbox) {
	recordRelayCycle(db, {
		direction: "inbound",
		peer_site_id: entry.source_site_id,
		kind: entry.kind,
		delivery_method: "sync",
		latency_ms: null,
		expired: false,
		success: true,
	});
}
```

**Inbox processor:** Record cycles when processing entries (with execution timing):

```typescript
// After executing an inbox entry:
recordRelayCycle(db, {
	direction: "inbound",
	peer_site_id: entry.source_site_id,
	kind: entry.kind,
	delivery_method: "sync", // or "eager_push" if tracking delivery method
	latency_ms: executionMs,
	expired: false,
	success: !isError,
});
```

**Eager push (hub-side):** Record cycles when pushing to spokes:

```typescript
// In eagerPushToSpoke():
recordRelayCycle(db, {
	direction: "outbound",
	peer_site_id: targetSiteId,
	kind: entries[0].kind,
	delivery_method: "eager_push",
	latency_ms: pushLatencyMs,
	expired: false,
	success: pushSucceeded,
});
```

**Testing:**

Tests must verify:
- **mcp-relay.AC8.1:** After a relay tool call completes, the turns row has non-null `relay_target` and `relay_latency_ms`
- **mcp-relay.AC8.2:** After a local tool call completes, the turns row has NULL `relay_target` and `relay_latency_ms`
- **mcp-relay.AC8.3:** After sending/receiving relay messages, `relay_cycles` table has rows with correct `direction`, `peer_site_id`, `kind`

**Verification:**

Run: `bun test packages/agent && bun test packages/sync`
Expected: All existing + new tests pass.

**Commit:** `feat(agent,sync): instrument relay operations with cycle and turn metrics`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Add relay_cycles pruning to pruning loop

**Verifies:** mcp-relay.AC8.4

**Files:**
- Modify: `packages/sync/src/pruning.ts:59-86` (add relay_cycles pruning alongside change_log pruning)

**Implementation:**

Add `pruneRelayCycles()` call alongside the existing `pruneChangeLog()` in `startPruningLoop()`. The pruning loop uses `setInterval` (not `setTimeout` recursion). Insert the call inside the `setInterval` callback, after the existing `pruneChangeLog(db, mode, logger)` call (after line 74 of pruning.ts):

```typescript
import { pruneRelayCycles } from "@bound/core";

// Inside the setInterval callback, after pruneChangeLog():
const relayCyclesPruned = pruneRelayCycles(db, 30);
if (relayCyclesPruned > 0) {
	logger.debug("Pruned relay cycles", { count: relayCyclesPruned });
}
```

**Testing:**

Tests must verify:
- **mcp-relay.AC8.4:** Insert relay_cycles entries with `created_at` older than 30 days → call `pruneRelayCycles(db, 30)` → old entries deleted, recent entries kept

**Verification:**

Run: `bun test packages/sync && bun test packages/core`
Expected: All existing + new tests pass.

**Commit:** `feat(sync): add relay_cycles 30-day pruning to pruning loop`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Update commands command with LOCAL/REMOTE tiers

**Verifies:** mcp-relay.AC8.5

**Files:**
- Modify: `packages/agent/src/commands/help.ts:64-88` (add REMOTE tier for relay tools)

**Implementation:**

Update the `commands` command handler to categorize tools into three tiers:
1. **Built-in:** Commands without hyphens (or `cache-`/`model-` prefixed) — same as current
2. **LOCAL (MCP):** MCP tools available on this host
3. **REMOTE (via relay):** MCP tools only available on remote hosts via relay

The distinction between LOCAL and REMOTE is based on whether the tool is served by a local MCP client or by a remote host's MCP tools (discovered via `hosts.mcp_tools`).

The current implementation at lines 66-84 splits commands into `builtins` and `mcpTools`. Update to split `mcpTools` further:

```typescript
// Get local MCP tool names from the MCPClient map
const localMcpToolNames = new Set<string>();
for (const [serverName, client] of mcpClients) {
	const tools = await client.listTools();
	for (const tool of tools) {
		localMcpToolNames.add(`${serverName}-${tool.name}`);
	}
}

// Categorize
const builtins = allCommands.filter(/* existing logic */);
const localMcp = allCommands.filter(
	(c) => !builtins.includes(c) && localMcpToolNames.has(c.name),
);
const remoteMcp = allCommands.filter(
	(c) => !builtins.includes(c) && !localMcpToolNames.has(c.name),
);
```

Output format:

```
Built-in:
  commands, hostinfo, cache-read, ...

LOCAL (MCP):
  myserver-mytool  — Description here
  ...

REMOTE (via relay):
  remoteserver-remotetool  — Description here [host: spoke-a]
  ...
```

The commands handler needs access to the MCP clients Map. Pass it via CommandContext or closure.

**Testing:**

Tests must verify:
- **mcp-relay.AC8.5:** Output includes "LOCAL (MCP)" section for locally-available tools and "REMOTE (via relay)" section for relay-only tools. Built-in commands appear in "Built-in" section.

**Verification:**

Run: `bun test packages/agent`
Expected: All existing + new tests pass.

**Commit:** `feat(agent): update commands command with LOCAL and REMOTE (via relay) tiers`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Metrics tests

**Verifies:** mcp-relay.AC8.1, mcp-relay.AC8.2, mcp-relay.AC8.3, mcp-relay.AC8.4, mcp-relay.AC8.5

**Files:**
- Create: `packages/core/src/__tests__/relay-metrics.test.ts` (unit)

**Testing:**

Use temp database with `applySchema()` and `applyMetricsSchema()`.

- **mcp-relay.AC8.1:** Call `recordTurnRelayMetrics(db, turnId, "spoke-a", 150)` → query turns → `relay_target = "spoke-a"`, `relay_latency_ms = 150`
- **mcp-relay.AC8.2:** Insert a turn without relay metrics → query turns → `relay_target` is NULL, `relay_latency_ms` is NULL
- **mcp-relay.AC8.3:** Call `recordRelayCycle()` with various entries → query relay_cycles → verify direction, peer, kind, delivery_method fields
- **mcp-relay.AC8.4:** Insert cycles with old `created_at` (>30 days) and recent `created_at` → call `pruneRelayCycles()` → old entries deleted, recent entries remain
- **mcp-relay.AC8.5:** (Tested in commands command test — see Task 5)

**Verification:**

Run: `bun test packages/core/src/__tests__/relay-metrics.test.ts`
Expected: All tests pass.

Run: `bun test packages/core`
Expected: All existing + new tests pass.

**Commit:** `test(core): add relay metrics recording and pruning tests`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->
