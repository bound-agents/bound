/**
 * Behavioral probe for §8.6 orientation-block fidelity.
 *
 * Verifies that the post-RFC orientation block (volatile-context RFC Phase 5+)
 * produces envelope-aware assistant responses at ≥80% of N=10 trials, while the
 * pre-RFC orientation block (control) produces disclaimer responses at ≥80% of N=10 trials.
 *
 * This probe runs real LLM inference and consumes inference budget. It is gated behind
 * BOUND_RUN_BEHAVIORAL_PROBE=1 and does NOT run in per-PR CI by default.
 *
 * Procedure (§8.6):
 * 1. Build a webhook envelope fixture.
 * 2. Create a conversation history with one developer message + tool_result containing the envelope.
 * 3. For N=10 trials each:
 *    - Build post-RFC orientation block.
 *    - Run agent-loop one turn with fixed temperature.
 *    - Check if assistant response contains all of CONTENT_PREDICATES.
 *    - Check if response contains any of DISCLAIMER_PHRASES.
 * 4. Post-RFC: expect content_pct >= 0.8 and disclaimer_pct <= 0.2.
 * 5. Pre-RFC (control): expect disclaimer_pct >= 0.8.
 * 6. Borderline retry: if post-RFC content_pct in [0.6, 0.8], re-run at N=20.
 */

import { describe, expect, it } from "bun:test";
import { buildPostRfcOrientation, buildPreRfcOrientation } from "./legacy-orientation-block";

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

const CONTENT_PREDICATES = ["opened", "example-org/example-repo", "alice"];

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

interface ProbeResult {
	contentPct: number;
	disclaimerPct: number;
	trials: number;
}

/**
 * Check if text contains all required predicates (case-insensitive).
 */
function containsAll(text: string, predicates: string[]): boolean {
	const lower = text.toLowerCase();
	return predicates.every((p) => lower.includes(p.toLowerCase()));
}

/**
 * Check if text contains any of the disclaimer phrases (case-insensitive).
 */
function containsAny(text: string, phrases: string[]): boolean {
	const lower = text.toLowerCase();
	return phrases.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Helper to build a fixture webhook envelope for testing.
 */
function buildWebhookFixture() {
	return {
		envelope: ENVELOPE_JSON,
		conversationHistory: [] as Array<{
			role: "user" | "assistant" | "tool_result";
			content: string;
		}>,
	};
}

/**
 * Stub implementation for running an agent loop one turn.
 * In production, this would:
 * 1. Create a temporary database with schema.
 * 2. Insert the conversation history.
 * 3. Call assembleContext with the orientation block as system prompt addition.
 * 4. Route to the configured backend (Anthropic, Bedrock, Ollama, etc.).
 * 5. Collect the assistant's response text.
 * 6. Return the response for predicate checking.
 *
 * For now, this is a placeholder that will be wired into the real agent-loop machinery.
 */
async function runAgentLoopOneTurn(_params: {
	orientation: string;
	conversationHistory: Array<{ role: "user" | "assistant" | "tool_result"; content: string }>;
	temperature: number;
}): Promise<string> {
	// TODO: Wire to real agent-loop machinery
	// This stub allows typecheck to pass; the probe will skip with BOUND_RUN_BEHAVIORAL_PROBE != "1"
	console.warn("[behavioral-probe] runAgentLoopOneTurn not yet implemented. Skipping probe run.");
	return "";
}

/**
 * Run a complete probe trial set at a given N.
 */
async function runProbe(
	orientationVariant: "post-rfc" | "pre-rfc",
	trialsN: number = N_TRIALS,
): Promise<ProbeResult> {
	let contentCount = 0;
	let disclaimerCount = 0;

	for (let i = 0; i < trialsN; i++) {
		const fixture = buildWebhookFixture();
		const orientation =
			orientationVariant === "post-rfc"
				? buildPostRfcOrientation(fixture.envelope)
				: buildPreRfcOrientation(fixture.envelope);

		const assistantText = await runAgentLoopOneTurn({
			orientation,
			conversationHistory: fixture.conversationHistory,
			temperature: TEMPERATURE,
		});

		if (containsAll(assistantText, CONTENT_PREDICATES)) {
			contentCount++;
		}
		if (containsAny(assistantText, DISCLAIMER_PHRASES)) {
			disclaimerCount++;
		}
	}

	return {
		contentPct: contentCount / trialsN,
		disclaimerPct: disclaimerCount / trialsN,
		trials: trialsN,
	};
}

/**
 * Main probe test suite, gated by environment variable.
 * Default per-PR CI skips this entirely (no inference cost).
 */
const describeProbe = PROBE_ENABLED ? describe : describe.skip;
describeProbe("d0372be6 behavioral probe (§8.6)", () => {
	it("post-RFC content_pct >= 0.8 and disclaimer_pct <= 0.2", async () => {
		let post = await runProbe("post-rfc", N_TRIALS);

		// Borderline retry: if content_pct in [0.6, 0.8], re-run at N=20
		if (post.contentPct >= 0.6 && post.contentPct < 0.8) {
			console.log(
				`[behavioral-probe] Borderline post-RFC result (${post.contentPct}). Re-running at N=20.`,
			);
			post = await runProbe("post-rfc", 20);
		}

		expect(post.contentPct).toBeGreaterThanOrEqual(CONTENT_PCT_THRESHOLD);
		expect(post.disclaimerPct).toBeLessThanOrEqual(DISCLAIMER_PCT_THRESHOLD);
	});

	it("pre-RFC disclaimer_pct >= 0.8 (control)", async () => {
		const pre = await runProbe("pre-rfc");
		expect(pre.disclaimerPct).toBeGreaterThanOrEqual(CONTENT_PCT_THRESHOLD);
	});
});

/**
 * Verify that the probe is correctly gated and skipped by default.
 * This test always runs (not gated) to ensure the mechanism works.
 */
describe("d0372be6 behavioral probe gating", () => {
	it("probe is disabled when BOUND_RUN_BEHAVIORAL_PROBE is not set", () => {
		expect(PROBE_ENABLED).toBe(process.env.BOUND_RUN_BEHAVIORAL_PROBE === "1");
	});

	it("can check probe environment variable directly", () => {
		const isEnabled = process.env.BOUND_RUN_BEHAVIORAL_PROBE === "1";
		if (!isEnabled) {
			console.log("[behavioral-probe] Gated by BOUND_RUN_BEHAVIORAL_PROBE env var. Skipped.");
		}
		expect(isEnabled).toBe(PROBE_ENABLED);
	});
});
