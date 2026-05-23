# Volatile Context Tiered Fidelity — Human Test Plan

**Implementation plan:** `docs/implementation-plans/2026-05-22-volatile-context/`
**Base SHA:** `36dc9f2e`
**Implementation HEAD:** `e7d9344b`
**Coverage:** PASS (24 active acceptance criteria, all covered by automated tests)

---

## Prerequisites

- Node/Bun runtime per repo standards (`bun --version`)
- Working tree at HEAD `e7d9344b` with all phase commits
- `bun test packages/agent` passing (CI baseline: 1525 pass, 3 skip, 0 fail)
- For §8.6 probe (optional): `BOUND_MODEL_BACKENDS_JSON` populated with a real backend (Anthropic / Bedrock / Ollama); set `BOUND_RUN_BEHAVIORAL_PROBE=1`
- Live `bound` instance (built binary) connected to a non-production DB containing real-shape memory data, advisories, threads, and tasks for end-to-end inspection

---

## Phase 1: Static structure inspection (read the rendered context)

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Start a live `bound` instance pointed at a populated DB. Send a single user message in a fresh thread. Capture the developer message of the next assistant turn from `context_debug` (or query `turns` for the latest `context_debug` JSON). | Developer-role message contains exactly three top-level `##` headers in order: `## Working Knowledge — operational and durable`, `## Discoverable Archive — title-only; bodies via memory search`, `## Live State — pointers to canonical sources`. |
| 1.2 | In the same captured developer message, search for `Memory: \d+ entries`, `Recent Activity Digest:`, `Do not mention`. | All three patterns absent. |
| 1.3 | In the same captured developer message, scan the Working Knowledge section. Locate at least one summary entry. | Each summary line has shape `- <key>: <gloss truncated to 200 chars + "...">`. No raw value bodies > 203 chars on a single line. Pinned entries render full text with no truncation. |
| 1.4 | Locate the Discoverable Archive section. | Each rendered entry is `- <key> (last accessed <relative-time>)` or `- <key>` (under budget pressure). No value content. No `Summary:` excerpt anywhere. |
| 1.5 | Locate the Live State section. | Source labels `[thread]`, `[task]`, `[file]`, `[advisory]` appear in that order if respective subsystem has data. File entries use em-dash U+2014 separator: `[file] <path> — last modified by thread "<title>"`. |
| 1.6 | Verify section footer literals (last line of each section). | Working Knowledge footer: `Bodies of summary entries are accessed via memory search using terms from the entry key.` Discoverable Archive footer: `Bodies are accessed via memory search or query against semantic_memory.` Live State footer: `Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.` |

---

## Phase 2: Tier transitions under real data sizes

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | Identify or seed a DB with ≤200 detail-tier entries. Capture rendered Discoverable Archive. | Flat list, no `### ` cluster headings. |
| 2.2 | Grow detail entries past the default `BOUND_VC15_N=1000` boundary (or set `BOUND_VC15_N=200` and exceed it). Capture again. | Cluster headings `### <topic> (<count> entries)` appear with full lists per cluster (Tier 2). Within-cluster ordering is `last_accessed_at DESC`. |
| 2.3 | Grow further past `BOUND_VC15_N`. | Cluster headings change to `### <topic> (<count> entries, showing <M> most recent)` (Tier 3). Each cluster lists at most M entries. |
| 2.4 | In Tier 3 with >50 uncategorized detail entries, verify Live State. | Line `- [synthesis-backlog] <count> uncategorized detail entries` appears. |
| 2.5 | Toggle `BOUND_VC15_M=5` and restart bound. | Tier 3 clusters show only 5 entries; line reads "showing 5 most recent". |

---

## Phase 3: Delta and stale-child rendering

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Take a thread that has at least one previous turn. Update one pinned memory entry between turns. Trigger another turn. Inspect the next developer message. | Pinned entry renders unchanged, then a separate indented line `    [changed since last turn]` directly beneath it. No `Memory: ...` callout. |
| 3.2 | Update one summary entry between turns. Trigger another turn. | The summary line ends with ` [changed since last turn]` appended to the truncated gloss on the same line. |
| 3.3 | Modify a child detail entry whose parent summary was modified earlier (so child becomes "stale"). Trigger another turn. | Under the parent summary, an indented child line appears: `  - <child_key>: ... [stale child of <parent_key>] [changed since last turn]` with markers in that exact order. |
| 3.4 | Query `SELECT last_accessed_at FROM semantic_memory WHERE key='<child_key>'` immediately before and after the turn. | The value is identical (R-MV5: rendering does not update last_accessed_at). |

---

## Phase 4: Live State subsystem ground-truth checks

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Apply an advisory (status=`applied`, `resolved_at=NOW()`). Trigger a turn within 24h. | Live State shows `- [advisory] <title> — applied <relative_time>`. |
| 4.2 | Use a real backend to apply an advisory > 24h before a turn. | The advisory does NOT appear under Live State. |
| 4.3 | Modify a tracked file via a sibling thread. Trigger a turn in the original thread. | Live State `[file]` line names the originating sibling thread title; em-dash separator is U+2014. |
| 4.4 | Run a scheduled task. Trigger a turn within ~24h. | Live State `[task]` line shows `task_id (task_type): run_count=N, last_run_at=<ts>, status=<status>`. |
| 4.5 | Have at least 2 sibling threads with non-empty `summary` columns. Trigger a turn in a third thread. | Cross-thread digest entries appear as `- [thread] <title>: N messages (last updated <ts>)`. No `Summary:` line for any sibling. |

---

## Phase 5: Budget pressure end-to-end

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | Use a real model with a tight context window. Construct a thread with many history messages plus active subsystems. Force a turn. | Live State subsystems each cap at 3 most-recent entries. |
| 5.2 | Same scenario, inspect Discoverable Archive. | Entry `(last accessed ...)` parenthetical fragments are dropped, but every entry title is still present. Cluster `###` headings preserved. |
| 5.3 | Same scenario, inspect Working Knowledge. | All pinned full-text and summary glosses are intact (R-VC14 mandates full fidelity). Section is not truncated. |

---

## Phase 6: §8.4 daily validation outcome

| Step | Action | Expected |
|------|--------|----------|
| 6.1 | On a live instance with non-compliant memory entries (slug tokens absent from value), wait for the daily heartbeat or force-trigger validation. | Rows appear at `_validation:r-vc9-non-compliance:*` and/or `_validation:r-vc9b-non-compliance:*`. Each row's value parses as JSON with `slugTokens`, `inBody`, `bothConditions` (R-VC9) or `childCount`, `childrenWithSubjectInGloss`, `failingChildKeys` (R-VC9b). |
| 6.2 | Run validation again the same day. | Row at `_validation:r-vc9-last-run` is updated; no UNIQUE constraint errors in logs; existing non-compliance rows updated rather than re-inserted. |

---

## Phase 7: §8.6 behavioral probe (operator review, not per-PR CI)

| Step | Action | Expected |
|------|--------|----------|
| 7.1 | Set `BOUND_RUN_BEHAVIORAL_PROBE=1` and a real backend in `BOUND_MODEL_BACKENDS_JSON`. Run `bun test packages/agent/src/__tests__/probes/d0372be6-behavioral-probe.integration.test.ts`. | Two non-skipped tests run. Post-RFC trial: `content_pct >= 0.8` and `disclaimer_pct <= 0.2`. Pre-RFC control: `disclaimer_pct >= 0.8`. |
| 7.2 | If post-RFC `content_pct ∈ [0.6, 0.8]`: probe automatically re-runs at N=20. Operator records both outcomes in deploy log. | Per spec §8.6, borderline result triggers RFC revisit if N=20 still falls in [0.5, 0.8]. |
| 7.3 | Without the env var, run the same test file. | Probe describe block is skipped (only the gating-mechanism describe runs, 2 tests). No inference cost incurred. |

---

## End-to-End: d0372be6 confabulation no longer occurs

Purpose: Validates the original confabulation pattern is structurally impossible given the new orientation block.

Steps:
1. Provision a webhook event-handler thread with an envelope JSON in a `tool_result` content block.
2. Send a user message asking for a summary of the event.
3. Capture the assistant response.

Expected:
- Response identifies the event type, repository, and sender from the envelope (matches CONTENT_PREDICATES `opened`, `example-org/example-repo`, `alice` if using the probe fixture).
- Response does NOT contain disclaimer phrases like "no payload", "no envelope", "summary stub", "recent activity digest" (matches DISCLAIMER_PHRASES list).
- The developer message in `context_debug` contains the Live State footer exactly: `Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.`

---

## End-to-End: Three-section integrity across thread interface variants

Purpose: Validates the renderer is interface-agnostic.

Steps: Send a turn from each of: web UI, Discord connector, MCP `bound_chat`, scheduled task. For each, capture the developer message.

Expected: All four contexts contain the same three section headers in fixed order with their footers; subsystem entries differ in content but never in structure.

---

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| §8.5 gate: 7-day post-rollout `consecutive_failures` window ≤ 1.2× baseline | Requires production telemetry across a 7-day window. The metric is collected by the live scheduler against the running tasks table; cannot be reproduced in CI without 7 days of production task workload. | At rollout, snapshot `SELECT AVG(consecutive_failures) FROM tasks WHERE deleted = 0 AND created_at >= ? AND created_at < ?` for the 7-day pre-rollout window and pin to deploy log. 7 days post-rollout, run the same query for the 7-day post-rollout window. Assert `post_mean ≤ 1.2 × pre_mean`. If violated, file a regression issue and consider rollback. |
| §8.5 gate: §8.6 behavioral probe results interpretation | The probe test asserts the numeric thresholds, but the merge-or-revisit decision on borderline `content_pct ∈ [0.6, 0.8]` is operator judgment per §8.6. | Read `content_pct` and `disclaimer_pct` from the most recent `behavioral-probe.yml` workflow run logs (or local `BOUND_RUN_BEHAVIORAL_PROBE=1 bun test packages/agent/src/__tests__/probes/`). Confirm post-RFC `content_pct ≥ 0.8` and `disclaimer_pct ≤ 0.2`, pre-RFC control `disclaimer_pct ≥ 0.8`. For borderline post-RFC `content_pct ∈ [0.6, 0.8]`, re-run at N=20 per spec §8.6 and revisit the RFC if the second run still falls in [0.5, 0.8]. |
| Operator-action: GitHub Actions `behavioral-probe.yml` workflow | The §8.6 weekly-cadence probe workflow is intentionally not in the diff per the documented operator follow-up; the test exists but the scheduling is operator-owned. | Author and commit `.github/workflows/behavioral-probe.yml` per `docs/test-plans/2026-05-22-volatile-context-probe.md` recommendations. Trigger one manual run; verify it executes the gated probe describe block and reports content_pct/disclaimer_pct in the run log. |

---

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| R-VC1 | volatile-context-integration + 11 snapshots | 1.1 |
| R-VC2 | per-renderer header tests + integration | 1.1, 1.6 |
| R-VC3 | render-working-knowledge | 1.3, 3.1 |
| R-VC4 | load-detail-entries + render-discoverable-archive | 1.4, 2.1 |
| R-VC5 | render-live-state + live-state-four-subsystems snapshot | 1.5, 4.1–4.5 |
| R-VC6 | per-renderer footer tests | 1.6 |
| R-VC7 | build-cross-thread-digest | 4.5 |
| R-VC8 | volatile-context-integration + d0372be6 regression | 1.2 |
| R-VC9 | r-vc9-compliance + integration | 6.1 |
| R-VC9b | r-vc9-compliance + integration | 6.1 |
| R-VC10 | render-working-knowledge + build-summary-helpers | 3.3 |
| R-VC11 / R-VC11(a)/(b)/(c)/(d) | render-working-knowledge cases + load-detail-entries case 6 + snapshots | 3.1, 3.2, 3.3, 3.4 |
| R-VC12 | load-applied-advisories + render-live-state | 4.1, 4.2 |
| R-VC13 | render-live-state | 4.3 |
| R-VC14 | per-renderer + integration + budget-pressure snapshot | 5.1, 5.2, 5.3 |
| R-VC15 | render-discoverable-archive + resolve-vc15-tunables + 5 snapshots | 2.1–2.5 |
| R-VC19 | volatile-context-integration + d0372be6 regression | 1.2 |
| R-VC20 | render-discoverable-archive | 1.4 |
| R-VC21 | render-discoverable-archive + budget-pressure snapshot | 5.2 |
| R-VC22 | per-renderer typography tests | 1.1 |
| R-VC23 | build-cross-thread-digest + d0372be6 regression | 4.5 |
| §8.5 §8.3 regression | d0372be6-structural-regression | End-to-End: d0372be6 confabulation |
| §8.5 §8.4 validation | r-vc9-compliance + integration | 6.1, 6.2 |
| §8.5 §8.6 probe | d0372be6-behavioral-probe (gated) | 7.1, 7.2, 7.3 |
| §8.5 7-day consecutive_failures | n/a | Human Verification row 1 |
| §8.5 probe interpretation | partial (test asserts thresholds) | Human Verification row 2 |
| Operator: behavioral-probe.yml workflow | n/a | Human Verification row 3 |
