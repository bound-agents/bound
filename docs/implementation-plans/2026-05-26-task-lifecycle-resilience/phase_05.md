# Phase 5: Annotation Rewrites + PR Gate + Exhaustive Audit (R-LR5 + R-LR6 + R-LR12)

**Goal:** Land the documentation/audit cleanup pass once the runtime changes are in. R-LR5 rewrites the now-misleading `outbox-exempt` comments at the six raw-CAS-with-explicit-changelog scheduler.ts sites and similar sites elsewhere, and removes the comments at the heartbeat-refresh sites that became outbox-routed in Phase 2. R-LR6 codifies the PR-gate referencing CONTRIBUTING.md as the authoritative narrow-exception source. R-LR12 produces the one-time exhaustive audit disposition table — every existing `outbox-exempt` annotation gets a category (justified / fixed / non-synced / known-deferred / comment-only). At RFC close, exactly one known-deferred site: `relay-metrics.ts:48` (`turns.relay_target` and `turns.relay_latency_ms` writes).

**Architecture:** No runtime code changes; this is a documentation + lint/CI gate phase. The repo already has `scripts/validate-outbox-invariant.ts` running in CI (`.github/workflows/ci.yml:31-32`); R-LR6 extends its scope (or adds a sibling check) to enforce that every active `outbox-exempt` annotation appears in CONTRIBUTING.md's audit disposition table. The disposition table is the seed.

**Tech Stack:** Markdown (CONTRIBUTING.md), TypeScript (CI script), `bun:test` for the script's unit test.

**Scope:** 1 phase from a 5-phase RFC implementation (Phase 5 of 5). Per RFC §4.1, this phase ships LAST. R-LR12's exhaustive audit is enabled by Phases 1-4 having moved every fixable annotation off the synced-table-write list, so the residual list is small and tractable.

**Codebase verified:** 2026-05-26 via codebase-investigator. Key facts:
- 30+ active `outbox-exempt` annotations across 13 files, plus 2 comment-only references. The audit disposition table is included verbatim below — Phase 5 turns it into CONTRIBUTING.md content.
- Existing PR gate: `.github/workflows/ci.yml:31-32` runs `scripts/validate-outbox-invariant.ts` which scans `packages/*/src/**/*.ts` for direct SQL mutations (`INSERT|UPDATE|DELETE`) on synced tables and exits non-zero on violations. Lines containing `// outbox-exempt` are skipped. **The current validator does NOT cross-check exemptions against CONTRIBUTING.md.** R-LR6 extends it.
- CONTRIBUTING.md is at the repo root. The narrow-exception list lives only in CLAUDE.md today (which is gitignored per RFC §2.4). R-LR6 adds a "Documented Narrow Exceptions to Invariant #1" section to CONTRIBUTING.md (the gitignored CLAUDE.md is operator-context, not authoritative-traveling-with-the-repo).
- 3 annotations on `overlay_index` writes in `packages/sandbox/src/overlay-scanner.ts` (lines 128, 148, 168) say "outbox not provided (backward compat)". `overlay_index` IS a synced table per `SyncedTableName`. Investigator flagged these as INCORRECT — the writes should route through `insertRow` / `updateRow` / `softDelete`, not exempt themselves. Phase 5 R-LR12's audit categorizes these as **(d) known-deferred** with a TODO comment referencing a follow-up RFC, since fixing them properly is out of scope for this RFC (per RFC's explicit DoD: "non-task fixes file separately"). The RFC text says "exactly one known-deferred site: `relay-metrics.ts:48`" — Phase 5's audit must reconcile this. **Resolution**: surface this discrepancy to the user (see Task 4 below). The likely outcome is a second known-deferred bullet for overlay-scanner with the same TODO-link treatment, OR a Phase-5-internal fix routing the three sites through outbox helpers.

---

## Acceptance Criteria Coverage

This phase implements:

### task-lifecycle-resilience: R-LR5, R-LR6, R-LR9, R-LR12 (no automated AC per §3.4)

Per RFC §3.4: "R-LR5, R-LR6, R-LR9, and R-LR12 are doc / gate / logging requirements with no automated AC; they are validated by manual review." (R-LR9 is implemented in Phase 1 Task 2's healer logging.)

The phase's "done when" criteria substitute for ACs:
- Every `outbox-exempt` annotation in the repo has a category in CONTRIBUTING.md's audit table.
- The CI gate enforces that new `outbox-exempt` annotations require a CONTRIBUTING.md entry (or fall into one of the auto-allowed categories: non-synced table, known-deferred with TODO link).
- Annotations at scheduler sites are rewritten to be self-documenting per RFC §2.3.

---

<!-- START_TASK_1 -->
### Task 1: Rewrite scheduler.ts annotations at the six raw-CAS sites + heartbeat refresh removals

**Verifies:** None automated (manual review).

**Files:**
- Modify: `packages/agent/src/scheduler.ts:710` (pending → claimed)
- Modify: `packages/agent/src/scheduler.ts:800` (claimed → running)
- Modify: `packages/agent/src/scheduler.ts:1138` (model-validation failure → failed)
- Modify: `packages/agent/src/scheduler.ts:1291` (soft error → failed)
- Modify: `packages/agent/src/scheduler.ts:1423` (hard error → failed)
- Modify: `packages/agent/src/scheduler.ts:1530` (post-eviction reclaim — confirm during impl that this is the sixth raw-CAS site per RFC §2.3 design notes)
- Modify: `packages/cli/src/commands/start/bootstrap.ts:368, 391` (host-registration `withChangeLog` calls)
- Modify: `packages/platforms/src/leader-election.ts:73` (cluster_config + explicit changelog)
- Modify: `packages/cli/src/commands/drain.ts:42, 46, 83, 87, 101` (cluster_config + explicit changelog)
- Modify: `packages/cli/src/commands/set-hub.ts:125, 129` (cluster_config + explicit changelog)
- Modify: `packages/cli/src/commands/config-reload.ts:69, 73` (cluster_config + explicit changelog)
- Modify: `packages/cli/src/commands/stop-resume.ts:33, 37, 66` (cluster_config + explicit changelog)

**Note on heartbeat-refresh annotation removals.** Phase 2 Task 2 already removes the two `// outbox-exempt: heartbeat_at is local-only state, not synced` comments at scheduler.ts:549 and scheduler.ts:1226 when it converts the writes to `updateRowIf`. Phase 2 Task 3 already removes `// outbox-exempt: heartbeat rescheduling is local-only state, not synced` at scheduler.ts:311 when it converts `rescheduleHeartbeat` to `updateRow`. **Phase 5 does not re-remove these — they're already gone after Phase 2.**

**Implementation:**

For each raw-CAS site, rewrite the annotation to be self-documenting per RFC §2.3 design note:

> *Existing scheduler.ts CAS sites that use raw SQL + manual `createChangeLogEntry` are not exemptions.* [...] *R-LR5 rewrites these annotations to make the structure self-documenting (e.g., `outbox-routed: explicit createChangeLogEntry follows the CAS UPDATE in this transaction`).*

Mapping — current → new annotation:

| File:line | Current | New |
|-----------|---------|-----|
| scheduler.ts:710 | `// outbox-exempt: CAS update in transaction, followed by createChangeLogEntry` | `// outbox-routed: explicit createChangeLogEntry follows the CAS UPDATE in this transaction (pending → claimed)` |
| scheduler.ts:800 | `// outbox-exempt: CAS update in transaction, followed by createChangeLogEntry` | `// outbox-routed: explicit createChangeLogEntry follows the CAS UPDATE in this transaction (claimed → running, includes heartbeat_at)` |
| scheduler.ts:1138 | `// outbox-exempt: UPDATE in transaction, followed by createChangeLogEntry` | `// outbox-routed: explicit createChangeLogEntry follows the UPDATE in this transaction (running → failed, model-validation path)` |
| scheduler.ts:1291 | `// outbox-exempt: UPDATE in transaction, followed by createChangeLogEntry` | `// outbox-routed: explicit createChangeLogEntry follows the UPDATE in this transaction (running → failed, soft-error path)` |
| scheduler.ts:1423 | `// outbox-exempt: UPDATE in transaction, followed by createChangeLogEntry` | `// outbox-routed: explicit createChangeLogEntry follows the UPDATE in this transaction (running → failed, hard-error path)` |
| scheduler.ts:1530 | `// outbox-exempt: CAS update in transaction, followed by createChangeLogEntry` | `// outbox-routed: explicit createChangeLogEntry follows the CAS UPDATE in this transaction (post-eviction reclaim)` |
| bootstrap.ts:368, 391 | `// outbox-exempt: withChangeLog handles changelog entry` | `// outbox-routed: withChangeLog(db, siteId, callback) emits the changelog entry` |
| leader-election.ts:73 | `// outbox-exempt: createChangeLogEntry called below` | `// outbox-routed: explicit createChangeLogEntry follows the INSERT...CONFLICT in this transaction (cluster_config leader election)` |
| drain.ts:42, 46, 83, 87, 101 | `// outbox-exempt: createChangeLogEntry called below` | `// outbox-routed: explicit createChangeLogEntry follows the SQL operation in this transaction (cluster_config drain command)` |
| set-hub.ts:125, 129 | `// outbox-exempt: createChangeLogEntry called below` | `// outbox-routed: explicit createChangeLogEntry follows the SQL operation in this transaction (cluster_config set-hub command)` |
| config-reload.ts:69, 73 | `// outbox-exempt: createChangeLogEntry called below` | `// outbox-routed: explicit createChangeLogEntry follows the SQL operation in this transaction (cluster_config config-reload command)` |
| stop-resume.ts:33, 37, 66 | `// outbox-exempt: createChangeLogEntry called below` | `// outbox-routed: explicit createChangeLogEntry follows the SQL operation in this transaction (cluster_config stop-resume command)` |

**CI implication.** Once these annotations are rewritten away from the literal `outbox-exempt` substring, the existing `scripts/validate-outbox-invariant.ts` (which skips lines containing `// outbox-exempt`) will start flagging the now-non-skipped raw SQL writes as violations. **Task 2 fixes the validator to recognize the new `outbox-routed` annotation as also-permitted**, so the rewrite + validator update must land together (one PR or two PRs in close succession). Sequence Task 1 and Task 2 commits accordingly OR squash them.

**Verification:**

```bash
bun run lint        # biome should still pass; comment text is not lint-relevant
bun run typecheck   # no type changes
bun run scripts/validate-outbox-invariant.ts   # MUST pass — depends on Task 2's update landing
```

If running validate-outbox-invariant.ts before Task 2 lands fails, that's expected — the sequencing forces Task 1 + Task 2 to land atomically.

**Commit (sequenced with Task 2):**
```bash
git add packages/agent/src/scheduler.ts packages/cli/src/commands/start/bootstrap.ts packages/platforms/src/leader-election.ts packages/cli/src/commands/drain.ts packages/cli/src/commands/set-hub.ts packages/cli/src/commands/config-reload.ts packages/cli/src/commands/stop-resume.ts
git commit -m "docs(agent,cli): rewrite outbox-exempt → outbox-routed annotations (R-LR5)"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update CI validator to recognize `outbox-routed` and enforce CONTRIBUTING.md cross-check

**Verifies:** None automated for the AC; this IS the R-LR6 PR-gate.

**Files:**
- Modify: `scripts/validate-outbox-invariant.ts` (current scope: skips lines containing `// outbox-exempt`; extend to recognize `// outbox-routed` and to cross-check `// outbox-exempt` against CONTRIBUTING.md)
- Create or modify: `scripts/__tests__/validate-outbox-invariant.test.ts` (unit test for the validator's new behavior; if no test exists, create one)

**Implementation:**

The current validator scans for direct SQL mutations on synced tables and skips lines tagged `// outbox-exempt`. Update to:

1. **Skip `// outbox-routed` annotated lines too.** A line tagged `outbox-routed` is asserting that an explicit `createChangeLogEntry` (or `withChangeLog` wrapper) follows the SQL in the same transaction, and the validator can trust the assertion (the assertion is itself reviewed at PR time per the new gate).

2. **Enforce CONTRIBUTING.md cross-check on `// outbox-exempt` lines.** When the validator encounters a line with `// outbox-exempt` annotation, it reads CONTRIBUTING.md (specifically the "Documented Narrow Exceptions to Invariant #1" section produced by Task 3 below) and verifies that:
   - The (file, table.column-or-table-or-broad-category) combination appears in the disposition table, OR
   - The annotation falls under category (c) "non-synced table" — i.e., the table being written to is NOT in `SyncedTableName`. (For overlap, the validator already knows the synced-table list from its current logic.)
   - For category (d) "known-deferred", the line must include a `TODO` link comment to the follow-up RFC issue/file (the validator can grep for `TODO` adjacent to the annotation).

   If a `// outbox-exempt` line doesn't match any of those, fail the build with a clear error pointing to CONTRIBUTING.md and instructing the contributor to either (a) add an entry to the audit table with category, or (b) convert to `outbox-routed` if the annotation incorrectly described the structure.

3. **Backward compat.** Existing `// outbox-exempt` annotations that survived Phase 5 (the small residual list — `semantic_memory.last_accessed_at` and `relay-metrics.ts:48`) MUST be in the disposition table. Task 3 ensures they are.

**Sketch:**

```typescript
// scripts/validate-outbox-invariant.ts (extended)
const SKIP_PATTERNS = [/\/\/ outbox-exempt/, /\/\/ outbox-routed/];

// On encountering an `outbox-exempt`-tagged violation, look up CONTRIBUTING.md.
function isExemptionDocumented(file: string, line: number, table: string): boolean {
    const contributing = readFileSync("CONTRIBUTING.md", "utf-8");
    const auditSection = extractAuditSection(contributing);  // helper to slice the markdown section
    // The audit table has rows like: | file:line | table.column | category | disposition |
    // Match by file path (with optional line-tolerance), or by `table` if the entry uses a broad category.
    return auditSection.includes(file) /* refine */ ;
}
```

**Matching strategy (specific, not heuristic).** For each `outbox-exempt` line:

1. Compute `(filePath, lineNumber, targetTable)` — the file, the source line, and the table being written to (already known to the validator from its existing synced-table detection).
2. Parse CONTRIBUTING.md's audit table; for each row, extract `(filePath_pattern, targetTable_pattern, category)`. The `filePath_pattern` may include line numbers (e.g., `packages/agent/src/scheduler.ts:710`); when present, match exactly. When the pattern is just a file path, accept any line in that file. `targetTable_pattern` is matched as a literal substring (e.g., `tasks (running → failed, soft-error path)` contains `tasks`).
3. The line passes if EITHER:
   - A row matches `filePath_pattern` AND `targetTable_pattern` AND has category in `{(a), (d)}`, OR
   - The target table is NOT in `SyncedTableName` (category-c rule, validator already knows the synced-table list), OR
   - For category-(d) matches, the line additionally contains a `TODO` token within 5 lines before/after.

**Known false-negative modes** (acceptable for v1, document in the validator's preamble):
- A file with multiple `outbox-exempt` annotations on different tables and only one CONTRIBUTING.md row may pass spuriously if the row's `targetTable` substring matches both. Mitigation: the v1 strategy requires exact line-number match when the audit row provides one; the post-RFC audit table lists every annotation by file:line.
- A file rename that's not reflected in CONTRIBUTING.md will silently invalidate matches; surface this via PR-review checklist rather than validator logic.

The PR reviewer is the ultimate gate; the validator's job is to ensure no NEW annotation slips in without a matching disposition row.

**Testing:**

Unit test in `scripts/__tests__/validate-outbox-invariant.test.ts`:
- A fixture file with `// outbox-routed` annotation is NOT flagged.
- A fixture file with `// outbox-exempt` annotation that matches a CONTRIBUTING.md entry is NOT flagged.
- A fixture file with `// outbox-exempt` annotation that does NOT match CONTRIBUTING.md IS flagged with the actionable error message.
- A fixture file with `// outbox-exempt` annotation on a non-synced table is NOT flagged regardless of CONTRIBUTING.md (category-c rule).
- A fixture file with `// outbox-exempt` annotation on a synced table with NO `TODO` and NOT in CONTRIBUTING.md IS flagged.

**Verification:**

```bash
bun run typecheck
bun test scripts/__tests__/validate-outbox-invariant.test.ts
bun run scripts/validate-outbox-invariant.ts   # must pass against the actual repo state
```

**Commit:**
```bash
git add scripts/validate-outbox-invariant.ts scripts/__tests__/validate-outbox-invariant.test.ts
git commit -m "feat(ci): enforce outbox-exempt annotations match CONTRIBUTING.md audit table (R-LR6)"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add narrow-exception list and exhaustive audit disposition to CONTRIBUTING.md

**Verifies:** R-LR12.

**Files:**
- Modify: `CONTRIBUTING.md` (add a new section after "Critical Invariants" — the natural insertion point per Phase 5 investigator)

**Implementation:**

Add two new sub-sections to CONTRIBUTING.md, structured to be self-explanatory both for human reviewers and for the CI validator's grep-style cross-check.

**Section A: "Documented Narrow Exceptions to Invariant #1"** — duplicates the canonical entry from CLAUDE.md (CLAUDE.md is gitignored / local operator context; CONTRIBUTING.md is the authoritative source that travels with the repo per RFC §2.4):

```markdown
### Documented Narrow Exceptions to Invariant #1 (outbox pattern)

The outbox is mandatory for all writes to synced tables EXCEPT for the explicitly-justified
per-host hint columns listed below. Each exception is local-relevance-only with no cross-host
correctness invariant, and routing through `updateRow` would either cascade into stale-child
detection (advancing `modified_at`) or generate wasteful change-log volume for a signal other
hosts ignore. Do not extend this list without writing down the same justification.

- **`semantic_memory.last_accessed_at`**, bumped by `bumpRenderedDetailEntries` in
  `packages/agent/src/summary-extraction.ts` from `buildVolatileContext` on every cold
  assembly (debounced 1h per entry). Justified because (a) per-host relevance hint with no
  cross-host correctness invariant, (b) routing through `updateRow` would advance
  `modified_at` along with it, cascading into `buildStaleChildrenMap` and misclassifying
  every actively-rendered detail entry as stale, and (c) per-cold-assembly bumps would
  generate wasteful change-log volume for a signal other hosts ignore.

The PR review gate (R-LR6) blocks new `// outbox-exempt` annotations on synced-table writes
unless the new exemption is added to this list with the same justification format, OR the
write is on a non-synced table (category c below), OR the annotation is `// outbox-routed`
(asserting an explicit `createChangeLogEntry` follow-up in the same transaction).
```

**Section B: "Audit Disposition Table for `outbox-exempt` Annotations"** — the one-time exhaustive audit per R-LR12. Format as a markdown table for easy validator parsing AND human review.

The categories per R-LR12:
- **(a) justified-and-documented exception** — listed in Section A above.
- **(b) fixed by this RFC** — annotation removed by R-LR1, R-LR3, R-LR5, or R-LR11.
- **(c) non-synced table** — write target is NOT in `SyncedTableName`; annotation is technically valid by definition.
- **(d) known-deferred** — synced-table write not fixed by this RFC; recorded with a TODO referencing a follow-up RFC.
- **(e) comment-only** — text mentioning "outbox-exempt" that's not an active annotation (e.g., a `// see also: outbox-exempt patterns` reference).

The table seed (from Phase 5 investigator):

```markdown
### Audit Disposition Table for `outbox-exempt` Annotations

This table is an exhaustive snapshot of every `outbox-exempt` annotation in the repo as of
2026-05-26 (RFC `2026-05-26-task-lifecycle-resilience.md` close). Categories per R-LR12.
The CI gate at `scripts/validate-outbox-invariant.ts` cross-checks new annotations against
this table.

| File:Line | Write target | Category | Disposition |
|-----------|-------------|----------|-------------|
| packages/agent/src/summary-extraction.ts:1707 | semantic_memory.last_accessed_at | (a) justified | Per-host relevance hint; see Section A above. |
| packages/agent/src/scheduler.ts:549 (REMOVED) | tasks.heartbeat_at | (b) fixed | R-LR1 routed timer-driven heartbeat refresh through outbox. |
| packages/agent/src/scheduler.ts:1226 (REMOVED) | tasks.heartbeat_at | (b) fixed | R-LR1 routed activity-driven heartbeat refresh through outbox. |
| packages/agent/src/scheduler.ts:311 (REMOVED) | tasks.next_run_at, tasks.status | (b) fixed | R-LR11 routed rescheduleHeartbeat through outbox. |
| packages/agent/src/scheduler.ts:710 (REWRITTEN) | tasks (status, claimed_by, claimed_at) | (b) fixed | R-LR5 rewrote to outbox-routed annotation; explicit createChangeLogEntry follows. |
| packages/agent/src/scheduler.ts:800 (REWRITTEN) | tasks (status, lease_id, heartbeat_at) | (b) fixed | R-LR5 rewrote to outbox-routed annotation. |
| packages/agent/src/scheduler.ts:1138 (REWRITTEN) | tasks (running → failed, model-validation) | (b) fixed | R-LR5 rewrote to outbox-routed annotation; R-LR3 added lease CAS guard. |
| packages/agent/src/scheduler.ts:1291 (REWRITTEN) | tasks (running → failed, soft-error) | (b) fixed | R-LR5 rewrote; R-LR3 added lease CAS guard. |
| packages/agent/src/scheduler.ts:1423 (REWRITTEN) | tasks (running → failed, hard-error) | (b) fixed | R-LR5 rewrote; R-LR3 added lease CAS guard. |
| packages/agent/src/scheduler.ts:1530 (REWRITTEN) | tasks (post-eviction reclaim) | (b) fixed | R-LR5 rewrote to outbox-routed annotation. |
| packages/cli/src/commands/start/bootstrap.ts:62 | tasks (status, lease_id, claimed_by, claimed_at) | (b) fixed | R-LR10 scoped reset to claimed_by = ?siteId; annotation kept as crash-recovery exemption. |
| packages/cli/src/commands/start/bootstrap.ts:368 (REWRITTEN) | hosts (registration) | (b) fixed | R-LR5 rewrote to outbox-routed annotation. |
| packages/cli/src/commands/start/bootstrap.ts:391 (REWRITTEN) | hosts (INSERT) | (b) fixed | R-LR5 rewrote to outbox-routed annotation. |
| packages/platforms/src/leader-election.ts:73 (REWRITTEN) | cluster_config (leader election) | (b) fixed | R-LR5 rewrote. |
| packages/cli/src/commands/drain.ts:42, 46, 83, 87, 101 (REWRITTEN) | cluster_config | (b) fixed | R-LR5 rewrote. |
| packages/cli/src/commands/set-hub.ts:125, 129 (REWRITTEN) | cluster_config | (b) fixed | R-LR5 rewrote. |
| packages/cli/src/commands/config-reload.ts:69, 73 (REWRITTEN) | cluster_config | (b) fixed | R-LR5 rewrote. |
| packages/cli/src/commands/stop-resume.ts:33, 37, 66 (REWRITTEN) | cluster_config | (b) fixed | R-LR5 rewrote. |
| packages/core/src/relay-metrics.ts:48 | turns.relay_target, turns.relay_latency_ms | (d) known-deferred | Synced-table write not fixed by this RFC. `turns` is synced; these columns are local-only instrumentation. TODO: follow-up RFC to either route through outbox or formalize as a Section A exception. |
| packages/sandbox/src/overlay-scanner.ts:128, 148, 168 | overlay_index (INSERT, UPDATE, soft-delete) | (d) known-deferred — pending decision in Task 4 | Investigator flagged: `overlay_index` IS synced. Annotation says "outbox not provided (backward compat)". TODO: follow-up RFC to convert these to `insertRow`/`updateRow`/`softDelete`. |
| packages/agent/src/task-resolution.ts:428 | tasks.no_history | (d) known-deferred — verify in Task 4 | Annotation says "legacy migration". Confirm during impl whether this is active code or dead-code; if active, file follow-up RFC. |
| packages/agent/scripts/agent-harness/driver.ts:51 | (none — comment-only) | (e) comment-only | Reference / educational note. |
| packages/agent/src/validation/run-stable-prefix-drift-validation.ts:219 | (none — comment-only) | (e) comment-only | Reference to `bumpRenderedDetailEntries` exception. |
```

**Note on the audit table.** The table seed above includes every annotation found by Phase 5 investigator. Where category (b) "fixed by this RFC" is listed, the disposition cell describes which R-LR* requirement removed or rewrote the annotation. For category (d) entries, the disposition cell includes the TODO link placeholder; the implementer can fill in the actual issue/RFC link when known, or leave a generic "TODO: follow-up RFC" pointer.

**Reconciliation note for RFC vs. Phase 5 investigator finding.** RFC §2.4 says "exactly one known-deferred site: `relay-metrics.ts:48`". Phase 5 investigator found 3 additional candidate known-deferred sites (overlay-scanner.ts:128/148/168) plus 1 to verify (task-resolution.ts:428). **Surface to user via Task 4** before finalizing the table — the RFC may need to expand the known-deferred list or Phase 5 may need to convert the overlay-scanner sites to outbox helpers within this RFC's scope.

**Verification:**

```bash
# CONTRIBUTING.md is markdown; no automated check beyond visual review.
# Validator unit test (Task 2) covers the runtime behavior.
bun run scripts/validate-outbox-invariant.ts   # must pass with the new audit-table cross-check
```

**Commit:**
```bash
git add CONTRIBUTING.md
git commit -m "docs: add narrow-exception list and outbox-exempt audit disposition table (R-LR6, R-LR12)"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Surface known-deferred discrepancies and resolve scope

**Verifies:** R-LR12 audit completeness.

**Files:** None (this is a coordination task).

**Implementation:**

Phase 5 investigator surfaced four discrepancies between RFC §2.4 ("exactly one known-deferred site") and the actual annotation count:

1. **`packages/sandbox/src/overlay-scanner.ts:128, 148, 168`** — three annotations on `overlay_index` writes (a synced table) with the comment "outbox not provided (backward compat)". Investigator flagged as INCORRECT: should route through outbox helpers.
2. **`packages/agent/src/task-resolution.ts:428`** — annotation on `tasks.no_history` write with comment "legacy migration". Status unclear; needs investigation during Phase 5 implementation.

**Default path (B): add to known-deferred with TODO links.** Per RFC §2.4 the RFC's scope is task-lifecycle resilience; non-task fixes file separately. Path B keeps Phase 5 within scope, expands the known-deferred list from one site to a small finite list (relay-metrics + overlay-scanner + task-resolution if active), and produces correct CI-gate-compliant state. Path A (convert overlay-scanner inline) and Path C (delete task-resolution dead code) are out-of-scope expansions that the RFC explicitly defers.

**Implementation steps for default path B:**

1. For `overlay-scanner.ts:128, 148, 168`: add a `// TODO: follow-up RFC — overlay_index writes should route through insertRow/updateRow/softDelete (filed as <issue link>)` comment adjacent to each existing annotation. The annotation text stays as-is.
2. For `task-resolution.ts:428`: read the surrounding code to determine if the migration is active (still runs on startup) or dead code (a one-time migration whose SQL never executes anymore). If active, add the same TODO-link comment treatment as overlay-scanner. If dead, delete the SQL block and the annotation; record category (e) "comment-only / removed" in the audit table.
3. Update Task 3's audit table to reflect the chosen disposition for each of the four sites.
4. Verify the validator's category-(d) rule (Task 2) recognizes the TODO link adjacent to each annotation.

**Confirmation gate (use AskUserQuestion at impl time):**

```
Phase 5 found four annotations the RFC didn't name as known-deferred:
- 3 in overlay-scanner.ts (overlay_index writes; "outbox not provided (backward compat)")
- 1 in task-resolution.ts:428 (tasks.no_history; "legacy migration", verify if active)

Default path: B (record as known-deferred with TODO links to follow-up RFC).
Override options:
A. Convert overlay-scanner sites to outbox helpers within this RFC's scope.
C. Investigate task-resolution.ts:428 first; if dead code, delete it.

Default to B unless you want to override?
```

The default-with-override pattern removes scope uncertainty: barring user override, the executor proceeds with Path B's surgical comment additions and audit-table updates, no new code paths.

**Verification:**

```bash
bun run typecheck
bun run scripts/validate-outbox-invariant.ts   # must pass with whatever resolution
```

**Commit (depends on chosen path):**
```bash
# Path A:
git commit -m "fix(sandbox): route overlay_index writes through outbox helpers"
# Path B/C:
git commit -m "docs: record known-deferred outbox-exempt sites with TODO links (R-LR12)"
```
<!-- END_TASK_4 -->

---

## Phase 5 Done When

- All scheduler.ts raw-CAS annotations rewritten from `outbox-exempt` to `outbox-routed` per Task 1's mapping. Same treatment for bootstrap.ts, leader-election.ts, drain.ts, set-hub.ts, config-reload.ts, stop-resume.ts.
- `scripts/validate-outbox-invariant.ts` recognizes `outbox-routed` annotations as valid and cross-checks `outbox-exempt` annotations against CONTRIBUTING.md's audit disposition table. Unit tests cover the validator's new behavior.
- CONTRIBUTING.md has a "Documented Narrow Exceptions to Invariant #1" section (with the single `semantic_memory.last_accessed_at` entry) and an exhaustive "Audit Disposition Table for `outbox-exempt` Annotations". Every annotation in the repo has a row.
- The known-deferred discrepancies (overlay-scanner.ts and task-resolution.ts) are resolved per the user's chosen path in Task 4.
- `bun run typecheck` clean. `bun run lint` clean. `bun test --recursive` no new failures. `bun run scripts/validate-outbox-invariant.ts` passes against the post-RFC repo state.
- Manual review confirms: every `outbox-exempt` annotation that survived Phase 5 has a category in CONTRIBUTING.md, with `(a)` justified, `(c)` non-synced, or `(d)` known-deferred + TODO link. No `(b)` "fixed by this RFC" rows have surviving annotations on the synced-table side.
