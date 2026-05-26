/**
 * Production-shape fixture — reproduces the 30-40% hit rate band observed
 * on threads `6fff1513-...`, `91a31a43-...`, `b4541575-...`.
 *
 * The hit-rate denominator is dominated by `tokens_in` (non-cached input).
 * A hermetic harness with a tiny system prompt and 200-byte tool results
 * has so little `tokens_in` per inference that even modest cache reads
 * push the ratio toward 100%. Production threads carry:
 *   - ~67k token volatile-prefix (Working Knowledge + Discoverable Archive
 *     + skill bodies + database schema dump)
 *   - ~2-15k token tool_result payloads (boundless_bash output, query
 *     SELECT result rows, big memory recall blobs)
 *   - 5-40 inner-loop iterations per user-turn, each adding more history
 *     to the next inference's input
 *
 * The harness fixture below approximates this via two levers:
 *
 *  1. `threadSummary` carries ~6k chars of persistent context that gets
 *     prepended into the cached prefix on every cold turn. Stable byte-
 *     for-byte across the run so it remains in cache.
 *  2. The `boundless_bash` tool stub returns a ~3000-char synthetic
 *     stdout per call. With 5-10 inner-loop iterations per turn the
 *     accumulated history pushes `tokens_in` into the production band.
 *
 * Tool result content is deterministic — the harness's run-to-run
 * byte-stability guarantee depends on identical stub outputs. Variable
 * fields like the `cwd` echo are constant strings.
 */

import type { HarnessFixture } from "./types";

const SYNTHETIC_DIRECTORY_LISTING = [
	"agent-harness/",
	"  README.md",
	"  args.ts",
	"  capture.ts",
	"  diagnostics/",
	"    cache.ts",
	"    index.ts",
	"    types.ts",
	"  driver.ts",
	"  fixtures/",
	"    autonomous-task.ts",
	"    index.ts",
	"    production-shape.ts",
	"    types.ts",
	"  run.ts",
	"  tsconfig.json",
].join("\n");

const SYNTHETIC_GIT_LOG_LINE =
	"5ca1ea45 refactor(agent-harness): close divergence vectors with production agent loop";

// ~3000 chars — synthesized from the kind of output `boundless_bash`
// emits in real autonomous-task threads. Deterministic, large enough that
// 5-10 inner-loop accumulations push tokens_in into production range.
const SYNTHETIC_LINES = Array.from(
	{ length: 60 },
	(_, i) => `${String(i + 1).padStart(4, " ")}  ${SYNTHETIC_GIT_LOG_LINE}`,
).join("\n");
const SYNTHETIC_STDOUT_BLOCK = `${SYNTHETIC_LINES}\n\n${SYNTHETIC_DIRECTORY_LISTING}\n`.repeat(2);

export const productionShapeFixture: HarnessFixture = {
	name: "production-shape",
	description:
		"Approximates the production autonomous-task shape: large thread.summary, ~3k-char tool results to drive tokens_in into the 30-40% hit-rate band",

	initialUserContent:
		"Investigate the cache marker placement code and produce a one-paragraph summary of how the recovery rule works.",

	threadSummary: [
		"# Conversation summary",
		"",
		"## Goal",
		"",
		"The user has been investigating prompt-cache hit rates on Bedrock-Anthropic.",
		"They've shipped six fixes over multiple sessions and want to verify the",
		"agent-harness can reproduce production hit-rate patterns hermetically.",
		"",
		"## What's been confirmed",
		"",
		"- Critical Invariant #17: `toRouterConfig` is the single hand-off seam",
		"  between SharedModelBackendsConfig and ModelBackendsConfig.",
		"- The agent loop's inner loop produces N inferences per user-turn, each",
		"  recording its own `turns` row via `recordTurn`.",
		"- The cache diagnostic reads cr/cw from `StreamChunk.done.usage`, which",
		"  `ai-sdk-bridge.mapChunks` normalizes across providers.",
		"",
		"## Patterns observed in production threads",
		"",
		"1. `6fff1513-...`: 38.19% hit rate, multi-user (3 users). Stage 1.7",
		"   prepended a developer-role compaction summary. Each new user message",
		"   advanced the message-level cachePoint by exactly one user-turn boundary.",
		"2. `91a31a43-...`: 38.37% hit rate, single user (autonomous task). Parallel",
		"   tool calls within asst responses. cw=0 across most turns after the",
		"   initial system anchor write because the placer was refusing placement",
		"   when only developers preceded user_1 (fixed in 71ebc11e).",
		"3. `b4541575-...`: 34.13% hit rate, lots of inner-loop iterations. AI SDK",
		"   was collapsing consecutive tool messages and dropping providerOptions,",
		"   causing the cachePoint to vanish on the wire (fixed in 0c6cfb2d).",
		"",
		"## What the harness should observe",
		"",
		"Inference 1 of any thread is a cold rebuild that writes the entire stable",
		"prefix (system + volatile-prefix + skill index) to the cache. Inferences",
		"2..N read that prefix back and write small extensions for newly-stable",
		"history. Bedrock account-level cache means the first inference of run K+1",
		"may read the prefix that run K wrote — so cache_read on inference 1 of a",
		"second run is sometimes nonzero even though it's structurally a cold path.",
	].join("\n"),

	tools: [
		{
			type: "function",
			function: {
				name: "boundless_bash",
				description:
					"Execute a bash command in the user's working directory. Returns stdout/stderr/exit_code as a structured tool result.",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "The shell command" },
					},
					required: ["command"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "boundless_read",
				description:
					"Read the contents of a file in the user's working directory. Returns up to 2000 lines.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Absolute path to the file" },
					},
					required: ["path"],
				},
			},
		},
	],

	toolStubs: {
		boundless_bash: (input) => {
			const command = String(input.command ?? "");
			return [
				"[boundless] host=harness cwd=/Users/harness/bound tool=boundless_bash",
				"Exit code: 0",
				"stdout:",
				`$ ${command}`,
				SYNTHETIC_STDOUT_BLOCK,
				"",
				"stderr:",
				"",
			].join("\n");
		},
		boundless_read: (input) => {
			const path = String(input.path ?? "");
			return [
				"[boundless] host=harness cwd=/Users/harness/bound tool=boundless_read",
				`File: ${path}`,
				"",
				SYNTHETIC_STDOUT_BLOCK,
			].join("\n");
		},
	},
};
