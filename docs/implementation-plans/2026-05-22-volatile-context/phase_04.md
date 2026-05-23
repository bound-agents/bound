# Volatile Context Tiered Fidelity — Phase 4: Live State Renderer

**Goal:** Implement the third top-level section, `renderLiveState()`. Composes four subsystems — cross-thread digest, task run digest, file modification notices, applied advisories — each with an explicit source label (`[thread]` / `[task]` / `[file]` / `[advisory]`), plus the conditional `[synthesis-backlog]` line raised by Phase 3's Tier-3 path. Modifies `buildCrossThreadDigest` to drop the 300-character per-thread summary excerpt that drives the d0372be6 confabulation pattern (§1.3).

**Architecture:** A pure-function renderer plus a single targeted in-place modification of the existing `buildCrossThreadDigest`. Each subsystem's data source is loaded by the caller (Phase 5 wiring); the renderer composes pre-loaded subsystem outputs into the final section.

**Tech Stack:** TypeScript, `bun:sqlite`. New advisory query for Live State; the existing advisory feedback-loop in `context-assembly.ts:362–:389` is unchanged (it is a different code path serving a different purpose — see Task 4 notes).

**Scope:** 4 of 7 phases.

**Codebase verified:** 2026-05-22 against commit `36dc9f2e`. `buildCrossThreadDigest` body construction at `summary-extraction.ts:391–:430`, with the `Recent Activity Digest:` header at `:391`, the title+count+last-update line at `:401`, the `Summary: <truncated>` line at `:409`, and `CrossThreadSource` provenance tracking at `:417–:430`. File-modification notice format string at `context-assembly.ts:305` (current shape: `File ${filePath} was modified from thread "${threadTitle}".`). Existing advisory feedback-loop at `context-assembly.ts:362–:389` queries `status IN ('approved','applied','dismissed')` for sites the local site authored, dedupes by title, and emits `[Advisory notification]` lines. Task-digest computation path produces the lines pushed at `context-assembly.ts:273`; the exact shape is investigated again at Task 5 since the codebase-investigator noted only the rendered output, not the producer.

---

## Acceptance Criteria Coverage

This phase implements:

### volatile-context.R-VC2 (Live State header)

- **R-VC2 (literal, Live State portion):** "`## Live State — pointers to canonical sources`".

### volatile-context.R-VC5

- **R-VC5 (literal):** "The Live State section shall contain: the cross-thread digest (`buildCrossThreadDigest` output), file modification notices, applied advisories, and the task run digest (R-MV6/R-MV7/R-MV8/R-MV9 content currently rendered between Memory and Cross-Thread Digest). Each entry shall render with an explicit source label naming the kind of pointer (`[thread]`, `[file]`, `[advisory]`, `[task]`)."

### volatile-context.R-VC6 (Live State footer)

- **R-VC6 (literal, Live State portion):** "Live State's footer reads: `Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.`."

### volatile-context.R-VC7

- **R-VC7 (literal):** "The cross-thread digest produced by `buildCrossThreadDigest` shall render each sibling thread as a single line: `- <title>: N messages (last updated <timestamp>)`. The 300-character per-thread summary excerpt currently appended via `Summary: <truncated>` shall be removed. Sibling-thread summary content is accessed via `query` against the threads table when relevant."

### volatile-context.R-VC12

- **R-VC12 (literal):** "When an advisory was applied (status = 'applied') within the prior 24 hours, the advisory shall render under Live State as `[advisory] <title> — applied <relative_time>`; the advisory body is accessed via `query` against the advisories table."

### volatile-context.R-VC13

- **R-VC13 (literal):** "When a file modification notice is generated (R-E20), the notice shall render under Live State as `[file] <path> — last modified by thread \"<thread_title>\"`; the file body is accessed via `boundless_read` or equivalent."

### volatile-context.R-VC14 (budget-pressure path — Live State half)

- **R-VC14 (literal, Live State half):** "Live State entries are reduced to the most recent 3 of each subsystem (cross-thread, file, advisory, task digest)…"

### volatile-context.R-VC15 trailing rule (synthesis-backlog line)

- **R-VC15 trailing rule (literal):** "When Tier 3 is active, the `Uncategorized` cluster surfaces a `[synthesis-backlog] {N} uncategorized detail entries` line in Live State if N exceeds 50, since uncategorized entries have no parent summary and their long-tail loss has no R-VC9b mitigation. The `[synthesis-backlog]` label distinguishes this synthetic line from `[advisory]` entries, which are backed by rows in the `advisories` table."

### volatile-context.R-VC22 (top-level header typography uniformity — Live State half)

- Same literal as Phase 2; Live State's `## Live State — pointers to canonical sources` header uses uniform `##` typography.

### volatile-context.R-VC23

- **R-VC23 (literal):** "The cross-thread digest shall not render any sibling thread's summary excerpt; only title, message count, and last-updated timestamp are rendered (R-VC7). This is the structural fix for the d0372be6 confabulation pattern (§1.3) — the typographic similarity between summary excerpts and ground-truth content is what enables the agent to mistake digest stubs for live state."

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Modify `buildCrossThreadDigest` — drop summary excerpt, emit `[thread]` label, return structured rows

**Type:** Functionality.

**Verifies:** volatile-context.R-VC7, R-VC23.

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — change the body construction at `:391–:430`.

**Implementation:**

`buildCrossThreadDigest` currently returns `{ text: string; sources: CrossThreadSource[] }`. The Live State renderer needs structured per-thread rows so it can apply R-VC14's most-recent-3 budget shedding and prepend the `[thread]` source label uniformly with the other Live State subsystems. Extend the return shape additively:

```typescript
export interface CrossThreadDigestEntry {
    title: string;
    messageCount: number;
    lastUpdatedAt: string; // ISO-8601 from threads table
}

export interface CrossThreadDigestResult {
    /** Existing field preserved for backward compatibility with any non-Live-State caller. */
    text: string;
    /** Existing field preserved. */
    sources: CrossThreadSource[];
    /** New: structured per-thread rows for Live State composition. */
    entries: CrossThreadDigestEntry[];
}

export function buildCrossThreadDigest(
    db: Database,
    userId: string,
    excludeThreadId?: string,
): CrossThreadDigestResult {
    // ... existing query ...
    const entries: CrossThreadDigestEntry[] = [];
    // For each row that previously produced a digest line:
    //   1. Push { title, messageCount, lastUpdatedAt } to entries.
    //   2. Continue producing the existing `text` lines, but DROP the `Summary: <truncated>` line.
    //   3. Replace the existing dash-prefixed line with the new shape:
    //      `- ${title}: ${messageCount} messages (last updated ${lastUpdatedAt})`
    //      (No source label here — the renderer adds `[thread]` so all subsystems share label vocabulary.)
}
```

Specific edit points (verified from the investigator report):

- **`:391` `Recent Activity Digest:` header line:** **DELETE** in this task. Verified callers of `buildCrossThreadDigest` outside `summary-extraction.ts`:
   - `context-assembly.ts:281` — being replaced by Phase 5 Task 3.
   - `packages/agent/src/__tests__/volatile-enrichment.test.ts` — five tests destructure `{ text, sources }`. These tests must be updated in this same task to drop assertions on the old header (and on the now-removed `Summary:` excerpt — see Task 2). No other callers exist (verified via repo-wide `grep -rn "buildCrossThreadDigest" packages/`).
   - The `text` field continues to exist (back-compat with `sources` consumers), but its content shifts to bare `- {title}: {N} messages (last updated {ts})` lines without a leading section header. Phase 5 Task 3 then composes the Live State header itself when consuming `entries`.
- **`:401` title+count+last-update line:** keep producing this line in `text` but adjust to the spec's new shape. The line renders as `- ${title}: ${messageCount} messages (last updated ${lastUpdatedAt})` — no `[thread]` prefix here; the renderer adds it.
- **`:409` `Summary: <truncated>` line:** delete unconditionally. R-VC23 requires removal.
- **`:417–:430` `CrossThreadSource` provenance tracking:** unchanged. The renderer does not consume `sources`; only `entries`.

Notes:

- The 300-character truncation logic for the summary excerpt is removed entirely along with the line that emits it. Search the function for any remaining truncation step that becomes dead code and remove it in the same edit.
- The `excludeThreadId` parameter (verified — it excludes the agent's own thread) is unchanged. The d0372be6 thread's confabulation manifested even though the digest is sibling-only; the structural fix is per R-VC23 (no excerpts at all), not changing `excludeThreadId`.
- Existing callers that consume `text` continue to work — they just see one less line per thread (the `Summary: …` one). New caller (Phase 5) consumes `entries`.

**Step 1: Inspect the current function body at `summary-extraction.ts:364`–:430 to confirm the row producer shape.**

**Step 2: Add `CrossThreadDigestEntry` and the `entries` field to the return type.**

**Step 3: Modify the body — drop the `Recent Activity Digest:` header at `:391`, drop the `Summary: <truncated>` emission at `:409`, populate `entries`, adjust the dash-prefixed line shape per R-VC7.**

**Step 3b: Update `packages/agent/src/__tests__/volatile-enrichment.test.ts` to drop assertions on the legacy header and the `Summary:` excerpt.** The five test cases that destructure `text` from `buildCrossThreadDigest` must be revisited; some will need rewrites because the lines they assert on no longer exist.

**Step 4: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 5: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): drop sibling-thread summary excerpts; expose entries for Live State"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test `buildCrossThreadDigest` changes

**Type:** Functionality.

**Verifies:** volatile-context.R-VC7, R-VC23.

**Files:**
- Modify or create: `packages/agent/src/__tests__/build-cross-thread-digest.test.ts` (create if no equivalent exists).

**Implementation:**

Tests against a real temp `bun:sqlite` database. Use the project pattern.

1. **No `Summary:` line in output `text`.** Insert two threads with non-empty `summary` fields; call `buildCrossThreadDigest`. Assert `result.text` does not contain the substring `"Summary: "`. Verifies R-VC23.

2. **`entries` array populated with structured rows.** Same fixture; assert `result.entries` has two `CrossThreadDigestEntry` items with the expected `title`, `messageCount`, `lastUpdatedAt`.

3. **`excludeThreadId` excludes the agent's own thread.** Insert three threads; pass one's id as `excludeThreadId`; assert `entries` has exactly two items, neither matching the excluded id.

4. **Empty result.** Database with no threads (other than possibly the excluded one). Assert `entries` is `[]` and `text` is the empty-result string the function already returns (preserved behavior).

5. **`text` line shape per R-VC7.** For each remaining thread, the corresponding `text` line matches `^- .+: \d+ messages \(last updated .+\)$`. Verifies R-VC7's literal shape (without the `[thread]` prefix, which is added by the Live State renderer in Task 6).

6. **`CrossThreadSource` preservation.** Assert `result.sources` is non-empty and matches the existing shape — back-compat invariant.

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/build-cross-thread-digest.test.ts`

Expected: 6 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/build-cross-thread-digest.test.ts
git commit -m "test(agent): cover buildCrossThreadDigest summary-excerpt removal + entries"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Add `loadAppliedAdvisoriesForLiveState` query

**Type:** Functionality.

**Verifies:** volatile-context.R-VC12 (data-layer half).

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — add the new query function.

**Implementation:**

Spec R-VC12 requires advisories where `status = 'applied'` within the prior 24 hours. This is a different query from the existing advisory feedback-loop at `context-assembly.ts:362–:389` (which uses `status IN ('approved', 'applied', 'dismissed')` for advisories the local site authored, dedupes by title, and emits operator-feedback notifications). The Live State query is broader (any applied advisory, regardless of authoring site) and narrower (status='applied' only, not 'approved' or 'dismissed').

```typescript
export interface LiveStateAdvisory {
    title: string;
    /** ISO timestamp of the apply-status transition. */
    appliedAt: string;
}

export function loadAppliedAdvisoriesForLiveState(
    db: Database,
    nowMs: number,
): LiveStateAdvisory[] {
    // CONTRIBUTING.md gotcha: never use SQLite datetime('now', '-24 hours') against
    // ISO-8601 timestamps; compute the cutoff in JS and pass as a parameter.
    const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const rows = db
        .prepare(
            "SELECT title, resolved_at FROM advisories WHERE status = 'applied' AND deleted IS NOT 1 AND resolved_at IS NOT NULL AND resolved_at >= ? ORDER BY resolved_at DESC",
        )
        .all(cutoff) as Array<{ title: string; resolved_at: string }>;
    return rows.map((r) => ({ title: r.title, appliedAt: r.resolved_at }));
}
```

Notes:

- `resolved_at` is the canonical timestamp for `applied` transitions per the project memory (CLAUDE.md "advisory dedup/cap": "applied" sets `resolved_at`).
- The 24-hour window matches R-VC12's literal text. Computed in JS per the recurring SQLite/ISO-8601 gotcha documented in CONTRIBUTING.md.
- `deleted IS NOT 1` matches the synced-table soft-delete invariant (#2 in CONTRIBUTING.md critical invariants).
- The function does not de-dupe by title (unlike the §6.2 feedback-loop) — Live State surfaces each applied advisory as a distinct pointer because the operator may apply the same-titled advisory more than once over a 24-hour window and each application is independently relevant.

**Step 1: Add the function and the result type.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): add loadAppliedAdvisoriesForLiveState query for R-VC12"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Test `loadAppliedAdvisoriesForLiveState`

**Type:** Functionality.

**Verifies:** volatile-context.R-VC12 (data-layer half).

**Files:**
- Create: `packages/agent/src/__tests__/load-applied-advisories.test.ts`

**Implementation:**

Tests:

1. **Empty advisories table → empty result.**

2. **Status filter — only 'applied' is returned.** Insert one advisory each at status `proposed`, `approved`, `applied`, `dismissed`. Result has exactly one row (the applied one).

3. **24-hour window filter.** Insert three advisories at status `applied` with `resolved_at` 1h, 23h, 25h ago. Result has the first two; the 25h-ago row is excluded.

4. **Soft-delete filter.** Insert two `applied` advisories within the window; soft-delete one. Result has only the survivor.

5. **Ordering.** Result is ordered by `resolved_at` DESC.

6. **Title preserved verbatim.** Special characters (em-dash, quotes) round-trip unchanged.

7. **No duplicate suppression.** Insert two advisories with identical titles, both applied within the window. Result has both rows.

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/load-applied-advisories.test.ts`

Expected: 7 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/load-applied-advisories.test.ts
git commit -m "test(agent): cover loadAppliedAdvisoriesForLiveState filters"
```
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Implement `renderLiveState`

**Type:** Functionality.

**Verifies:** volatile-context.R-VC2, R-VC5, R-VC6, R-VC12 (rendering half), R-VC13, R-VC14 (Live State half), R-VC15 trailing rule, R-VC22.

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — add the renderer.

**Implementation:**

Before writing, the implementor must read `context-assembly.ts:273` and the surrounding ~40 lines to identify the producer of the current task-digest lines. Investigation noted only that the digest is "rendered by task-related code" — the implementor confirms the producer's exact name and shape (likely something like `buildTaskRunDigest` or rendering inline inside `buildVolatileEnrichment`) and uses that producer's structured output as input to `renderLiveState`.

```typescript
export interface LiveStateTaskEntry {
    taskId: string;
    taskType: string;
    runCount: number;
    lastRunAt: string;
    status: string;
}

export interface LiveStateFileEntry {
    path: string;
    threadTitle: string;
}

export interface LiveStateInput {
    crossThreadEntries: CrossThreadDigestEntry[];
    taskEntries: LiveStateTaskEntry[];
    fileEntries: LiveStateFileEntry[];
    advisories: LiveStateAdvisory[];
    /** From renderDiscoverableArchive output. Null when Tier 3 inactive or Uncategorized ≤ 50. */
    synthesisBacklogCount: number | null;
    budgetPressure: boolean;
    nowMs: number;
}

const LIVE_STATE_HEADER = "## Live State — pointers to canonical sources";
const LIVE_STATE_FOOTER =
    'Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.';
const BUDGET_PRESSURE_SUBSYSTEM_CAP = 3;

export function renderLiveState(input: LiveStateInput): RenderedSection {
    const lines: string[] = [];
    lines.push(LIVE_STATE_HEADER);
    lines.push("");

    const cap = (arr: unknown[]) =>
        input.budgetPressure ? arr.slice(0, BUDGET_PRESSURE_SUBSYSTEM_CAP) : arr;

    // §5.3 step 1 — cross-thread.
    for (const e of cap(input.crossThreadEntries) as CrossThreadDigestEntry[]) {
        lines.push(
            `- [thread] ${e.title}: ${e.messageCount} messages (last updated ${e.lastUpdatedAt})`,
        );
    }
    // §5.3 step 2 — task digest.
    for (const t of cap(input.taskEntries) as LiveStateTaskEntry[]) {
        lines.push(
            `- [task] ${t.taskId} (${t.taskType}): run_count=${t.runCount}, last_run_at=${t.lastRunAt}, status=${t.status}`,
        );
    }
    // §5.3 step 3 — file mods.
    for (const f of cap(input.fileEntries) as LiveStateFileEntry[]) {
        lines.push(`- [file] ${f.path} — last modified by thread "${f.threadTitle}"`);
    }
    // §5.3 step 4 — applied advisories.
    for (const a of cap(input.advisories) as LiveStateAdvisory[]) {
        lines.push(
            `- [advisory] ${a.title} — applied ${relativeTimeFragment(a.appliedAt, input.nowMs)}`,
        );
    }
    // §5.3 trailing rule — synthesis-backlog line.
    if (input.synthesisBacklogCount !== null) {
        lines.push(
            `- [synthesis-backlog] ${input.synthesisBacklogCount} uncategorized detail entries`,
        );
    }

    lines.push("");
    lines.push(LIVE_STATE_FOOTER);
    return { lines };
}
```

Notes:

- `relativeTimeFragment` is the helper introduced in Phase 3. Re-export or co-locate as needed; do NOT re-implement.
- The four subsystems render in fixed order (cross-thread → task → file → advisory → synthesis-backlog) per §5.3. The synthesis-backlog line is positioned last because it is a synthetic computed signal, not backed by a row in any table.
- R-VC14 budget-pressure shedding: each subsystem is capped at most-recent-3. The synthesis-backlog line is a single derived line, not a list, so the cap does not apply to it.
- The `[file]` line uses an em-dash separator (verified literal in spec §3.2 R-VC13) — match the character exactly.
- The `[task]` line shape follows §4.2 example: `[task] {task_id} ({task_type}): run_count={N}, last_run_at={timestamp}, status={status}`. The literal field names (`run_count`, `last_run_at`, `status`) match the spec; do not stylize.

**Step 1: Read `context-assembly.ts:273` ±40 lines and confirm task-digest producer shape.**

**Step 2: Add the input/output types and the renderer.**

**Step 3: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 4: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): implement renderLiveState"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Test `renderLiveState`

**Type:** Functionality.

**Verifies:** volatile-context.R-VC2, R-VC5, R-VC6, R-VC12, R-VC13, R-VC14, R-VC15 trailing rule, R-VC22.

**Files:**
- Create: `packages/agent/src/__tests__/render-live-state.test.ts`

**Implementation:**

Pure-function tests, no DB.

1. **Empty input.** All subsystems empty. Output is `[header, "", "", footer]`.

2. **Cross-thread subsystem.** Two entries. Output has two `- [thread] {title}: {N} messages (last updated {ts})` lines. Verifies §5.3 step 1.

3. **Task subsystem.** Two entries. Output has two `- [task] {id} ({type}): run_count=…, last_run_at=…, status=…` lines. Verifies §5.3 step 2.

4. **File subsystem.** Two entries. Output has two `- [file] {path} — last modified by thread "{title}"` lines. Verifies R-VC13.

5. **Advisory subsystem.** Two entries with `appliedAt` 30m and 6h ago. Output has two `- [advisory] {title} — applied {relative_time}` lines. Verifies R-VC12.

6. **All four subsystems composed.** Mixed input. Verifies §5.3 fixed order: cross-thread → task → file → advisory.

7. **Synthesis-backlog line raised.** `synthesisBacklogCount: 75`. Output contains `- [synthesis-backlog] 75 uncategorized detail entries` after the four subsystems.

8. **Synthesis-backlog line not raised.** `synthesisBacklogCount: null`. Output contains no `[synthesis-backlog]` line.

9. **Budget-pressure caps each subsystem to 3.** Construct 5 entries in each subsystem, set `budgetPressure: true`. Output renders 3 of each. Verifies R-VC14 Live State half.

10. **Budget-pressure does not affect the synthesis-backlog line.** Single synthesis-backlog signal renders even with `budgetPressure: true`.

11. **Header and footer literals.** Assert exact strings per R-VC2 + R-VC6.

12. **Source-label distinction (R-VC15 trailing rule).** Verify a fixture with both `[advisory]` and `[synthesis-backlog]` entries renders both labels distinctly. Verifies the spec's "label distinguishes this synthetic line from `[advisory]` entries" rule.

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/render-live-state.test.ts`

Expected: 12 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/render-live-state.test.ts
git commit -m "test(agent): cover renderLiveState subsystems and budget pressure"
```
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase 4 Done When

- All six tasks committed.
- `bun test packages/agent/src/__tests__/build-cross-thread-digest.test.ts` passes 6 tests.
- `bun test packages/agent/src/__tests__/load-applied-advisories.test.ts` passes 7 tests.
- `bun test packages/agent/src/__tests__/render-live-state.test.ts` passes 12 tests.
- `bun run typecheck` passes.
- `buildCrossThreadDigest` no longer emits `Summary: <truncated>` lines anywhere in any caller's output — including callers not yet aware of the new `entries` field.
- `renderLiveState`, `loadAppliedAdvisoriesForLiveState`, and the new types are exported. Phase 5 wires them into `buildVolatileContext`.
