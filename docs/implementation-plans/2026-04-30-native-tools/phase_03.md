# Native Agent Tools Implementation Plan — Phase 3

**Goal:** Implement the 3 grouped native tools (memory, cache, skill) with `action` parameters that consolidate multiple related commands into single tools.

**Architecture:** Each grouped tool uses an `action` enum to dispatch to the correct handler. Memory consolidates 7 subcommands (store, forget, search, connect, disconnect, traverse, neighbors) from `memory.ts`. Cache consolidates 4 commands (warm, pin, unpin, evict) from separate `cache-*.ts` files. Skill consolidates 4 commands (activate, list, read, retire) from separate `skill-*.ts` files. Each factory returns a `RegisteredTool` with `kind: "builtin"` and an `execute` handler that switches on the `action` parameter.

**Tech Stack:** TypeScript, bun:test, @bound/agent, @bound/core, @bound/shared, @bound/sandbox (IFileSystem for skill-activate)

**Scope:** 6 phases from original design (phase 3 of 6)

**Codebase verified:** 2026-04-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### native-tools.AC3: Grouped agent tools dispatch by action
- **native-tools.AC3.1 Success:** `memory` tool with `action: "store"` persists a memory entry via outbox
- **native-tools.AC3.2 Success:** `memory` tool with `action: "search"` returns matching memories
- **native-tools.AC3.3 Success:** `cache` tool with each of 4 actions (warm, pin, unpin, evict) produces correct behavior
- **native-tools.AC3.4 Success:** `skill` tool with each of 4 actions (activate, list, read, retire) produces correct behavior
- **native-tools.AC3.5 Failure:** Invalid action value returns descriptive error listing valid actions
- **native-tools.AC3.6 Failure:** Missing action-specific required params return descriptive error

---

<!-- START_TASK_1 -->
### Task 1: Add fs field to ToolContext

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/cli/src/commands/start/agent-factory.ts`

**Implementation:**

Add an optional `fs` field to `ToolContext` in `packages/agent/src/types.ts`:

```typescript
export interface ToolContext {
	db: import("bun:sqlite").Database;
	siteId: string;
	eventBus: import("@bound/shared").TypedEventEmitter;
	logger: { debug: (...args: unknown[]) => void; info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
	threadId?: string;
	taskId?: string;
	modelRouter?: import("@bound/llm").ModelRouter;
	fs?: import("just-bash").IFileSystem; // type-only import; follows existing pattern in built-in-tools.ts:2
}
```

In `agent-factory.ts`, pass `clusterFsObj?.fs` when constructing the `ToolContext`:

```typescript
const toolCtx: ToolContext = {
	// ... existing fields ...
	fs: clusterFsObj?.fs,
};
```

**Verification:**
Run: `tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit`
Expected: Clean typecheck

**Commit:** `feat(agent): add fs field to ToolContext for skill-activate`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: Implement memory tool

**Verifies:** native-tools.AC3.1, native-tools.AC3.2, native-tools.AC3.5, native-tools.AC3.6

**Files:**
- Create: `packages/agent/src/tools/memory.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port all 7 subcommand handlers from `packages/agent/src/commands/memory.ts` (492 lines) into a single `createMemoryTool(ctx: ToolContext): RegisteredTool` factory.

Tool definition:

```typescript
parameters: {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["store", "forget", "search", "connect", "disconnect", "traverse", "neighbors"],
			description: "Memory operation to perform",
		},
		key: { type: "string", description: "Memory key (for store, forget, search, traverse, neighbors)" },
		value: { type: "string", description: "Memory value (for store)" },
		source_tag: { type: "string", description: "Provenance tag (for store; defaults to task/thread/agent)" },
		tier: { type: "string", enum: ["pinned", "summary", "default", "detail"], description: "Memory tier (for store)" },
		prefix: { type: "string", description: "Key prefix for batch forget" },
		source_key: { type: "string", description: "Source memory key (for connect, disconnect)" },
		target_key: { type: "string", description: "Target memory key (for connect, disconnect)" },
		relation: { type: "string", description: "Edge relation type from CANONICAL_RELATIONS (for connect, disconnect)" },
		weight: { type: "number", description: "Edge weight 0-10 (for connect; default 1.0)" },
		context: { type: "string", description: "Free-text context phrase (for connect)" },
		depth: { type: "integer", description: "Traversal depth 1-3 (for traverse; default 2)" },
		direction: { type: "string", enum: ["out", "in", "both"], description: "Neighbor direction (for neighbors; default 'both')" },
	},
	required: ["action"],
}
```

The execute handler dispatches on `action`:
- **store**: Requires `key` and `value`. Auto-resolves tier from pinned prefixes (`_standing:`, `_feedback:`, `_policy:`, `_pinned:`). Uses `deterministicUUID(BOUND_NAMESPACE, key)`. Checks for existing entry, updates or inserts via outbox helpers. Source tag defaults to `ctx.taskId ?? ctx.threadId ?? "agent"`.
- **forget**: Requires `key` or `prefix`. Exact key mode: soft-deletes entry + cascade edge deletes. Summary tier entries promote detail children to default. Prefix mode: batch soft-delete + cascade.
- **search**: Requires `key` (used as query). Tokenizes to keywords (≥3 chars, excluding stop words), builds dynamic LIKE SQL, returns formatted results.
- **connect**: Requires `source_key`, `target_key`, `relation`. Validates both keys exist. Calls `upsertEdge()` from `packages/agent/src/graph-queries.ts`. For "summarizes" edges, promotes target to detail tier.
- **disconnect**: Requires `source_key`, `target_key`. Optional `relation`. Calls `removeEdges()`. Handles summarizes demotion.
- **traverse**: Requires `key`. Optional `depth` (1-3, default 2) and `relation`. Calls `traverseGraph()`.
- **neighbors**: Requires `key`. Optional `direction` (out/in/both, default "both"). Calls `getNeighbors()`.

Import graph query helpers from `packages/agent/src/graph-queries.ts`: `upsertEdge`, `removeEdges`, `traverseGraph`, `getNeighbors`, `cascadeDeleteEdges`.

Import `deterministicUUID`, `BOUND_NAMESPACE` from `@bound/shared`.

Register in `createAgentTools()`.

**Testing:**
Tests must verify:
- **native-tools.AC3.1:** Call memory with `action: "store"`, `key: "test_key"`, `value: "test_value"` — row exists in semantic_memory
- **native-tools.AC3.2:** Store a memory, then call `action: "search"` with `key: "test"` — returns the stored memory
- **native-tools.AC3.5:** Call with `action: "invalid"` — returns error listing valid actions
- **native-tools.AC3.6:** Call `action: "store"` without `key` — returns descriptive error
- Connect two memories with `action: "connect"` — edge exists in memory_edges
- Forget a memory with `action: "forget"` — entry soft-deleted, edges cascaded

Follow existing test patterns: real temp SQLite DB with `applySchema(db)`.

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/memory.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native memory tool with 7 action variants`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Implement cache tool

**Verifies:** native-tools.AC3.3, native-tools.AC3.5, native-tools.AC3.6

**Files:**
- Create: `packages/agent/src/tools/cache.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Consolidate 4 cache commands (`cache-warm.ts`, `cache-pin.ts`, `cache-unpin.ts`, `cache-evict.ts`) into a single `createCacheTool(ctx: ToolContext): RegisteredTool` factory.

Tool definition:

```typescript
parameters: {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["warm", "pin", "unpin", "evict"],
			description: "Cache operation to perform",
		},
		path: { type: "string", description: "File path (for pin, unpin)" },
		pattern: { type: "string", description: "Glob pattern (for warm, evict)" },
	},
	required: ["action"],
}
```

The execute handler dispatches on `action`:
- **warm**: Returns informational message (not yet implemented, matches existing stub in `cache-warm.ts`)
- **pin**: Requires `path`. Verifies file exists in `files` table. Reads `pinned_files` from `cluster_config`, appends path if not present, writes back. Uses the same `updateClusterConfig` pattern from `cache-pin.ts` (raw INSERT/ON CONFLICT with manual change-log entry — this is an intentional exception to the outbox rule per the known bypasses list in memory).
- **unpin**: Requires `path`. Verifies file exists. Reads `pinned_files`, removes path, writes back. Returns error if path was not pinned.
- **evict**: Requires `pattern`. Converts glob to SQL LIKE (`*` → `%`, `?` → `_`). Queries matching files. Soft-deletes each via `softDelete()`.

Port `updateClusterConfig()` helper inline (from `cache-pin.ts` lines 10-29). This helper does raw SQL with manual change-log entry because `cluster_config` uses `key` as PK (not `id`), and uses INSERT/ON CONFLICT pattern.

Register in `createAgentTools()`.

**Testing:**
Tests must verify:
- **native-tools.AC3.3:** 
  - `action: "warm"` — returns informational message (no error)
  - `action: "pin"` with seeded file — `pinned_files` in cluster_config contains the path
  - `action: "unpin"` after pin — path removed from cluster_config
  - `action: "evict"` with seeded files matching pattern — files soft-deleted
- **native-tools.AC3.5:** Call with `action: "unknown"` — returns error listing valid actions
- **native-tools.AC3.6:** Call `action: "pin"` without `path` — returns descriptive error

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/cache.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native cache tool with 4 action variants`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: Implement skill tool

**Verifies:** native-tools.AC3.4, native-tools.AC3.5, native-tools.AC3.6

**Files:**
- Create: `packages/agent/src/tools/skill.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Consolidate 4 skill commands (`skill-activate.ts`, `skill-list.ts`, `skill-read.ts`, `skill-retire.ts`) into a single `createSkillTool(ctx: ToolContext): RegisteredTool` factory.

Tool definition:

```typescript
parameters: {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["activate", "list", "read", "retire"],
			description: "Skill operation to perform",
		},
		name: { type: "string", description: "Skill name (for activate, read, retire)" },
		status: { type: "string", enum: ["active", "retired"], description: "Filter by status (for list)" },
		verbose: { type: "boolean", description: "Show extra columns (for list)" },
		reason: { type: "string", description: "Reason for retiring (for retire)" },
	},
	required: ["action"],
}
```

The execute handler dispatches on `action`:

- **activate**: Requires `name` and `ctx.fs`. Port full logic from `skill-activate.ts` (lines 49-241):
  1. Validate name format (regex `/^[a-z0-9]+(-[a-z0-9]+)*$/`, max 64 chars)
  2. Read `SKILL.md` from VFS at `/home/user/skills/{name}/SKILL.md`
  3. Validate file size (≤64KB), parse frontmatter via `parseFrontmatter()`
  4. Validate description present and ≤1024 chars, body ≤500 lines
  5. Check active skill cap (MAX_ACTIVE_SKILLS = 20)
  6. Persist all skill files to `files` table (hash-compare, insert/update)
  7. Upsert `skills` row with metadata (activation_count++, timestamps)
  - Import `parseFrontmatter()` from the existing `skill-activate.ts` module (it's already exported)

- **list**: Port from `skill-list.ts`. Optional `status` filter. Query skills, format as fixed-width table. Optional `verbose` mode with extra columns.

- **read**: Requires `name`. Port from `skill-read.ts`. Query skill metadata + SKILL.md content from files table. Return formatted header + content.

- **retire**: Requires `name`. Port from `skill-retire.ts`. Update skill status to "retired". Scan tasks for payload references, create advisories for matching tasks. Optional `reason`.

Register in `createAgentTools()`.

**Testing:**
Tests must verify:
- **native-tools.AC3.4:**
  - `action: "activate"` with InMemoryFs containing valid SKILL.md — skill row created in DB
  - `action: "list"` after activation — returns table with skill name
  - `action: "read"` — returns skill metadata + content
  - `action: "retire"` — skill status changed to "retired"
- **native-tools.AC3.5:** Call with `action: "garbage"` — returns error listing valid actions
- **native-tools.AC3.6:** Call `action: "activate"` without `name` — returns descriptive error; call `action: "activate"` without `ctx.fs` — returns descriptive error about filesystem

Set up tests with `InMemoryFs` from `just-bash`. Write valid SKILL.md content with frontmatter for activate tests.

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/skill.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native skill tool with 4 action variants`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Update createAgentTools with all 14 tools and verify

**Verifies:** native-tools.AC1.4

**Files:**
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Ensure `createAgentTools()` now includes all 14 tool factories (11 standalone from Phase 2 + 3 grouped from this phase):

```typescript
export function createAgentTools(ctx: ToolContext): RegisteredTool[] {
	return [
		// Standalone (Phase 2)
		createScheduleTool(ctx),
		createCancelTool(ctx),
		createQueryTool(ctx),
		createEmitTool(ctx),
		createAwaitEventTool(ctx),
		createPurgeTool(ctx),
		createAdvisoryTool(ctx),
		createNotifyTool(ctx),
		createArchiveTool(ctx),
		createModelHintTool(ctx),
		createHostinfoTool(ctx),
		// Grouped (Phase 3)
		createMemoryTool(ctx),
		createCacheTool(ctx),
		createSkillTool(ctx),
	];
}
```

Update the existing index test (from Phase 2 Task 14) to verify 14 tools total.

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/index.test.ts`
Expected: 14 tools registered

**Commit:** `feat(agent): register all 14 native agent tools (11 standalone + 3 grouped)`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_6 -->
### Task 6: Verify full test suite passes

**Files:** None (verification only)

**Verification:**
Run: `bun test --recursive`
Expected: Exit code 0, no new failures

Run: `tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit`
Expected: Clean typecheck

**Commit:** No commit — verification only. Fix any regressions before proceeding.
<!-- END_TASK_6 -->
