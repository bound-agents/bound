# Memory Visibility — Phase 5: Tests and Coverage Verification

**Goal:** Verify all acceptance criteria have automated test coverage. Run full test suites for all affected packages. Fill any gaps left by phases 1–4.

**Architecture:** This phase adds no new production code. It verifies that the tests added in phases 1–4 collectively cover every AC in the design, runs the complete test suites, and patches any remaining gaps before the feature is considered complete.

**Tech Stack:** bun:test

**Scope:** Phase 5 of 5 from design plan

**Codebase verified:** 2026-03-29

---

## AC Coverage Matrix

All ACs should be covered by tests from earlier phases:

| AC | Description | Covered by | Test file |
|-----|-------------|------------|-----------|
| AC1.1 | Memory delta in volatile context | Phase 3 | context-assembly.test.ts |
| AC1.2 | Task digest in volatile context | Phase 3 | context-assembly.test.ts |
| AC1.3 | noHistory=true enrichment message | Phase 3 | context-assembly.test.ts |
| AC1.4 | noHistory=true no enrichment when empty | Phase 3 | context-assembly.test.ts |
| AC1.5 | Budget pressure 3+3 truncation | Phase 3 | context-assembly.test.ts |
| AC2.1 | Entry after baseline appears in delta | Phase 2 | volatile-enrichment.test.ts |
| AC2.2 | Entry before baseline excluded | Phase 2 | volatile-enrichment.test.ts |
| AC2.3 | Tombstoned entry renders as [forgotten] | Phase 2 | volatile-enrichment.test.ts |
| AC2.4 | 11 entries → 10 shown + overflow line | Phase 2 | volatile-enrichment.test.ts |
| AC2.5 | Value > 120 chars truncated with "..." | Phase 2 | volatile-enrichment.test.ts |
| AC2.6 | Memory header shows total + changed count | Phase 3 | context-assembly.test.ts |
| AC3.1 | consecutive_failures=0 shows "ran" | Phase 2 | volatile-enrichment.test.ts |
| AC3.2 | consecutive_failures>0 shows "failed" | Phase 2 | volatile-enrichment.test.ts |
| AC3.3 | host_name resolved from hosts table | Phase 2 | volatile-enrichment.test.ts |
| AC3.4 | No hosts row → claimed_by[0:8] fallback | Phase 2 | volatile-enrichment.test.ts |
| AC3.5 | 6 tasks → 5 shown + overflow line | Phase 2 | volatile-enrichment.test.ts |
| AC3.6 | Task before baseline excluded | Phase 2 | volatile-enrichment.test.ts |
| AC3.7 | Soft-deleted task excluded | Phase 2 | volatile-enrichment.test.ts |
| AC4.1 | noHistory=false → thread.last_message_at | Phase 2 | volatile-enrichment.test.ts |
| AC4.2 | noHistory=false, null last_message_at → thread.created_at | Phase 2 | volatile-enrichment.test.ts |
| AC4.3 | noHistory=true + taskId → task.last_run_at | Phase 2 | volatile-enrichment.test.ts |
| AC4.4 | noHistory=true, null last_run_at → task.created_at | Phase 2 | volatile-enrichment.test.ts |
| AC4.5 | noHistory=true, no taskId → epoch | Phase 2 | volatile-enrichment.test.ts |
| AC5.1 | source→task → `task "name"` | Phase 2 | volatile-enrichment.test.ts |
| AC5.2 | source→active thread → `thread "title"` | Phase 2 | volatile-enrichment.test.ts |
| AC5.3 | source→untitled thread → `thread "id[0:8]"` | Phase 2 | volatile-enrichment.test.ts |
| AC5.4 | source→deleted thread → id[0:8] fallback | Phase 2 | volatile-enrichment.test.ts |
| AC5.5 | source→no match → source[0:8] | Phase 2 | volatile-enrichment.test.ts |
| AC5.6 | null source → "unknown" | Phase 2 | volatile-enrichment.test.ts |
| AC6.1 | memorize with taskId → source is taskId | Phase 4 | commands.test.ts |
| AC6.2 | memorize with threadId only → source is threadId | Phase 4 | commands.test.ts |
| AC6.3 | memorize with neither → source is "agent" | Phase 4 | commands.test.ts |
| AC6.4 | memorize with --source → source is arg | Phase 4 | commands.test.ts |
| AC7.1 | idx_memory_modified exists after applySchema | Phase 1 | schema.test.ts |
| AC7.2 | idx_tasks_last_run exists after applySchema | Phase 1 | schema.test.ts |
| AC7.3 | applySchema twice does not throw | Phase 1 | schema.test.ts (existing) |
| AC8.1 | Delta reads do not update last_accessed_at | Phase 3 | context-assembly.test.ts |
| AC8.2 | Raw "Semantic Memory:" format absent | Phase 3 | context-assembly.test.ts |

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Run packages/core test suite

**Verifies:** Phases 1 complete (AC7.1, AC7.2, AC7.3)

**Files:** No changes — verification only.

**Step 1: Run core tests**

Run: `bun test packages/core`
Expected:
```
107+ pass
0 fail
```
(107 is the baseline from before; the number increases by however many schema tests are added in Phase 1)

**Step 2: Verify specific test cases exist and pass**

Run: `bun test packages/core --test-name-pattern "idx_memory_modified"`
Expected: 1 test found, passes.

Run: `bun test packages/core --test-name-pattern "idx_tasks_last_run"`
Expected: 1 test found, passes.

**If any tests fail:** Do not proceed. Go back to Phase 1 and fix the issue before continuing.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Run packages/agent test suite

**Verifies:** Phases 2–4 complete (AC1–AC6, AC8)

**Files:** No changes — verification only.

**Step 1: Run volatile-enrichment tests**

Run: `bun test packages/agent/src/__tests__/volatile-enrichment.test.ts`
Expected: All tests pass, 0 failures.

**Step 2: Run context-assembly tests**

Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All tests pass including the new Stage 5.5 describe block, 0 failures.

**Step 3: Run commands tests**

Run: `bun test packages/agent/src/__tests__/commands.test.ts`
Expected: All tests pass including the 4 new AC6 cases for memorize source.

**Step 4: Run full agent suite**

Run: `bun test packages/agent`
Expected: All tests pass. Only allowed failure is the pre-existing `skill-commands.test.ts` error (missing `just-bash` package).

**If any new failures appear:** Investigate and fix before marking this task complete.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Audit coverage matrix and fill gaps

**Verifies:** All ACs listed in the coverage matrix above

**Files:** Varies — patch any test files that have gaps.

**Step 1: Verify volatile-enrichment.test.ts test count**

Open `packages/agent/src/__tests__/volatile-enrichment.test.ts`. Verify it contains at least 20 `it()` test cases (covering all AC2–5 cases listed in the matrix above).

**Step 2: Verify context-assembly.test.ts Stage 5.5 tests**

Open `packages/agent/src/__tests__/context-assembly.test.ts`. Verify it contains a describe block for Stage 5.5 or "volatile enrichment" and includes tests for memory delta presence, task digest presence, noHistory=true enrichment, and budget pressure.

**Step 3: Verify commands.test.ts memorize source assertions**

Open `packages/agent/src/__tests__/commands.test.ts`. Verify it contains at least 4 memorize test cases that assert on the `source` field in `semantic_memory` (AC6.1–6.4).

**Step 4: Check for any missing ACs**

Go through the AC coverage matrix table above. For each AC, confirm there is at least one `it()` test case that specifically exercises that condition. If any AC is missing a test:

1. Determine which test file should host it (follow the matrix above)
2. Add the missing test using the same patterns established in phases 2–4
3. Run the relevant test file to confirm the new test passes
4. Re-run the full suite

**Step 5: Final full run across all affected packages**

Run: `bun test packages/core && bun test packages/agent`
Expected: Both suites pass with 0 new failures.

**Step 6: Final commit (if any gap-fill changes were needed)**

If you added any tests in this phase:
```bash
git add [any changed test files]
git commit -m "test(agent): fill coverage gaps for memory-visibility ACs"
```

If no gap-fill was needed, no commit is required for this phase.
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
