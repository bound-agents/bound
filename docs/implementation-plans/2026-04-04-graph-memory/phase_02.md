# Graph Memory Implementation Plan — Phase 2: Command Consolidation

**Goal:** Unify `memorize`, `forget`, and graph commands under a single `memory` command with subcommand dispatch, then remove the old standalone commands.

**Architecture:** The `memory` command (created in Phase 1 with `connect`/`disconnect`) gains three new subcommands: `store` (replacing `memorize`), `forget` (replacing standalone `forget`), and `search` (keyword search across keys/values). The old `memorize.ts` and `forget.ts` files are deleted. Tool definitions in context-assembly.ts are updated.

**Tech Stack:** TypeScript, bun:sqlite, `@bound/core` (insertRow/updateRow/softDelete), `@bound/shared` (deterministicUUID)

**Scope:** 5 phases from original design (phase 2 of 5)

**Codebase verified:** 2026-04-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### graph-memory.AC2: Unified memory command
- **graph-memory.AC2.1 Success:** `memory store` creates/updates memories (same behavior as old `memorize`)
- **graph-memory.AC2.2 Success:** `memory forget` soft-deletes memories (same behavior as old `forget`)
- **graph-memory.AC2.3 Success:** `memory search` returns keyword-matched entries across keys and values
- **graph-memory.AC2.4 Success:** All 7 subcommands registered under single `memory` command
- **graph-memory.AC2.5 Failure:** Unknown subcommand returns usage hint
- **graph-memory.AC2.6 Edge:** `memory store` on soft-deleted key restores it (existing behavior preserved)

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add store, forget, and search subcommands to memory.ts

**Verifies:** graph-memory.AC2.1, graph-memory.AC2.2, graph-memory.AC2.3, graph-memory.AC2.5, graph-memory.AC2.6

**Files:**
- Modify: `packages/agent/src/commands/memory.ts` (add store, forget, search handlers; update switch statement and args)

**Implementation:**

Add three new handler functions to `memory.ts` and wire them into the existing switch statement. The `store` handler replicates the logic from `memorize.ts`. The `forget` handler replicates the logic from `forget.ts`. The `search` handler implements keyword search following the pattern from `summary-extraction.ts` keyword extraction.

Add these imports to the top of `memory.ts`:

```typescript
import { insertRow, softDelete, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
```

Add a comment block documenting the positional arg mapping per subcommand:

```typescript
// Positional arg mapping for the memory command (args are Record<string, string>):
// - store:      source=key, target=value, source_tag=provenance
// - forget:     source=key, prefix=prefix_filter
// - search:     source=query_text
// - connect:    source=src_key, target=tgt_key, relation=relation_type
// - disconnect: source=src_key, target=tgt_key, relation=optional_filter
// - traverse:   source=start_key, depth=max_depth, relation=optional_filter
// - neighbors:  source=key, dir=direction_filter
```

Add `handleStore` function:

```typescript
function handleStore(args: Record<string, string>, ctx: CommandContext) {
    const key = args.key || args.source; // 'source' positional becomes 'key' in subcommand context
    const value = args.value || args.target; // positional mapping
    if (!key || !value) {
        return commandError("usage: memory store <key> <value> [--source_tag S]");
    }
    const source = args.source_tag || ctx.taskId || ctx.threadId || "agent";
    const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
    const now = new Date().toISOString();

    // bun:sqlite .get() returns null (not undefined) when no row found.
    // Note: The existing memorize.ts incorrectly typed .get() as `| undefined`.
    // We correct this to `| null` per the bun:sqlite invariant documented in CLAUDE.md.
    const existing = ctx.db
        .prepare("SELECT id, deleted FROM semantic_memory WHERE key = ?")
        .get(key) as { id: string; deleted: number } | null;

    if (existing) {
        updateRow(
            ctx.db,
            "semantic_memory",
            memoryId,
            { value, source, last_accessed_at: now, deleted: 0 },
            ctx.siteId,
        );
    } else {
        insertRow(
            ctx.db,
            "semantic_memory",
            {
                id: memoryId,
                key,
                value,
                source,
                created_at: now,
                modified_at: now,
                last_accessed_at: now,
                deleted: 0,
            },
            ctx.siteId,
        );
    }

    return commandSuccess(`Memory saved: ${key}\n`);
}
```

Add `handleForget` function:

```typescript
function handleForget(args: Record<string, string>, ctx: CommandContext) {
    if (args.prefix) {
        const prefix = args.prefix;
        const entries = ctx.db
            .prepare("SELECT id, key FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
            .all(`${prefix}%`) as Array<{ id: string; key: string }>;

        if (entries.length === 0) {
            return commandSuccess(`No memories found with prefix: ${prefix}\n`);
        }

        for (const entry of entries) {
            softDelete(ctx.db, "semantic_memory", entry.id, ctx.siteId);
        }

        return commandSuccess(`Deleted ${entries.length} memories with prefix: ${prefix}\n`);
    }

    const key = args.key || args.source; // positional mapping
    if (!key) {
        return commandError("usage: memory forget <key> [--prefix P]");
    }

    const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
    // bun:sqlite .get() returns null (not undefined) when no row found
    const existing = ctx.db
        .prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
        .get(key) as { id: string } | null;

    if (!existing) {
        return commandError(`Memory not found: ${key}`);
    }

    softDelete(ctx.db, "semantic_memory", memoryId, ctx.siteId);
    return commandSuccess(`Memory deleted: ${key}\n`);
}
```

Add `handleSearch` function.

**Note on STOP_WORDS:** The `summary-extraction.ts` keyword extraction uses a shorter set of ~40 stop words. This `memory search` command uses a broader set (~100 words) because it is user-facing and benefits from more aggressive filtering. For consistency, consider extracting a shared `STOP_WORDS` constant to a utility module (e.g., `packages/agent/src/keywords.ts`) that both `memory search` and `graphSeededRetrieval` can import. At minimum, use the same set from `summary-extraction.ts` to ensure search results align with context assembly behavior. The implementer should check the actual STOP_WORDS in `summary-extraction.ts` (lines 383-391) and use that set rather than the expanded one shown below:

```typescript
const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "and", "but", "or", "nor", "not", "so", "yet", "both",
    "each", "few", "more", "most", "other", "some", "such", "no",
    "only", "own", "same", "than", "too", "very", "just", "because",
    "i", "me", "my", "we", "our", "you", "your", "it", "its", "that",
    "this", "these", "those", "what", "which", "who", "whom",
]);

function handleSearch(args: Record<string, string>, ctx: CommandContext) {
    const queryText = args.query || args.source; // positional mapping
    if (!queryText) {
        return commandError("usage: memory search <query>");
    }

    const keywords = queryText
        .toLowerCase()
        .replace(/[^a-z0-9_\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

    if (keywords.length === 0) {
        return commandSuccess("No searchable keywords found in query.\n");
    }

    const likeConditions = keywords.map(
        () => "(LOWER(key) LIKE '%' || ? || '%' OR LOWER(value) LIKE '%' || ? || '%')",
    );
    const params = keywords.flatMap((kw) => [kw, kw]);

    const results = ctx.db
        .prepare(
            `SELECT key, value, source, modified_at FROM semantic_memory
             WHERE deleted = 0 AND (${likeConditions.join(" OR ")})
             ORDER BY modified_at DESC LIMIT 20`,
        )
        .all(...params) as Array<{
            key: string;
            value: string;
            source: string | null;
            modified_at: string;
        }>;

    if (results.length === 0) {
        return commandSuccess(`No memories matched: ${queryText}\n`);
    }

    const lines = results.map(
        (r) => `- ${r.key}: ${r.value.substring(0, 100)}${r.value.length > 100 ? "..." : ""} [${r.source || "unknown"}]`,
    );
    return commandSuccess(`Found ${results.length} memories:\n${lines.join("\n")}\n`);
}
```

Update the `args` array in the `memory` CommandDefinition to include all possible arguments:

```typescript
args: [
    { name: "subcommand", required: true, description: "Subcommand: store, forget, search, connect, disconnect" },
    { name: "source", required: false, description: "First positional arg (key/source_key/query)" },
    { name: "target", required: false, description: "Second positional arg (value/target_key)" },
    { name: "relation", required: false, description: "Relation type (for connect/disconnect)" },
    { name: "weight", required: false, description: "Edge weight (for connect)" },
    { name: "prefix", required: false, description: "Prefix for batch forget" },
    { name: "source_tag", required: false, description: "Source tag for store provenance" },
],
```

Update the switch statement to include the new subcommands:

```typescript
switch (args.subcommand) {
    case "store":
        return handleStore(args, ctx);
    case "forget":
        return handleForget(args, ctx);
    case "search":
        return handleSearch(args, ctx);
    case "connect":
        return handleConnect(args, ctx);
    case "disconnect":
        return handleDisconnect(args, ctx);
    default:
        return commandError(
            `unknown subcommand: ${args.subcommand}. Available: store, forget, search, connect, disconnect`,
        );
}
```

**Testing:**
Tests in Task 3 verify all listed ACs.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add store, forget, search subcommands to memory command`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Remove memorize.ts and forget.ts, update index.ts and context-assembly.ts, migrate tests

**Verifies:** graph-memory.AC2.4

**Files:**
- Modify: `packages/agent/src/__tests__/commands.test.ts` (update imports FIRST, before deleting source files)
- Delete: `packages/agent/src/commands/memorize.ts`
- Delete: `packages/agent/src/commands/forget.ts`
- Modify: `packages/agent/src/commands/index.ts` (remove memorize/forget imports, keep only memory)
- Modify: `packages/agent/src/context-assembly.ts` (update AVAILABLE_COMMANDS, replacing `memorize` and `forget` entries in the array near line 241)

**Implementation:**

**IMPORTANT: Update test imports BEFORE deleting source files to avoid intermediate broken state.**

**Step 1: Update test file imports.**

In `packages/agent/src/__tests__/commands.test.ts`, replace the import of `memorize` and `forget` with `memory`:
```typescript
// OLD:
// import { memorize } from "../commands/memorize";
// import { forget } from "../commands/forget";

// NEW:
import { memory } from "../commands";
```

**Step 2: Delete `memorize.ts` and `forget.ts`.**

Delete `packages/agent/src/commands/memorize.ts` and `packages/agent/src/commands/forget.ts`.

**Step 3: Update `index.ts`.**

In `packages/agent/src/commands/index.ts`:

Remove the imports for memorize and forget. The `memory` import from Phase 1 remains.

Update `getAllCommands()` to remove `memorize` and `forget`, keeping only `memory`:

```typescript
export function getAllCommands(): CommandDefinition[] {
    return [
        help,
        query,
        advisory,
        memory,  // replaces memorize + forget
        schedule,
        cancel,
        emit,
        purge,
        awaitCmd,
        cacheWarm,
        cachePin,
        cacheUnpin,
        cacheEvict,
        modelHint,
        archive,
        hostinfo,
        skillActivate,
        skillList,
        skillRead,
        skillRetire,
    ];
}
```

Update the named exports block — remove `memorize` and `forget`, keep `memory`.

**Step 4: Update `context-assembly.ts`.**

In `packages/agent/src/context-assembly.ts`, replace the `memorize` and `forget` entries in `AVAILABLE_COMMANDS` (the array starting near line 239) with a single `memory` entry:

```typescript
// OLD:
// { name: "memorize", description: "Store a key-value memory entry" },
// { name: "forget", description: "Soft-delete a memory entry (supports --prefix)" },

// NEW:
{ name: "memory", description: "Memory operations: store, forget, search, connect, disconnect (use subcommands)" },
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent`
Expected: Existing tests compile (test assertions updated in Task 3)

**Commit:** `refactor(agent): remove standalone memorize/forget, update registrations and tool definitions`

<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3) -->

<!-- START_TASK_3 -->
### Task 3: Migrate and extend tests for unified memory command

**Verifies:** graph-memory.AC2.1, graph-memory.AC2.2, graph-memory.AC2.3, graph-memory.AC2.4, graph-memory.AC2.5, graph-memory.AC2.6

**Files:**
- Modify: `packages/agent/src/__tests__/commands.test.ts` (replace memorize/forget describe blocks with memory command tests)
- Create: `packages/agent/src/__tests__/graph-memory-search.test.ts`

**Test file 1:** `packages/agent/src/__tests__/commands.test.ts` — migrate existing tests (unit)

**Testing (commands.test.ts migration):**

Replace the `describe("memorize command")` block and `describe("forget command")` block with a new `describe("memory command")` block.

Migrate all 8 memorize tests and 1 forget test to call `memory.handler()` with appropriate `subcommand` field:

- Old: `memorize.handler({ key: "test_key", value: "test_value" }, ctx)`
- New: `memory.handler({ subcommand: "store", source: "test_key", target: "test_value" }, ctx)`

- Old: `forget.handler({ key: "delete_me" }, ctx)`
- New: `memory.handler({ subcommand: "forget", source: "delete_me" }, ctx)`

- Old: `memorize.handler({ key, value: "v", source: "custom-source-id" }, ctx)`
- New: `memory.handler({ subcommand: "store", source: key, target: "v", source_tag: "custom-source-id" }, ctx)`

**IMPORTANT: bun:sqlite `.get()` returns `null` (not `undefined`) when no row found.** The original `memorize.ts` typed `.get()` results as `| undefined`, which was technically incorrect per the CLAUDE.md invariant. The new `memory.ts` correctly uses `| null`. Migrated tests should use `null` checks (e.g., `expect(row).not.toBeNull()` rather than `expect(row).toBeDefined()`). In practice, truthy checks (`if (existing)`) work identically for both null and undefined, so most tests only need import changes.

Each migrated test must pass with identical assertions.

Tests must verify:
- **graph-memory.AC2.1:** `memory store` creates a new semantic_memory entry; `memory store` on existing key updates value (migrated from memorize tests)
- **graph-memory.AC2.2:** `memory forget` soft-deletes an entry by key (migrated from forget test); `memory forget --prefix X` deletes all matching entries
- **graph-memory.AC2.4:** All subcommands (store, forget, search, connect, disconnect) are reachable through the unified handler
- **graph-memory.AC2.5:** `memory.handler({ subcommand: "nonexistent" }, ctx)` returns exitCode 1 with stderr containing "unknown subcommand"
- **graph-memory.AC2.6:** `memory store` on a previously soft-deleted key restores it with `deleted = 0` (migrated from memorize restore test)

**Test file 2:** `packages/agent/src/__tests__/graph-memory-search.test.ts` — new search tests (unit)

**Testing (search tests):**

Use the standard test DB setup pattern. Seed several semantic_memory entries with varied keys and values. Tests must verify:

- **graph-memory.AC2.3:** `memory search` returns entries matching keywords in both key and value fields. Test with:
  - Query matching a key substring (e.g., search "scheduler" finds key "scheduler_v3")
  - Query matching a value substring (e.g., search "interval" finds entry with "interval math" in value)
  - Query with multiple keywords returns union of matches
  - Query with only stop words returns "No searchable keywords" message
  - Query with no matches returns "No memories matched" message
  - Results are ordered by modified_at DESC
  - Results are capped at 20

**Verification:**
Run: `bun test packages/agent/src/__tests__/commands.test.ts`
Expected: All migrated tests pass

Run: `bun test packages/agent/src/__tests__/graph-memory-search.test.ts`
Expected: All search tests pass

Run: `bun test packages/core packages/agent`
Expected: All tests pass, no regressions

**Commit:** `test(agent): migrate memorize/forget tests and add search tests for memory command`

<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->
