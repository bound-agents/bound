# Volatile Context Tiered Fidelity — Phase 7: §8.4 Validation Check + §8.6 Behavioral Probe

**Goal:** Implement the §8.4 daily R-VC9/R-VC9b title-and-gloss compliance validation that runs in the heartbeat task and writes `_validation:*` outcome entries, plus the §8.6 behavioral probe scaffold that runs an N=10 agent-loop integration test against a webhook fixture for both the post-RFC and pre-RFC orientation blocks. The probe is integration-tier and gated behind an env var so per-PR CI does not consume inference budget.

**Architecture:** Two independent subsystems. §8.4 is a pure-DB validation pass that hooks into the existing scheduler/heartbeat task path. §8.6 is a probe harness under `packages/agent/src/__tests__/probes/` (a new `.integration.test.ts` file) that exercises a real agent loop with deterministic temperature against a fixture conversation. Both are documented for operator follow-up: §8.4's outcome entries are surfaced via the existing `_validation:` synthesis advisory channel; §8.6 is wired into a separate CI workflow that the operator schedules weekly.

**Tech Stack:** TypeScript, `bun:sqlite`, the existing scheduler / heartbeat infrastructure (verified to live in `packages/agent/src/scheduler.ts`), the existing `LLMBackend` driver path (Bedrock / Anthropic / Ollama / OpenAI-compatible).

**Scope:** 7 of 7 phases.

**Codebase verified:** 2026-05-22 against commit `36dc9f2e`. Heartbeat / scheduler at `packages/agent/src/scheduler.ts`. No existing weekly/release-gated CI workflow — Task 5 documents the operator action to add one. Mock LLM declared inline per test file (verified); §8.6 uses a real driver, not the mock.

---

## Acceptance Criteria Coverage

This phase implements:

### volatile-context.R-VC9 / R-VC9b validation (§8.4)

- **R-VC9 (literal):** "Memory keys created by the synthesis layer shall function as standalone search seeds. A key's topic slug — the string after the colon-prefixed namespace (e.g., the `<topic>` in `_summary:<topic>`) — shall contain at least three tokens that also appear in the entry's value body AND have corpus-wide occurrence count ≥ 5 (i.e., the token appears in the value body of at least five distinct non-deleted entries). The ≥5 threshold filters idiosyncratic tokens (single-incident proper names, typos, version stamps) without depending on a corpus-shape statistic that degenerates on Zipfian distributions. This is checkable by the §8.4 validation procedure. Abbreviations, codenames, or date stamps without a topical anchor in the value body do not count as valid topic tokens."
- **R-VC9b (literal):** "Synthesis-layer-produced `_summary:<topic>` entries shall include enumerable sub-topic vocabulary in their value body. The 200-character gloss rendered in Working Knowledge (R-VC3) shall contain identifying terms for each child entry's subject. This requirement is load-bearing under R-VC15 Tier 3, where long-tail child entries are not directly rendered and their discoverability depends on sub-topic vocabulary in the parent gloss to seed search queries. The synthesis layer regenerates non-compliant `_summary:<topic>` value bodies on next regeneration cycle; existing non-compliant entries are not retroactively rewritten by this RFC."
- **§8.4 procedure (literal):** the five-step procedure from spec §8.4 is implemented verbatim in Task 1.

### volatile-context.AC-Deploy-§8.5 (validation gate)

- **§8.5 (literal):** "§8.4 validation check runs cleanly (no test failures; surfaced non-compliance is informational)."

### volatile-context.AC-Deploy-§8.6 (behavioral probe gate)

- **§8.5 (literal):** "§8.6 behavioral probe passes: post-RFC orientation block produces envelope-content-referencing assistant turns at ≥80% of N=10 trials, while pre-RFC orientation block produces disclaimer turns at ≥80% of N=10 trials (control)."
- **§8.6 procedure (literal):** the six-step procedure plus acceptance thresholds from spec §8.6 are implemented in Tasks 4–5.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Implement R-VC9 / R-VC9b validation logic

**Type:** Functionality.

**Verifies:** volatile-context.R-VC9, R-VC9b (validation logic — wiring lands in Task 3).

**Files:**
- Create: `packages/agent/src/validation/r-vc9-compliance.ts` — pure validation functions.

**Implementation:**

```typescript
import type { Database } from "bun:sqlite";

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}(:\d{2}(:\d{2}(\.\d+)?)?Z?)?)?$/;
const MIN_TOKEN_LENGTH = 3;
const MIN_TOKEN_FREQ = 5;
const R_VC9_PASS_THRESHOLD = 3;
const R_VC9B_CHILD_COVERAGE_THRESHOLD = 0.8;
const SAMPLE_SIZE = 50;
const SAMPLE_WINDOW_DAYS = 7;

/**
 * §8.4 step 3a — extract topic-slug tokens from a memory key.
 * Procedure: split on the first colon, take the right-hand side, split on `-`, `_`, `:`,
 * and digit boundaries; lower-case; drop tokens shorter than 3 characters; drop ISO-8601
 * date stamps.
 */
export function extractSlugTokens(key: string): string[] {
    const colonIdx = key.indexOf(":");
    if (colonIdx < 0) return [];
    const slug = key.slice(colonIdx + 1);
    if (!slug) return [];
    // Split on delimiters and digit boundaries.
    const raw = slug.split(/[-_:]+|(?<=\D)(?=\d)|(?<=\d)(?=\D)/);
    const out: string[] = [];
    for (const tok of raw) {
        const lower = tok.toLowerCase();
        if (lower.length < MIN_TOKEN_LENGTH) continue;
        if (ISO_8601_RE.test(lower)) continue;
        out.push(lower);
    }
    return out;
}

/**
 * §8.4 step 1 — corpus-wide token frequency table.
 * For each token (alphanumeric runs of length ≥3 with ISO-8601 date stamps stripped) in
 * `semantic_memory.value` across all rows where `deleted IS NOT 1`, count the number of
 * distinct entries containing the token.
 */
export function buildTokenFrequencyTable(db: Database): Map<string, number> {
    const rows = db
        .prepare("SELECT value FROM semantic_memory WHERE deleted IS NOT 1")
        .all() as Array<{ value: string }>;
    const freq = new Map<string, number>();
    for (const row of rows) {
        const seenInThisEntry = new Set<string>();
        const tokens = (row.value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
            (t) => !ISO_8601_RE.test(t),
        );
        for (const tok of tokens) {
            if (seenInThisEntry.has(tok)) continue;
            seenInThisEntry.add(tok);
            freq.set(tok, (freq.get(tok) ?? 0) + 1);
        }
    }
    return freq;
}

export interface Vc9CheckResult {
    key: string;
    slugTokens: string[];
    /** Tokens appearing in the entry value (case-insensitive substring). */
    inBody: string[];
    /** Tokens with freq ≥ 5 in the corpus. */
    aboveFreq: string[];
    /** Tokens that satisfy BOTH conditions — drives the pass condition. */
    bothConditions: string[];
    pass: boolean;
}

export function checkR_VC9(
    key: string,
    value: string,
    freq: Map<string, number>,
): Vc9CheckResult {
    const slugTokens = extractSlugTokens(key);
    const lowerValue = value.toLowerCase();
    const inBody = slugTokens.filter((t) => lowerValue.includes(t));
    const aboveFreq = slugTokens.filter((t) => (freq.get(t) ?? 0) >= MIN_TOKEN_FREQ);
    const bothConditions = slugTokens.filter(
        (t) => lowerValue.includes(t) && (freq.get(t) ?? 0) >= MIN_TOKEN_FREQ,
    );
    return {
        key,
        slugTokens,
        inBody,
        aboveFreq,
        bothConditions,
        pass: bothConditions.length >= R_VC9_PASS_THRESHOLD,
    };
}

export interface Vc9bCheckResult {
    parentKey: string;
    childCount: number;
    childrenWithSubjectInGloss: number;
    pass: boolean;
    failingChildKeys: string[];
}

export function checkR_VC9b(
    db: Database,
    parentKey: string,
    parentValue: string,
): Vc9bCheckResult {
    const lowerGloss = parentValue.toLowerCase();
    const children = db
        .prepare(
            `SELECT m.key AS key, m.value AS value
             FROM memory_edges e
             JOIN semantic_memory m ON m.key = e.target_key AND m.deleted IS NOT 1
             WHERE e.relation = 'summarizes' AND e.deleted IS NOT 1 AND e.source_key = ?`,
        )
        .all(parentKey) as Array<{ key: string; value: string }>;
    const failing: string[] = [];
    let satisfied = 0;
    let evaluable = 0;
    for (const c of children) {
        const tokens = extractSlugTokens(c.key);
        if (tokens.length === 0) continue; // children with empty slug tokens are not evaluable
        evaluable++;
        const anyInGloss = tokens.some((t) => lowerGloss.includes(t));
        if (anyInGloss) satisfied++;
        else failing.push(c.key);
    }
    const pass =
        evaluable === 0 || satisfied / evaluable >= R_VC9B_CHILD_COVERAGE_THRESHOLD;
    return {
        parentKey,
        childCount: evaluable,
        childrenWithSubjectInGloss: satisfied,
        pass,
        failingChildKeys: failing,
    };
}
```

Notes:

- §8.4 step 1's "alphanumeric runs of length ≥3 with ISO-8601 date stamps stripped" maps to the regex `[a-z0-9]{3,}` plus the ISO-8601 filter.
- §8.4 step 3a's split rules (`-`, `_`, `:`, and digit boundaries) are encoded in a single split regex with two zero-width digit-boundary lookaheads.
- The R-VC9b "≥80% of children with non-empty extracted subject tokens" is computed against children whose slug yields non-empty tokens (`evaluable++`). Children with empty tokens are excluded from both numerator and denominator, matching the spec's "children with non-empty extracted subject tokens" qualifier.
- Constants are exported names (not magic numbers) so the heartbeat wiring (Task 3) can sample with the same threshold values.

**Step 1: Add the file with the constants and three exported functions.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/validation/r-vc9-compliance.ts
git commit -m "feat(agent): add R-VC9/R-VC9b compliance validation logic (§8.4)"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test the validation logic

**Type:** Functionality.

**Verifies:** Validation correctness for R-VC9 / R-VC9b.

**Files:**
- Create: `packages/agent/src/validation/__tests__/r-vc9-compliance.test.ts`

**Implementation:**

`extractSlugTokens`:

1. `_summary:transit-systems-and-routing` → `["transit", "systems", "and", "routing"]`. (Note: `and` is a 3-char common word; the spec doesn't filter stopwords. The freq filter catches noise downstream.)
2. `_summary:` (empty slug) → `[]`.
3. `nokey` (no colon) → `[]`.
4. `_summary:agent-eval-research-2026-04-16` → ISO date `2026-04-16` is split into `2026`, `04`, `16` after digit-boundary splits — the ISO-8601 regex matches `2026-04-16` only as a whole token, not the parts. Confirm via test: tokens include `2026`, `04`, `16` (each independently); the spec's "drop ISO-8601 date stamps" applies to whole-token matches. (If the test surfaces an interpretation mismatch with the spec, document and surface to the user.)
5. `_summary:tokyo-metro-graphviz` → `["tokyo", "metro", "graphviz"]`.
6. `_summary:foo123bar` → digit-boundary split yields `["foo", "123", "bar"]`; `123` is dropped (length ≥3 but numeric — actually 3 chars, kept under current rule). Confirm test expectation matches the implementation; if the spec's "drop tokens shorter than 3 characters" is the only length filter, `123` is kept. The freq filter is the corpus-shape gate that catches numeric noise.

`buildTokenFrequencyTable`:

1. Empty corpus → empty map.
2. One entry with body `"hello world"` → `{ hello: 1, world: 1 }`.
3. Two entries both containing `"hello"` → `{ hello: 2 }`.
4. One entry with `"hello hello"` (duplicate within entry) → `{ hello: 1 }` (per-entry de-dup).
5. Soft-deleted entry's tokens are not counted.

`checkR_VC9`:

1. Compliant: slug `"transit-systems-routing"`, value mentions `"transit systems routing"` four times; corpus has `transit`, `systems`, `routing` each in 5+ entries → `pass: true`, `bothConditions.length >= 3`.
2. Non-compliant — slug tokens absent from value body: slug `"foo-bar-baz"`, value mentions none; → `pass: false`.
3. Non-compliant — corpus freq below 5: tokens appear in value but corpus freq is 4 → `pass: false`.
4. ISO-8601 in slug is stripped: slug `"agent-eval-2026-04-16"`, the date doesn't count toward the three-token threshold.

`checkR_VC9b`:

1. No children → `pass: true` (degenerate; spec's "children with non-empty extracted subject tokens" yields zero, so the percentage condition is vacuously satisfied).
2. All children's slug tokens appear in the parent gloss → `pass: true`.
3. 80% match → `pass: true` (just at threshold).
4. 75% match → `pass: false`.
5. Child with empty slug tokens is not evaluable (excluded from numerator and denominator).
6. `failingChildKeys` lists exactly the children whose slug tokens were absent from the gloss.

Use a temp DB for `buildTokenFrequencyTable` and `checkR_VC9b`. `extractSlugTokens` and `checkR_VC9` are pure and need no DB.

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/validation/__tests__/r-vc9-compliance.test.ts`

Expected: all tests pass. (Tally: ~6 + 5 + 4 + 6 = 21 tests across the four function families.)

**Step 3: Commit**

```bash
git add packages/agent/src/validation/__tests__/r-vc9-compliance.test.ts
git commit -m "test(agent): cover R-VC9/R-VC9b validation logic"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Wire validation into the heartbeat task

**Type:** Functionality.

**Verifies:** §8.4 procedure end-to-end; §8.5 "§8.4 validation check runs cleanly".

**Files:**
- Modify: `packages/agent/src/scheduler.ts` (or the file the implementor identifies as the heartbeat task body) — add a daily-frequency call into the validation pass.
- Create: `packages/agent/src/validation/run-r-vc9-validation.ts` — orchestrates the §8.4 procedure and emits outcome entries.

**Implementation:**

The orchestrator is a single function called from the heartbeat. It samples 50 keys with `tier IN ('summary', 'detail') AND modified_at within 7 days`, runs `checkR_VC9` per sample, runs `checkR_VC9b` per `tier='summary'` sample, and emits `_validation:r-vc9-non-compliance` and `_validation:r-vc9b-non-compliance` outcome entries via the existing memory-write path (`memorize` / `insertRow` per outbox invariant #1).

```typescript
import type { Database } from "bun:sqlite";
import { buildTokenFrequencyTable, checkR_VC9, checkR_VC9b } from "./r-vc9-compliance";
import { insertRow } from "@bound/core";

const SAMPLE_SIZE = 50;
const SAMPLE_WINDOW_DAYS = 7;

export interface Vc9ValidationReport {
    sampledKeys: number;
    rVc9NonCompliantCount: number;
    rVc9bNonCompliantCount: number;
}

export function runR_VC9Validation(
    db: Database,
    siteId: string,
    nowMs: number,
): Vc9ValidationReport {
    const cutoff = new Date(nowMs - SAMPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const samples = db
        .prepare(
            `SELECT key, value, tier
             FROM semantic_memory
             WHERE deleted IS NOT 1
               AND tier IN ('summary', 'detail')
               AND modified_at >= ?
             ORDER BY RANDOM()
             LIMIT ?`,
        )
        .all(cutoff, SAMPLE_SIZE) as Array<{ key: string; value: string; tier: string }>;

    if (samples.length === 0) {
        return { sampledKeys: 0, rVc9NonCompliantCount: 0, rVc9bNonCompliantCount: 0 };
    }

    const freq = buildTokenFrequencyTable(db);
    let rVc9NonCompliant = 0;
    let rVc9bNonCompliant = 0;

    for (const s of samples) {
        const r9 = checkR_VC9(s.key, s.value, freq);
        if (!r9.pass) {
            rVc9NonCompliant++;
            // Emit _validation:r-vc9-non-compliance:<key> outcome entry.
            const outcomeKey = `_validation:r-vc9-non-compliance:${s.key}`;
            const outcomeBody = JSON.stringify({
                key: s.key,
                slugTokens: r9.slugTokens,
                inBody: r9.inBody,
                aboveFreq: r9.aboveFreq,
                bothConditions: r9.bothConditions,
                checkedAt: new Date(nowMs).toISOString(),
            });
            // Use insertRow + deterministicUUID. memorize() is for agent-authored memories;
            // these outcome entries are synthesized by the validation pass and are written
            // directly. Synced-table outbox invariant #1 (CONTRIBUTING.md) requires insertRow,
            // not raw SQL. Deterministic UUID lets a re-run of the same key idempotently
            // overwrite (via updateRow path) instead of inserting a duplicate.
            const outcomeId = deterministicUUID(BOUND_NAMESPACE, outcomeKey);
            insertRow(db, "semantic_memory", {
                id: outcomeId,
                key: outcomeKey,
                value: outcomeBody,
                tier: "default",
                source: "validation:r-vc9",
                modified_at: new Date(nowMs).toISOString(),
                last_accessed_at: new Date(nowMs).toISOString(),
                // ... full column set per schema.ts
            }, siteId);
        }
        if (s.tier === "summary" && s.key.startsWith("_summary:")) {
            const r9b = checkR_VC9b(db, s.key, s.value);
            if (!r9b.pass) {
                rVc9bNonCompliant++;
                // Emit _validation:r-vc9b-non-compliance:<key>
                // ... write outcome entry
            }
        }
    }
    return {
        sampledKeys: samples.length,
        rVc9NonCompliantCount: rVc9NonCompliant,
        rVc9bNonCompliantCount: rVc9bNonCompliant,
    };
}
```

Heartbeat wiring:

The implementor identifies the heartbeat task in `packages/agent/src/scheduler.ts` (or the file owning `_standing:outcomes_log` per the spec's §6.5 cross-reference). The validation pass runs once per day. A common pattern is to gate on a `last_run_at` field stored in the memory layer (e.g., `_validation:r-vc9-last-run`); the implementor reuses any existing daily-cadence helper or adds a minimal one.

The validation pass MUST NOT throw on non-compliance. The spec is explicit (§8.4 closing paragraph): "This validation surfaces non-compliant titles and cluster glosses for synthesis-layer rewrite without breaking access to existing entries. The validation is advisory; non-compliant keys remain queryable …".

**Step 1: Write the orchestrator function.**

**Step 2: Identify the heartbeat call site and wire `runR_VC9Validation` into a daily-cadence path.**

**Step 3: Add an integration test under `packages/agent/src/validation/__tests__/run-r-vc9-validation.integration.test.ts`** that:
   - Constructs a corpus with mixed compliant + non-compliant entries.
   - Runs `runR_VC9Validation`.
   - Asserts the returned report counts match.
   - Asserts the corresponding `_validation:r-vc9-non-compliance:*` and `_validation:r-vc9b-non-compliance:*` outcome entries are present in `semantic_memory`.

**Step 4: Verify with tests + typecheck**

Run: `bun test packages/agent/src/validation`
Run: `bun run typecheck`

Expected: pass.

**Step 5: Commit**

```bash
git add packages/agent/src/validation/run-r-vc9-validation.ts \
        packages/agent/src/validation/__tests__/run-r-vc9-validation.integration.test.ts \
        packages/agent/src/scheduler.ts
git commit -m "feat(agent): wire R-VC9/R-VC9b validation into heartbeat task"
```
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: §8.6 behavioral probe scaffold

**Type:** Functionality.

**Verifies:** §8.6 procedure (mechanism only — the acceptance gates trip on operator-run probes, not on per-PR CI).

**Files:**
- Create: `packages/agent/src/__tests__/probes/d0372be6-behavioral-probe.integration.test.ts`
- Create: `packages/agent/src/__tests__/probes/legacy-orientation-block.ts` — a hand-written reproduction of the pre-RFC orientation-block shape, used as the control-arm orientation. The implementor reads `git show 36dc9f2e:packages/agent/src/context-assembly.ts` (or any pre-Phase-5 commit on this branch) to source the exact pre-RFC text shape.

**Implementation:**

The probe runs only when `BOUND_RUN_BEHAVIORAL_PROBE=1` is set in the environment. Default per-PR runs skip the file via a `describe.skip` gate or an `it("…", () => { if (!enabled) return; … })` early-return, the implementor picks a clean form.

The probe procedure (literal from §8.6):

```typescript
const PROBE_ENABLED = process.env.BOUND_RUN_BEHAVIORAL_PROBE === "1";

const ENVELOPE_JSON = {
    method: "POST",
    path: "/webhook/example-repo",
    headers: {
        "x-github-event": "issues",
        "x-github-delivery": "00000000-0000-4000-8000-000000000001",
    },
    body: {
        action: "opened",
        repository: { full_name: "example-org/example-repo" },
        sender: { login: "alice" },
        issue: { number: 42, title: "test issue" },
    },
};

const CONTENT_PREDICATES = [
    "opened",
    "example-org/example-repo",
    "alice",
];

const DISCLAIMER_PHRASES = [
    "no payload",
    "no envelope",
    "payload appears to be missing",
    "can't see the payload",
    "event details not visible",
    "summary stub",
    "recent activity digest",
];

const N_TRIALS = 10;
const TEMPERATURE = 0.3;
const CONTENT_PCT_THRESHOLD = 0.8;
const DISCLAIMER_PCT_THRESHOLD = 0.2;

interface ProbeResult { contentPct: number; disclaimerPct: number; trials: number; }

async function runProbe(orientationVariant: "post-rfc" | "pre-rfc"): Promise<ProbeResult> {
    let contentCount = 0;
    let disclaimerCount = 0;
    for (let i = 0; i < N_TRIALS; i++) {
        const fixture = buildWebhookFixture(); // see helper below
        const orientation = orientationVariant === "post-rfc"
            ? buildPostRfcOrientation(fixture)
            : buildPreRfcOrientation(fixture); // legacy-orientation-block.ts
        const assistantText = await runAgentLoopOneTurn({
            orientation,
            conversationHistory: fixture.conversationHistory,
            temperature: TEMPERATURE,
        });
        if (containsAll(assistantText, CONTENT_PREDICATES)) contentCount++;
        if (containsAny(assistantText, DISCLAIMER_PHRASES)) disclaimerCount++;
    }
    return {
        contentPct: contentCount / N_TRIALS,
        disclaimerPct: disclaimerCount / N_TRIALS,
        trials: N_TRIALS,
    };
}

describe.skipIf(!PROBE_ENABLED)("d0372be6 behavioral probe (§8.6)", () => {
    it("post-RFC content_pct >= 0.8 and disclaimer_pct <= 0.2", async () => {
        const post = await runProbe("post-rfc");
        expect(post.contentPct).toBeGreaterThanOrEqual(CONTENT_PCT_THRESHOLD);
        expect(post.disclaimerPct).toBeLessThanOrEqual(DISCLAIMER_PCT_THRESHOLD);
    });
    it("pre-RFC disclaimer_pct >= 0.8 (control)", async () => {
        const pre = await runProbe("pre-rfc");
        expect(pre.disclaimerPct).toBeGreaterThanOrEqual(CONTENT_PCT_THRESHOLD);
    });
});
```

Notes:

- The `legacy-orientation-block.ts` reproduces the pre-RFC orientation shape. Source it from the pre-Phase-5 commit on this branch: capture the rendered output of `buildVolatileContext` against an equivalent fixture on the parent branch (`main` at `36dc9f2e`) and freeze the exact string. The implementor does this by checking out `main` in a separate working tree, building the orientation block once, and pasting the result into `legacy-orientation-block.ts` as a parameterized template (substituting only the dynamic envelope fields).
- `runAgentLoopOneTurn` is a thin wrapper around the existing agent-loop machinery. It must use the lowest-cost available driver per §8.6 step 3 ("typically a fast Anthropic, Bedrock, or open-weights model"). The implementor reads from `model_backends.json` to pick the configured cheapest backend; if none is configured, the test skips with a logged reason.
- The 0.6–0.8 borderline range trigger from §8.6 ("For borderline outcomes (post-RFC `content_pct` in [0.6, 0.8]), the probe re-runs at N=20 before declaring partial success") is implemented as a follow-up retry loop in the `it` body — first run at N=10; if `contentPct ∈ [0.6, 0.8]`, re-run at N=20; report the second run's metrics.
- The probe consumes inference budget. The default `describe.skipIf(!PROBE_ENABLED)` keeps it out of per-PR CI.

**Step 1: Write the probe scaffold and the legacy-orientation reproducer.**

**Step 2: Run the probe locally with `BOUND_RUN_BEHAVIORAL_PROBE=1`** to verify the mechanics work end-to-end. The acceptance assertions may pass or fail depending on the model used; this is OK as long as the mechanics complete a full N=10 run without throwing.

**Step 3: Disable in default test runs**

Run (default): `bun test packages/agent/src/__tests__/probes/`

Expected: tests skipped (no inference cost).

Run (probe enabled): `BOUND_RUN_BEHAVIORAL_PROBE=1 bun test packages/agent/src/__tests__/probes/`

Expected: probe runs to completion. Pass/fail of the acceptance gate depends on the model under test.

**Step 4: Commit**

```bash
git add packages/agent/src/__tests__/probes/
git commit -m "test(agent): scaffold §8.6 d0372be6 behavioral probe (gated by BOUND_RUN_BEHAVIORAL_PROBE)"
```
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Document operator action — weekly probe CI cadence

**Type:** Infrastructure (documentation).

**Verifies:** None directly. Closes the §8.6 "lives in the integration-test pipeline, not the per-PR unit-test suite" obligation.

**Files:**
- Modify: `CONTRIBUTING.md` — add a brief section on the behavioral probe and its env gate.
- Modify: `docs/test-plans/` — add `2026-05-22-volatile-context-probe.md` with the full §8.6 procedure and acceptance criteria, and a note that the operator should add a weekly GitHub Actions workflow that runs `BOUND_RUN_BEHAVIORAL_PROBE=1 bun test packages/agent/src/__tests__/probes/`.

**Implementation:**

The codebase has no existing weekly/release CI cadence (verified). Adding one to `.github/workflows/` is a project-wide infra change that warrants operator review before merging. This task documents the operator action rather than adding the workflow itself.

`docs/test-plans/2026-05-22-volatile-context-probe.md` contents:

- Header with date, status, and reference to the spec at `docs/design/specs/2026-05-22-volatile-context.md`.
- The full §8.6 procedure copied verbatim from the spec (six steps + acceptance + rationale).
- The env-var gate name (`BOUND_RUN_BEHAVIORAL_PROBE=1`) and how to invoke locally.
- The recommended cadence: weekly or per-release.
- The recommended workflow file shape:

  ```yaml
  # .github/workflows/behavioral-probe.yml (operator action)
  name: Behavioral probe
  on:
    schedule:
      - cron: "0 14 * * 1" # 14:00 UTC every Monday
    workflow_dispatch: {}
  jobs:
    probe:
      runs-on: ubuntu-latest
      env:
        BOUND_RUN_BEHAVIORAL_PROBE: "1"
        # Plus whichever LLM backend credentials the probe runs against.
      steps:
        - uses: actions/checkout@v5
        - uses: oven-sh/setup-bun@v2
        - run: bun install
        - run: bun test packages/agent/src/__tests__/probes/
  ```

`CONTRIBUTING.md` addition (one short subsection under "Testing Conventions"):

> **Behavioral probes**. Tests under `packages/agent/src/__tests__/probes/` exercise real LLM drivers and consume inference budget. They are gated behind `BOUND_RUN_BEHAVIORAL_PROBE=1` and run on a separate cadence (weekly via the `behavioral-probe` workflow) rather than per-PR. Per-PR CI skips them.

**Step 1: Write the test plan document.**

**Step 2: Update CONTRIBUTING.md.**

**Step 3: Commit**

```bash
git add docs/test-plans/2026-05-22-volatile-context-probe.md CONTRIBUTING.md
git commit -m "docs: document §8.6 behavioral probe cadence and operator action"
```
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

---

## Phase 7 Done When

- All five tasks committed.
- `bun test packages/agent/src/validation` passes (~21 unit tests + 1 integration test).
- `bun test packages/agent/src/__tests__/probes/` skips by default (no inference cost on per-PR CI).
- `BOUND_RUN_BEHAVIORAL_PROBE=1 bun test packages/agent/src/__tests__/probes/` runs to completion against the configured LLM backend (the acceptance gate may pass or fail depending on model — operator-run probe interprets the result).
- `bun run typecheck` passes.
- The heartbeat task runs `runR_VC9Validation` once per day; non-compliant outcome entries appear under `_validation:r-vc9-non-compliance:*` and `_validation:r-vc9b-non-compliance:*` keys.
- `docs/test-plans/2026-05-22-volatile-context-probe.md` documents the operator action for the weekly probe workflow.

---

## RFC Done When (overall — for §8.5 deployment-time gates)

- All Phase 1–7 done-when conditions satisfied.
- §8.5 acceptance gates evaluated:
  - All §3 R-VC requirements implemented and covered by §8.1 / §8.2 tests (Phases 2–6).
  - §8.3 regression test passes (Phase 6 Task 5).
  - §8.4 validation check runs cleanly (Phase 7 Tasks 1–3).
  - §8.6 behavioral probe runs and meets thresholds (Phase 7 Task 4 — operator-run).
  - Snapshot tests pass for all eleven §8.2 scenarios (Phase 6 Task 4).
  - 7-day post-rollout `consecutive_failures` window measured ≤ 1.2× baseline (operator-monitored, not gated by code).
