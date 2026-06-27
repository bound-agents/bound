# Behavioral Probe Test Plan: §8.6 Volatile Context Fidelity

**Date:** 2026-05-22  
**Status:** Active  
**Reference:** `docs/design/specs/2026-05-22-volatile-context.md` §8.6  
**Gating:** `BOUND_RUN_BEHAVIORAL_PROBE=1` environment variable  

---

## Objective

Verify that the post-RFC orientation block (volatile-context RFC Phase 5+) produces envelope-aware assistant responses at ≥80% of N=10 trials, while the pre-RFC orientation block (control) produces disclaimer responses at ≥80% of N=10 trials. This ensures the RFC's structural fixes for the d0372be6 confabulation pattern are effective.

---

## Scope

**What is tested:**
- Real LLM inference through Anthropic, Bedrock, Ollama, or OpenAI-compatible backends.
- Agent-loop one-turn execution with fixed temperature (0.3).
- Orientation block rendering from both post-RFC and pre-RFC shapes.
- Predicate matching for envelope-content detection and disclaimer-phrase detection.

**What is NOT tested:**
- Retrieval pipeline (R-HM6 stages L0/L1/L2/L3).
- Memory delta computation (R-MV1–R-MV13).
- Conversation history compaction.
- Tool definitions.
- Synthesis-layer title authoring.

---

## Procedure (§8.6 literal)

### Step 1: Build a webhook envelope fixture

```json
{
  "method": "POST",
  "path": "/webhook/example-repo",
  "headers": {
    "x-github-event": "issues",
    "x-github-delivery": "00000000-0000-4000-8000-000000000001"
  },
  "body": {
    "action": "opened",
    "repository": { "full_name": "example-org/example-repo" },
    "sender": { "login": "alice" },
    "issue": { "number": 42, "title": "test issue" }
  }
}
```

### Step 2: Create conversation history

Build a minimal conversation with:
- One developer message injecting the webhook envelope JSON.
- One tool_result message containing the full envelope object (method, path, headers, body).

### Step 3: Run probe trials for both orientations

For N=10 trials each:

#### Trial loop:
1. Build the fixture envelope.
2. Create post-RFC orientation block with three-section structure (Working Knowledge, Discoverable Archive, Live State).
3. Build pre-RFC orientation block with flat memory listing + recent activity digest + "do not mention" footer.
4. Call `runAgentLoopOneTurn` with:
   - orientation block as system prompt addition
   - conversation history
   - fixed temperature: 0.3
5. Collect assistant response text.
6. Check if response contains **all** of `CONTENT_PREDICATES`: `["opened", "example-org/example-repo", "alice"]`.
7. Check if response contains **any** of `DISCLAIMER_PHRASES`:
   - "no payload"
   - "no envelope"
   - "payload appears to be missing"
   - "can't see the payload"
   - "event details not visible"
   - "summary stub"
   - "recent activity digest"

### Step 4: Compute outcome metrics

```typescript
contentPct = contentCount / N_TRIALS;
disclaimerPct = disclaimerCount / N_TRIALS;
```

### Step 5: Evaluate acceptance thresholds

**Post-RFC acceptance:**
- `contentPct >= 0.8` (envelope content references present in ≥80% of trials)
- `disclaimerPct <= 0.2` (disclaimer language in ≤20% of trials)

**Pre-RFC acceptance (control):**
- `disclaimerPct >= 0.8` (disclaimer language in ≥80% of trials — control confirms that pre-RFC shape produces disclaimers)

### Step 6: Borderline retry protocol

If post-RFC `contentPct` falls in the range [0.6, 0.8] after N=10 trials:
- Re-run the post-RFC probe at N=20 trials.
- Report the second run's metrics as the final outcome.

This allows the probe to distinguish genuine behavioral differences from temperature-driven variance in the borderline range.

---

## Environment Variable Gate

The probe is disabled by default and only runs when explicitly enabled:

```bash
BOUND_RUN_BEHAVIORAL_PROBE=1 bun test packages/agent/src/__tests__/probes/
```

**Default behavior (no env var set):**
```bash
bun test packages/agent/src/__tests__/probes/
# Output: probes skipped, 0 inference cost, no timeout
```

**Enabled behavior:**
```bash
BOUND_RUN_BEHAVIORAL_PROBE=1 bun test packages/agent/src/__tests__/probes/
# Output: runs full N=10 (or N=20 for borderline) trials per orientation, consumes inference budget
```

---

## Recommended CI Integration

### Cadence

Run the behavioral probe weekly (recommended Monday 14:00 UTC) rather than per-PR. This reduces inference costs and focuses the probe on release-gating checks.

### GitHub Actions Workflow

Create a new workflow file `.github/workflows/behavioral-probe.yml` (operator action — not auto-created):

```yaml
name: Behavioral probe (§8.6 volatile-context)

on:
  schedule:
    - cron: "0 14 * * 1"  # Every Monday at 14:00 UTC
  workflow_dispatch: {}   # Allow manual trigger

jobs:
  probe:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      BOUND_RUN_BEHAVIORAL_PROBE: "1"
      # Configure the LLM backend used for the probe.
      # Recommendations:
      # - ANTHROPIC_API_KEY for fastest, lowest-cost trials
      # - AWS_REGION + AWS credentials for Bedrock fallback
      # - OLLAMA_API_BASE for local/self-hosted option
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

    steps:
      - uses: actions/checkout@v5

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Run behavioral probe
        run: bun test packages/agent/src/__tests__/probes/

      - name: Report results
        if: always()
        run: echo "Probe completed. Review logs above for pass/fail status."

      - name: Notify on failure
        if: failure()
        run: |
          echo "Behavioral probe failed. Check the run logs."
          exit 1
```

---

## Acceptance Criteria

**Per-PR CI (default):**
- Probes are skipped silently (gated by env var).
- `bun test packages/agent/src/__tests__/probes/` reports "0 fail", "N skip".
- Zero inference cost.

**Operator-run probe (weekly via workflow):**
- Post-RFC probe: `contentPct >= 0.8` AND `disclaimerPct <= 0.2`.
- Pre-RFC probe (control): `disclaimerPct >= 0.8`.
- If borderline (post-RFC contentPct in [0.6, 0.8]): re-run at N=20, report final metrics.
- If any probe fails acceptance: operator reviews model performance and may adjust temperature, trial count, or backend before re-running.

---

## Rationale

### Why gating?

The probe exercises real LLM inference, consuming budget and incurring latency. Per-PR CI would apply the cost to every PR, compounding across the team. Gating to weekly cadence amortizes cost across a controlled release checkpoint while catching regressions at merge time.

### Why temperature=0.3?

Low temperature (0.3 vs. default ~1.0) reduces variance and makes the probe deterministic enough to distinguish real behavioral differences. Higher temperature would require N >> 10 to achieve statistical significance.

### Why borderline retry?

Temperature variance means 60% success on N=10 doesn't prove failure; it may just reflect the random tail. Retrying borderline outcomes at N=20 (doubling sample size) surfaces whether the behavior is genuinely marginal or just noise.

### Why three-trial sections?

Post-RFC probe verifies the RFC's core claim (orientation structure fixes the d0372be6 confabulation by explicit source labeling). Pre-RFC probe is the control: it demonstrates that the *same model* *does* produce disclaimers under the old structure, validating that the improvement is causal, not environmental.

---

## Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|-----------|
| Probe times out | LLM backend latency or network | Increase timeout in workflow, check backend health |
| All trials fail predicates | Wrong predicate list or model too conservative | Update predicates in test file, lower temperature, re-run |
| Pre-RFC control doesn't hit threshold | Old orientation block not reflective of actual pre-RFC state | Re-capture orientation template from earlier commit |
| Borderline loop retries forever | contentPct keeps falling in [0.6, 0.8] | Increase N cap (currently 20), or accept as "marginal success" and manual review |

---

## Related Requirements

- **R-VC1–R-VC23:** Volatile Context RFC requirements, all addressed by §8.6 probe.
- **§8.4:** R-VC9/R-VC9b validation check (separate integration test, not part of this probe).
- **§8.5:** Probe acceptance gates: "§8.6 behavioral probe passes (per acceptance thresholds above)."

---

## Next Steps (Operator Action)

1. Copy the recommended workflow YAML to `.github/workflows/behavioral-probe.yml`.
2. Configure `ANTHROPIC_API_KEY` (or relevant backend credentials) as a GitHub Actions secret.
3. Run the workflow manually (`workflow_dispatch`) to verify probe completes on the target backend.
4. Set the weekly schedule (Monday 14:00 UTC) and integrate into release-gate checklist.
5. On first failure: review the probe output, model performance, and backend latency before re-running.
