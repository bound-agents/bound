# Volatile Context Tiered Fidelity — Phase 6: Snapshot Tests + d0372be6 Structural Regression

**Goal:** Land §8.2's eleven snapshot-style fixtures (the new `.snap.txt` convention this RFC introduces) plus the §8.3 d0372be6 structural regression test that pins the surface-level fix for the confabulation pattern.

**Architecture:** A small in-house snapshot helper (`assertSnapshot`) under `packages/agent/src/__tests__/test-helpers/snapshot.ts` reads a fixture file and compares against a rendered string with optional `UPDATE_SNAPSHOTS=1` regeneration. Each of the eleven scenarios constructs a fixture DB, runs `buildVolatileContext`, and pins the rendered output to a corresponding `.snap.txt`. The §8.3 regression test runs on the same plumbing but uses positive/negative substring assertions rather than full-block snapshot equivalence.

**Tech Stack:** TypeScript, `bun:test`. No new dependencies — plain file I/O for snapshot equivalence.

**Scope:** 6 of 7 phases.

**Codebase verified:** 2026-05-22 against commit `36dc9f2e`. Codebase-investigator confirmed the monorepo has no existing snapshot infrastructure: no `.snap.txt`, no `toMatchSnapshot`, no jest-snapshot dependency. The convention introduced here is intentionally novel; the spec at §8.2 sanctions it as a deliberate choice for whole-rendered-block format equivalence. `cleanupTmpDir(path)` is exported from `packages/shared/src/test-utils.ts`. `MockLLMBackend` is declared inline per test file (no shared library); this phase's tests do not need a mock LLM since `buildVolatileContext` is a pure-DB operation.

---

## Acceptance Criteria Coverage

This phase implements:

### volatile-context.AC-Deploy-Snapshots (literal from §8.2)

- **§8.2 (literal):** "The integration of the three assemblers into `buildVolatileContext` is covered by snapshot tests using fixtures that mirror real memory-state shapes. Snapshots assert the exact rendered output for representative scenarios: …" followed by the eleven scenarios. The full literal list is reproduced in Task 3 below.

### volatile-context.AC-Deploy-§8.3 (d0372be6 structural regression)

- **§8.3 (literal):** "A targeted regression test asserts the structural fix for §1.3:" — the four assertions enumerated in §8.3 (1)–(5) — Live State footer text exact match, no `Summary:` line for any sibling thread, no `"Do not mention"` substring anywhere in output, plus the fixture construction step.

### volatile-context.AC-Deploy-§8.5 (acceptance gates)

- **§8.5 (literal, scoped to this phase):** "Snapshot tests pass for all eleven scenarios in §8.2." and "§8.3 regression test passes (structural surface)." — both are gated by Phase 6's deliverables.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Implement `assertSnapshot` helper

**Type:** Functionality (test infrastructure).

**Verifies:** None directly (foundation for §8.2 scenarios).

**Files:**
- Create: `packages/agent/src/__tests__/test-helpers/snapshot.ts`

**Implementation:**

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Compare `actual` against the snapshot at `snapshotPath`.
 *
 * On mismatch:
 *   - If `UPDATE_SNAPSHOTS=1` is set in the environment, the snapshot is overwritten
 *     and a console.warn explains. The caller's expectation passes.
 *   - Otherwise, throws a diff-shaped Error so bun:test reports a clean failure.
 *
 * On first run (snapshot file absent):
 *   - The file is written to disk and a console.warn names it as a new snapshot.
 *     The caller's expectation passes. Subsequent runs assert against the written file.
 *
 * The trailing newline of `actual` is preserved verbatim. Snapshot files are committed
 * to the repo; updating one is a deliberate review gate per spec §8.2.
 */
export function assertSnapshot(actual: string, snapshotPath: string): void {
    if (!existsSync(snapshotPath)) {
        mkdirSync(dirname(snapshotPath), { recursive: true });
        writeFileSync(snapshotPath, actual, "utf8");
        console.warn(`[snapshot] wrote new fixture: ${snapshotPath}`);
        return;
    }
    const expected = readFileSync(snapshotPath, "utf8");
    if (actual === expected) return;
    if (process.env.UPDATE_SNAPSHOTS === "1") {
        writeFileSync(snapshotPath, actual, "utf8");
        console.warn(`[snapshot] updated fixture: ${snapshotPath}`);
        return;
    }
    throw new Error(snapshotMismatchMessage(snapshotPath, expected, actual));
}

function snapshotMismatchMessage(
    snapshotPath: string,
    expected: string,
    actual: string,
): string {
    const lines: string[] = [];
    lines.push(`Snapshot mismatch: ${snapshotPath}`);
    lines.push("To update, re-run with UPDATE_SNAPSHOTS=1 in the environment.");
    lines.push("---- expected ----");
    lines.push(expected);
    lines.push("---- actual ----");
    lines.push(actual);
    return lines.join("\n");
}
```

Notes:

- `UPDATE_SNAPSHOTS=1` is the regeneration handshake. The spec calls out that "Snapshot updates require explicit reviewer approval" — the env-var gate makes intentional regeneration easy and accidental regeneration impossible (default behavior is to fail loudly).
- Plain `===` string equality is used. The spec contracts on whole-rendered-block format equivalence; partial-match or whitespace-tolerant comparison would weaken the contract.
- The first-run write-on-absence behavior keeps the dev loop fast while still treating the committed `.snap.txt` as the source of truth on every subsequent run. CI uses `UPDATE_SNAPSHOTS=0` (default) and never writes.

**Step 1: Add the helper file.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/test-helpers/snapshot.ts
git commit -m "test(agent): add assertSnapshot helper for .snap.txt fixtures"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test the snapshot helper

**Type:** Functionality.

**Verifies:** None directly (helper correctness).

**Files:**
- Create: `packages/agent/src/__tests__/test-helpers/snapshot.test.ts`

**Implementation:**

Tests against a temp directory under `tmpdir()`:

1. **First run writes the fixture.** Snapshot path does not exist → `assertSnapshot("hello\n", path)` writes `hello\n` and passes.

2. **Match passes silently.** Path exists with matching content → `assertSnapshot` returns without throwing.

3. **Mismatch throws with a diff-shaped message.** Path exists with `"hello\n"`, actual is `"world\n"` → `assertSnapshot` throws an Error whose message contains both the expected and actual content and the snapshot path.

4. **`UPDATE_SNAPSHOTS=1` overwrites and passes.** Set the env var, call with mismatched content → fixture is rewritten and the call returns without throwing. (Reset the env var in `afterEach`.)

5. **Trailing newline preserved.** Write `"x"` (no newline), then a second call with `"x"` matches; a third call with `"x\n"` does not match.

6. **Nested directory created on first write.** Path is `nested/dir/file.snap.txt`; the helper creates the parent directories.

Use `randomBytes(4).toString("hex")` to scope each test's tmp dir. Clean up in `afterEach` via `cleanupTmpDir` from `@bound/shared/test-utils`.

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/test-helpers/snapshot.test.ts`

Expected: 6 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/test-helpers/snapshot.test.ts
git commit -m "test(agent): cover assertSnapshot helper behaviors"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Build the §8.2 fixture-construction harness

**Type:** Functionality.

**Verifies:** Foundation for the eleven §8.2 scenarios.

**Files:**
- Create: `packages/agent/src/__tests__/fixtures/volatile-context/builders.ts` — DB-construction helpers used by all eleven scenarios.

**Implementation:**

The eleven scenarios share a lot of construction shape (insert N pinned, M summary, K detail entries; insert sibling threads; insert advisories; etc.). Factor those into builder helpers so each scenario test reads as data + the override.

```typescript
import type { Database } from "bun:sqlite";
import { applySchema } from "@bound/core";
import { insertRow } from "@bound/core";
// ... (verify exact import path at execution time)

export interface BuilderContext {
    db: Database;
    siteId: string;
    nowMs: number;
}

export function makePinned(ctx: BuilderContext, count: number, prefix = "_pinned:"): void {
    for (let i = 0; i < count; i++) {
        const key = `${prefix}${i}`;
        insertRow(ctx.db, "semantic_memory", {
            id: deterministicUUID(BOUND_NAMESPACE, key),
            key,
            value: `pinned body ${i}`,
            tier: "pinned",
            source: "fixture",
            modified_at: new Date(ctx.nowMs - i * 1000).toISOString(),
            last_accessed_at: new Date(ctx.nowMs - i * 1000).toISOString(),
            // ... full column set per schema.ts
        }, ctx.siteId);
    }
}

export function makeSummary(ctx: BuilderContext, count: number): string[] {
    const keys: string[] = [];
    for (let i = 0; i < count; i++) {
        const key = `_summary:topic-${i}`;
        keys.push(key);
        // insertRow ... tier='summary'
    }
    return keys;
}

export function makeDetail(
    ctx: BuilderContext,
    count: number,
    parentKey: string | null = null,
): string[] {
    const keys: string[] = [];
    for (let i = 0; i < count; i++) {
        const key = `curiosity:item-${i}-${randomSuffix()}`;
        keys.push(key);
        // insertRow ... tier='detail', last_accessed_at staggered
        if (parentKey) {
            // upsertEdge from @bound/core: relation='summarizes', source=parentKey, target=key
        }
    }
    return keys;
}

export function makeStaleChild(
    ctx: BuilderContext,
    parentSummaryKey: string,
    parentModifiedAt: string,
): string {
    const key = `detail:stale-${randomSuffix()}`;
    // insert detail entry with modified_at AFTER parentModifiedAt
    // upsertEdge summarizes parent -> child
    return key;
}

export function makeSiblingThread(
    ctx: BuilderContext,
    title: string,
    messageCount: number,
    summaryText: string | null,
): string {
    // Insert into threads + N messages
    // Returns thread id
}

export function makeAppliedAdvisory(
    ctx: BuilderContext,
    title: string,
    appliedHoursAgo: number,
): void {
    const resolvedAt = new Date(ctx.nowMs - appliedHoursAgo * 3600_000).toISOString();
    insertRow(ctx.db, "advisories", { /* status='applied', resolved_at, ... */ }, ctx.siteId);
}

export function makeFileMod(ctx: BuilderContext, path: string, threadTitle: string): void {
    // Use the existing file-modification notice path; insert into the underlying table.
}

function randomSuffix(): string {
    return Math.random().toString(36).slice(2, 8);
}
```

The implementor verifies the exact column lists for each table (`semantic_memory`, `memory_edges`, `threads`, `messages`, `advisories`, plus the file-mod producer's storage) from `packages/core/src/schema.ts` at execution time and adapts the builders accordingly.

Re-export `assertSnapshot` from a sibling `index.ts` so individual scenario tests can import both helpers from one place if convenient.

**Step 1: Write the builders, deferring exact column shapes to the implementor.**

**Step 2: Smoke-test the builders inline.** Add one trivial test in the file that calls each builder once against a temp DB and asserts the row count via raw SELECT.

**Step 3: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 4: Commit**

```bash
git add packages/agent/src/__tests__/fixtures/volatile-context/builders.ts
git commit -m "test(agent): scaffold volatile-context fixture builders"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Land the eleven §8.2 snapshot scenarios

**Type:** Functionality.

**Verifies:** volatile-context.AC-Deploy-Snapshots — every R-VC requirement from §3 surfaces in at least one scenario.

**Files:**
- Create: `packages/agent/src/__tests__/volatile-context-snapshots.test.ts`
- Create (auto, on first run): the eleven `.snap.txt` files under `packages/agent/src/__tests__/fixtures/volatile-context/`.

**Implementation:**

Eleven `it()` blocks, each constructing the spec'd memory state, calling `buildVolatileContext`, and asserting against a unique `.snap.txt` fixture path. The test file overrides `BOUND_VC15_N` and `BOUND_VC15_M` per scenario via `beforeEach` (and resets in `afterEach` per the project pattern verified by codebase-investigator).

The eleven scenarios per §8.2 (literal text from spec, used as the `it()` description):

1. `Empty memory state (cold-start agent).` — fixture: zero entries. Assert against `empty.snap.txt`.

2. `Memory state with 80 pinned + 50 summary + 30 detail entries (warm-start, R-VC15 Tier 1).` — fixture: 80 pinned + 50 summary + 30 detail (≤200 → Tier 1 flat list). Assert against `tier1-warm-start.snap.txt`.

3. `Memory state with 80 pinned + 50 summary + 500 detail entries (R-VC15 Tier 2 cluster compression activated).` — fixture: 500 detail entries split across `_summary:` parents → Tier 2. Assert against `tier2-cluster-compression.snap.txt`.

4. `Memory state with 80 pinned + 50 summary + 5000 detail entries (R-VC15 Tier 3 heading-only compression with M=20 cap).` — fixture: 5000 detail entries. Assert against `tier3-heading-only.snap.txt`.

   **Production-default deviation:** the `it()` body overrides `BOUND_VC15_M=5` for fixture reviewability. The `M=20` literal in the spec is the production default; the test exercises the heading-only path with a smaller M so the committed snapshot file stays scannable in PR review. The `it()` body MUST log this deviation in a one-line comment, and the generated `.snap.txt` MUST carry a leading comment (`# NOTE: BOUND_VC15_M overridden to 5 for snapshot reviewability; production default is 20`) so a future reader knows the snapshot does not reflect production defaults. The implementor adds this comment manually after the first auto-write of the fixture.

5. `Memory state with critical budget pressure (R-VC14 active) and deltas inside Working Knowledge (verifying R-VC11 markers preserved while Live State and Discoverable Archive are shed).` — fixture: budget-pressure rebuild path. Assert against `budget-pressure.snap.txt`.

6. `Memory state with stale-child triples (R-VC10 active) where one stale child is also a delta (R-VC11(c) composition: both markers in fixed order).` — Assert against `stale-child-delta-composition.snap.txt`.

7. `Memory state with R-MV1 deltas spanning all three sections (verifying delta marker only appears on Working Knowledge entries, not on Discoverable Archive titles).` — Assert against `deltas-three-sections.snap.txt`.

8. `Memory state with delta on a multi-line pinned entry (R-VC11(b): marker on indented new line beneath the pinned text).` — Assert against `multiline-pinned-delta.snap.txt`.

9. `Memory state with R-VC15 Tier 3 active and Uncategorized cluster > 50 entries (verifying the synthesis-backlog advisory is surfaced under Live State).` — Assert against `tier3-synthesis-backlog.snap.txt`.

10. `Memory state with R-VC15 Tier 3 active and a non-R-VC9b-compliant parent summary (a cluster gloss missing sub-topic vocabulary; verifying the rendering is structurally correct even though the discoverability path is degraded).` — Assert against `tier3-non-r-vc9b-compliant.snap.txt`. The non-compliance is a property of the parent's `value` content (no sub-topic vocabulary), not of the rendering — the snapshot pins that the rendering is structurally identical regardless.

11. `Memory state with task digest entries rendering under Live State alongside cross-thread / file / advisory entries (verifying R-VC5's four subsystems render in their fixed order with correct source labels).` — Assert against `live-state-four-subsystems.snap.txt`.

Each scenario follows the same shape:

```typescript
describe("volatile-context snapshots", () => {
    let dbPath: string;
    let configDir: string;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
        configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
        // ... applySchema, etc.
    });

    afterEach(async () => {
        process.env = { ...originalEnv };
        await cleanupTmpDir(configDir);
        try { unlinkSync(dbPath); } catch {}
    });

    it("Memory state with 80 pinned + 50 summary + 30 detail entries (warm-start, R-VC15 Tier 1)", async () => {
        const ctx = makeBuilderContext(dbPath);
        makePinned(ctx, 80);
        const summaryKeys = makeSummary(ctx, 50);
        for (let i = 0; i < 30; i++) {
            makeDetail(ctx, 1, summaryKeys[i % summaryKeys.length]);
        }
        const result = buildVolatileContext(ctx.db, /* params */);
        await assertSnapshot(
            result.text,
            join(__dirname, "fixtures/volatile-context/tier1-warm-start.snap.txt"),
        );
    });
    // ... ten more it blocks
});
```

Notes:

- The first run of each `it` block writes its `.snap.txt` (per the helper's behavior). The implementor inspects the generated files for sanity before committing.
- Snapshot updates after this point require `UPDATE_SNAPSHOTS=1` and a deliberate review-gate commit.
- `nowMs` is fixed inside each scenario (e.g., `2026-05-22T00:00:00.000Z`) so relative-time fragments render deterministically.
- For scenarios 3 and 4 (Tier 2 / Tier 3), the snapshot files become large. The committed files are still readable in PR review; abbreviating them via in-test omission undermines the contract and is out of bounds.

**Step 1: Write all eleven `it` blocks against the builders.**

**Step 2: First run writes the fixtures**

Run: `bun test packages/agent/src/__tests__/volatile-context-snapshots.test.ts`

Expected: 11 tests pass; 11 `.snap.txt` files appear under `fixtures/volatile-context/`.

**Step 3: Inspect each fixture file** for sanity (correct sections, expected order, no `Summary:` excerpts, no `Do not mention`).

**Step 4: Re-run** to confirm idempotence

Run: `bun test packages/agent/src/__tests__/volatile-context-snapshots.test.ts`

Expected: 11 tests pass with no fixture writes.

**Step 5: Commit**

```bash
git add packages/agent/src/__tests__/volatile-context-snapshots.test.ts \
        packages/agent/src/__tests__/fixtures/volatile-context/
git commit -m "test(agent): land 11 §8.2 snapshot scenarios"
```
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (task 5) -->

<!-- START_TASK_5 -->
### Task 5: §8.3 d0372be6 structural regression test

**Type:** Functionality.

**Verifies:** volatile-context.AC-Deploy-§8.3 (structural surface only — behavioral coverage lives in Phase 7).

**Files:**
- Create: `packages/agent/src/__tests__/d0372be6-structural-regression.test.ts`

**Implementation:**

The test pins the structural surface of the §1.3 fix. It does not invoke an LLM — model-behavior coverage is §8.6 and lives in Phase 7.

```typescript
describe("d0372be6 confabulation pattern — structural surface", () => {
    let dbPath: string;
    let configDir: string;

    beforeEach(() => {
        dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
        configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
        // applySchema, register a webhook event-handler thread
    });

    afterEach(async () => {
        await cleanupTmpDir(configDir);
        try { unlinkSync(dbPath); } catch {}
    });

    it("Live State footer names tool_results as the canonical source for current-thread payloads", () => {
        // Construct a webhook event-handler thread with one tool_result containing envelope JSON.
        // ... (see §8.3 step 1)
        const result = buildVolatileContext(db, /* params */);
        expect(result.text).toContain(
            "Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary",
        );
    });

    it("cross-thread digest emits no Summary: line for any sibling thread", () => {
        // Insert two sibling threads with non-empty summary fields.
        // ...
        const result = buildVolatileContext(db, /* params */);
        // Per §8.3 step 4: no Summary: line for ANY sibling thread (including the agent's own,
        // which is correctly excluded by excludeThreadId).
        expect(result.text).not.toMatch(/^\s*Summary:/m);
    });

    it("output contains no 'Do not mention' meta-instruction", () => {
        const result = buildVolatileContext(db, /* params */);
        expect(result.text).not.toContain("Do not mention");
    });

    it("output contains no 'Recent Activity Digest:' header (legacy section header is gone)", () => {
        const result = buildVolatileContext(db, /* params */);
        expect(result.text).not.toContain("Recent Activity Digest:");
    });

    it("Live State header text is exact", () => {
        const result = buildVolatileContext(db, /* params */);
        expect(result.text).toContain("## Live State — pointers to canonical sources");
    });
});
```

Notes:

- The test does not exercise model behavior — it asserts structural facts about the rendered output. Per §8.3: "This test does not exercise model behavior — it verifies the structural surface that the model consults." The behavioral verification lives in Phase 7 §8.6.
- The fixture's `tool_result` containing envelope JSON is constructed but does not need to be inspected by the test (the test asserts on what the orientation block looks like, not on the conversation history). The fixture exists to mirror the §1.3 setup faithfully — the failing thread had an envelope tool_result and the agent didn't consult it.

**Step 1: Write the test.**

**Step 2: Verify it passes**

Run: `bun test packages/agent/src/__tests__/d0372be6-structural-regression.test.ts`

Expected: 5 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/d0372be6-structural-regression.test.ts
git commit -m "test(agent): pin d0372be6 structural surface (§8.3)"
```
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase 6 Done When

- All five tasks committed.
- `bun test packages/agent/src/__tests__/test-helpers/snapshot.test.ts` passes 6 tests.
- `bun test packages/agent/src/__tests__/volatile-context-snapshots.test.ts` passes 11 tests against the committed `.snap.txt` fixtures.
- `bun test packages/agent/src/__tests__/d0372be6-structural-regression.test.ts` passes 5 tests.
- Every `.snap.txt` file is committed to the repo and review-gated; updates require `UPDATE_SNAPSHOTS=1` plus an intentional commit.
- `bun run typecheck` passes.
