# RxJS Async Processing Refactor — Phase 6

**Goal:** Remove dead code from the imperative implementations, run the full test suite, verify binary compilation, and confirm no regressions.

**Architecture:** This is a cleanup and verification phase. No new functionality is added. Dead code from the old imperative implementations is removed, and the full project pipeline (test, typecheck, lint, build) is verified end-to-end.

**Tech Stack:** TypeScript 6.x, Bun runtime

**Scope:** 6 phases from original design (phase 6 of 6)

**Codebase verified:** 2026-05-01

---

## Acceptance Criteria Coverage

This phase implements and tests:

### rxjs-async-refactor.AC5: Cross-Cutting
- **rxjs-async-refactor.AC5.1:** All existing tests pass with no regressions
- **rxjs-async-refactor.AC5.2:** `bun run typecheck` clean across all packages
- **rxjs-async-refactor.AC5.3:** `bun run build` produces working binary
- **rxjs-async-refactor.AC5.4:** No dead code from removed imperative implementations remains

---

<!-- START_TASK_1 -->
### Task 1: Verify and remove dead code in agent-loop.ts

**Verifies:** rxjs-async-refactor.AC5.4

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (if any dead code remains)

**Step 1: Search for leftover references**

Run: `grep -n "relayStream\|relayWait\|_relayWaitImpl" packages/agent/src/agent-loop.ts`

Expected: No matches. These methods should have been removed in Phases 2 and 3. If any references remain (comments, type annotations, etc.), remove them.

**Step 2: Check for unused imports**

Run: `grep -n "readInboxByStreamId\|readInboxByRefId\|recordTurnRelayMetrics" packages/agent/src/agent-loop.ts`

These functions were used by the old `relayStream()` and `relayWait()` methods. If they're no longer used directly in `agent-loop.ts` (they're now imported by `relay-stream$.ts` and `relay-wait$.ts` instead), remove them from agent-loop.ts imports.

**Step 3: Verify no orphaned utility functions**

Check that no helper functions existed solely for the old imperative methods (e.g., local timeout helpers).

No commit yet — will batch with other cleanup.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Verify and remove dead code in relay-processor.ts

**Verifies:** rxjs-async-refactor.AC5.4

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (if any dead code remains)

**Step 1: Search for `stopped` flag**

Run: `grep -n "this.stopped\|private stopped" packages/agent/src/relay-processor.ts`

Expected: No matches. The `stopped` flag should have been removed in Phase 4. If any references remain, remove them.

**Step 2: Search for `tickCount`**

Run: `grep -n "tickCount\|PRUNE_EVERY_N_TICKS" packages/agent/src/relay-processor.ts`

Expected: No matches. These local variables from the old `start()` should have been removed in Phase 4.

**Step 3: Verify setTimeout is gone**

Run: `grep -n "setTimeout" packages/agent/src/relay-processor.ts`

Expected: No matches in the `start()` method. (May exist elsewhere in the file for unrelated purposes — only the tick loop setTimeout should be gone.)

No commit yet — will batch with other cleanup.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Verify and remove dead code in discord-interaction.ts

**Verifies:** rxjs-async-refactor.AC5.4

**Files:**
- Modify: `packages/platforms/src/connectors/discord-interaction.ts` (if any dead code remains)

**Step 1: Search for `disconnecting` boolean**

Run: `grep -n "disconnecting" packages/platforms/src/connectors/discord-interaction.ts`

Expected: Only references to `disconnecting$` (the Subject). The old `disconnecting: boolean` field should have been replaced in Phase 5. If both exist, remove the boolean.

**Step 2: Search for while(true) polling pattern**

Run: `grep -n "while\s*(true)\|while(true)" packages/platforms/src/connectors/discord-interaction.ts`

Expected: No matches. The old `pollForResponse()` polling loop should be gone.

**Step 3: Commit cleanup**

If any dead code was found and removed in Tasks 1-3:

```bash
git add packages/agent/src/agent-loop.ts packages/agent/src/relay-processor.ts packages/platforms/src/connectors/discord-interaction.ts
git commit -m "chore: remove dead code from imperative async implementations"
```

If no dead code was found (all clean from prior phases), skip the commit.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Run full test suite

**Verifies:** rxjs-async-refactor.AC5.1

**Step 1: Run all tests**

Run: `bun test --recursive`
Expected: All tests pass (existing + new from phases 1-5). Report total pass/fail/skip counts.

**Step 2: If any failures, investigate and fix**

Any test failures at this point indicate a regression introduced during the refactor. Fix the root cause — do NOT skip or disable tests.

No commit needed — verification only.
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Full typecheck, lint, and build

**Verifies:** rxjs-async-refactor.AC5.2, rxjs-async-refactor.AC5.3

**Step 1: Typecheck all packages**

Run: `bun run typecheck`
Expected: Clean across all packages. No type errors.

**Step 2: Lint**

Run: `bun run lint`
Expected: No lint errors. If new files have lint issues, fix them:

Run: `bun run lint:fix`

**Step 3: Build binary**

Run: `bun run build`
Expected: Binary builds successfully in `dist/`.

**Step 4: Verify binary runs**

Run: `./dist/bound --version`
Expected: Prints version without errors.

**Step 5: Commit lint fixes if any**

If `lint:fix` made changes:

```bash
git add -A
git commit -m "style: fix lint issues in new RxJS modules"
```

If no lint fixes needed, skip the commit.
<!-- END_TASK_5 -->
