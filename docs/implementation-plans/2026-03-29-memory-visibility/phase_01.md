# Memory Visibility — Phase 1: Schema Indexes

**Goal:** Add two SQLite indexes to `applySchema()` to accelerate memory delta and task digest queries.

**Architecture:** Two `CREATE INDEX IF NOT EXISTS` calls appended at the end of `applySchema()` in `packages/core/src/schema.ts`, following the exact pattern already used by all other indexes in the file. The existing idempotence test already covers AC7.3; only the "creates all indexes" test needs new `.toContain()` assertions.

**Tech Stack:** bun:sqlite, TypeScript, bun:test

**Scope:** Phase 1 of 5 from design plan

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### memory-visibility.AC7: Schema indexes
- **memory-visibility.AC7.1 Success:** idx_memory_modified index exists on semantic_memory(modified_at DESC) after applySchema()
- **memory-visibility.AC7.2 Success:** idx_tasks_last_run index exists on tasks(last_run_at DESC) after applySchema()
- **memory-visibility.AC7.3 Edge:** Calling applySchema() twice does not throw (indexes are idempotent)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add idx_memory_modified and idx_tasks_last_run to applySchema()

**Verifies:** memory-visibility.AC7.1, memory-visibility.AC7.2 (implementation step; tests in Task 2)

**Files:**
- Modify: `packages/core/src/schema.ts` (add 2 `db.run()` calls before the closing `}` of `applySchema()`)

**Step 1: Locate the insertion point**

Open `packages/core/src/schema.ts`. Scroll to the very end of the file. The last statement inside `applySchema()` is a platform-connectors migration block. The closing `}` of the function is the final line of the file. You will insert two new `db.run()` calls immediately before that closing brace.

**Step 2: Add the two indexes**

Insert the following two `db.run()` calls, matching the tab-based indentation of the surrounding code:

```typescript
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_memory_modified ON semantic_memory(modified_at DESC)`,
	);

	db.run(
		`CREATE INDEX IF NOT EXISTS idx_tasks_last_run ON tasks(last_run_at DESC) WHERE deleted = 0 AND last_run_at IS NOT NULL`,
	);
```

**Key constraints:**
- `idx_memory_modified` must NOT have a `WHERE deleted = 0` partial filter — tombstoned entries (deleted=1) must appear in memory delta queries.
- `idx_tasks_last_run` MUST have `WHERE deleted = 0 AND last_run_at IS NOT NULL` — soft-deleted tasks and tasks that have never run are excluded.
- Use `db.run()` with a backtick template literal string, consistent with every other index in the file.

**Step 3: Verify the file parses**

Run: `bun run typecheck` (or `tsc -p packages/core --noEmit`)
Expected: No TypeScript errors.

Do NOT commit yet — wait for tests to pass in Task 2.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update schema test to assert new indexes

**Verifies:** memory-visibility.AC7.1, memory-visibility.AC7.2, memory-visibility.AC7.3

**Files:**
- Modify: `packages/core/src/__tests__/schema.test.ts` (add two `.toContain()` calls to the "creates all indexes" test)

**Step 1: Find the "creates all indexes" test**

Open `packages/core/src/__tests__/schema.test.ts`. Find the test named `"creates all indexes"` (near line 72). It queries `sqlite_master WHERE type='index'` and calls `expect(indexNames).toContain(...)` for each existing index.

**Step 2: Add assertions for the two new indexes**

Append two more `.toContain()` assertions after the last existing one:

```typescript
	expect(indexNames).toContain("idx_memory_modified");
	expect(indexNames).toContain("idx_tasks_last_run");
```

**Step 3: Check for any length assertion**

Scan the test body for `toHaveLength` or similar. If the test asserts a specific count of indexes (e.g., `expect(indexes).toHaveLength(7)`), increment that number by 2. If no count assertion exists, skip this step.

**Step 4: Verify AC7.3 is covered by the existing idempotence test**

The test named `"is idempotent"` (near line 116) already calls `applySchema(db)` twice and asserts it does not throw. Since both new indexes use `CREATE INDEX IF NOT EXISTS`, this test covers AC7.3 with no additional changes needed.

**Step 5: Run tests**

Run: `bun test packages/core`
Expected:
```
X pass
0 fail
```
All tests pass, including "creates all indexes" now asserting `idx_memory_modified` and `idx_tasks_last_run`.

**Step 6: Commit**

```bash
git add packages/core/src/schema.ts packages/core/src/__tests__/schema.test.ts
git commit -m "feat(core): add idx_memory_modified and idx_tasks_last_run schema indexes"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->
