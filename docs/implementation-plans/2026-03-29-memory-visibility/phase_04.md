# Memory Visibility — Phase 4: Memorize Source Fix

**Goal:** Fix the `memorize` command so new memory entries carry the correct source identifier (task ID or thread ID) instead of the literal string `"agent"`, enabling source resolution in the volatile enrichment delta.

**Architecture:** One-line change at `packages/agent/src/commands/memorize.ts:17`. The `source` default currently ignores `ctx.taskId` and `ctx.threadId`. The fix adds them to the fallback chain before `"agent"`. The `CommandContext` type already has optional `taskId?: string` and `threadId?: string` fields — no type changes needed.

**Tech Stack:** TypeScript, bun:test

**Scope:** Phase 4 of 5 from design plan

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### memory-visibility.AC6: Memorize source default
- **memory-visibility.AC6.1 Success:** memorize with ctx.taskId set stores source as the task ID
- **memory-visibility.AC6.2 Success:** memorize with only ctx.threadId set stores source as the thread ID
- **memory-visibility.AC6.3 Success:** memorize with neither ctx.taskId nor ctx.threadId stores source as "agent"
- **memory-visibility.AC6.4 Success:** memorize with an explicit --source argument stores the provided value

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Fix the source default in memorize.ts

**Verifies:** AC6.1, AC6.2, AC6.3, AC6.4 (implementation step; tests in Task 2)

**Files:**
- Modify: `packages/agent/src/commands/memorize.ts:17` (one line change)

**Step 1: Open the file and locate line 17**

Open `packages/agent/src/commands/memorize.ts`. Line 17 currently reads:

```typescript
		const source = args.source || "agent";
```

**Step 2: Apply the one-line fix**

Replace line 17 with:

```typescript
		const source = args.source || ctx.taskId || ctx.threadId || "agent";
```

No other changes are needed. The `source` variable is already passed to both `insertRow` (line ~48) and `updateRow` (line ~34) on all write paths. Both paths automatically get the updated source value.

**Step 3: Verify TypeScript**

Run: `tsc -p packages/agent --noEmit`
Expected: No TypeScript errors. (`ctx.taskId` and `ctx.threadId` are both `string | undefined`, so the `||` chain is type-safe.)

Do NOT commit yet — wait for tests in Task 2.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add source storage assertions to commands.test.ts

**Verifies:** memory-visibility.AC6.1, memory-visibility.AC6.2, memory-visibility.AC6.3, memory-visibility.AC6.4

**Files:**
- Modify: `packages/agent/src/__tests__/commands.test.ts` (add 4 new `it()` cases for memorize source)

**Existing setup:**

The file already has a `ctx` object with `taskId: randomUUID()` and `threadId: randomUUID()` set. You will need two additional contexts for AC6.2 and AC6.3 cases.

**Step 1: Locate the memorize describe block**

Find the existing memorize tests (~lines 103–132). Add four new test cases after the existing two.

**Step 2: Add helper to read source from DB**

At the top of the memorize test block (or as a local helper), prepare a way to read the `source` column after a memorize call:

```typescript
function getMemorySource(db: Database, key: string): string | null {
    const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
    const row = db
        .prepare("SELECT source FROM semantic_memory WHERE id = ?")
        .get(memoryId) as { source: string | null } | null;
    return row?.source ?? null;
}
```

Import `deterministicUUID` and `BOUND_NAMESPACE` at the top of the file if not already present — check the existing imports in memorize.ts and mirror them in the test.

**Step 3: Add the four test cases**

```typescript
it("stores source as taskId when ctx.taskId is set (AC6.1)", async () => {
    // ctx already has taskId and threadId set
    await memorize.handler({ key: "source_task_key", value: "v" }, ctx);
    const source = getMemorySource(db, "source_task_key");
    expect(source).toBe(ctx.taskId);
});

it("stores source as threadId when only ctx.threadId is set (AC6.2)", async () => {
    const threadOnlyCtx: CommandContext = { ...ctx, taskId: undefined };
    await memorize.handler({ key: "source_thread_key", value: "v" }, threadOnlyCtx);
    const source = getMemorySource(db, "source_thread_key");
    expect(source).toBe(ctx.threadId);
});

it("stores source as 'agent' when neither taskId nor threadId is set (AC6.3)", async () => {
    const noCtx: CommandContext = { ...ctx, taskId: undefined, threadId: undefined };
    await memorize.handler({ key: "source_agent_key", value: "v" }, noCtx);
    const source = getMemorySource(db, "source_agent_key");
    expect(source).toBe("agent");
});

it("stores explicit --source argument over ctx values (AC6.4)", async () => {
    await memorize.handler(
        { key: "source_explicit_key", value: "v", source: "custom-source-id" },
        ctx,
    );
    const source = getMemorySource(db, "source_explicit_key");
    expect(source).toBe("custom-source-id");
});
```

**Note on imports:** The test file needs `deterministicUUID` and `BOUND_NAMESPACE`. Check memorize.ts imports for the exact names — the file uses `deterministicUUID` from `"../helpers.js"` or similar. Mirror those imports in the test file. Also verify `CommandContext` is imported from `"@bound/sandbox"` in the test file.

**Step 4: Run tests**

Run: `bun test packages/agent/src/__tests__/commands.test.ts`
Expected: All tests pass including the 4 new AC6 cases.

**Step 5: Run full agent suite**

Run: `bun test packages/agent`
Expected: All tests pass (existing 331 baseline + volatile-enrichment tests from Phase 2 + context-assembly tests from Phase 3 + 4 new Phase 4 tests).

**Step 6: Commit**

```bash
git add packages/agent/src/commands/memorize.ts packages/agent/src/__tests__/commands.test.ts
git commit -m "fix(agent): memorize command stores taskId/threadId as source instead of 'agent'"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->
