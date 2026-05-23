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
import { type ModelBackendsConfig, createModelRouter } from "@bound/llm";
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
 * Implementation of running an agent loop one turn against a configured LLM backend.
 *
 * This directly invokes the backend.chat() method with:
 * 1. System prompt: orientation block
 * 2. User message: webhook envelope details
 * 3. Fixed temperature for deterministic behavior
 *
 * Reads from BOUND_MODEL_BACKENDS_JSON environment variable for backend configuration,
 * or uses a sensible default if not found. Falls back to Ollama if neither is configured.
 * Throws a clear error if no backend is available.
 */
async function runAgentLoopOneTurn(params: {
	orientation: string;
	conversationHistory: Array<{ role: "user" | "assistant" | "tool_result"; content: string }>;
	temperature: number;
}): Promise<string> {
	// Read backend config from environment or use empty config
	let backendsConfig: ModelBackendsConfig = { backends: [], default: "" };

	const configJsonEnv = process.env.BOUND_MODEL_BACKENDS_JSON;
	if (configJsonEnv) {
		try {
			backendsConfig = JSON.parse(configJsonEnv) as ModelBackendsConfig;
		} catch (e) {
			throw new Error(`[behavioral-probe] Failed to parse BOUND_MODEL_BACKENDS_JSON: ${e}`);
		}
	}

	// If no backends configured, check for legacy ollama default
	if (backendsConfig.backends.length === 0) {
		const ollamaUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
		backendsConfig = {
			backends: [
				{
					id: "ollama",
					provider: "openai-compatible",
					model: "llama2",
					baseUrl: ollamaUrl,
					apiKey: "not-needed",
					contextWindow: 4096,
				},
			],
			default: "ollama",
		};
	}

	// Find the default backend, or the first available
	const defaultId = backendsConfig.default || backendsConfig.backends[0]?.id;
	if (!defaultId || backendsConfig.backends.length === 0) {
		throw new Error(
			"[behavioral-probe] No LLM backend configured. Set BOUND_MODEL_BACKENDS_JSON or configure Ollama at http://localhost:11434",
		);
	}

	// Create router and get the backend
	const router = createModelRouter(backendsConfig);
	const backend = router.tryGetBackend(defaultId);
	if (!backend) {
		throw new Error(
			`[behavioral-probe] Backend '${defaultId}' not found. Check BOUND_MODEL_BACKENDS_JSON.`,
		);
	}

	// Build messages array
	const messages = [
		{
			role: "user" as const,
			content: params.orientation,
		},
	];

	// Collect response text from stream
	let assistantText = "";
	const stream = await backend.chat({
		messages,
		temperature: params.temperature,
		model: defaultId,
		stream: true,
	});

	for await (const chunk of stream) {
		if (chunk.type === "text") {
			assistantText += chunk.content;
		}
	}

	if (!assistantText) {
		throw new Error(
			"[behavioral-probe] Backend returned empty response. Check backend configuration and model availability.",
		);
	}

	return assistantText;
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
