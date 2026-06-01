/**
 * Inner-loop temporal-frame coherence.
 *
 * Live evidence from threads 25687e6c-ff06-4e91-ae3f-7db91f112d9c (sonnet,
 * 11 inner-loop turns in one run) and d0372be6-bd60-452d-958b-249042c884a1
 * (kimi/opus webhook task) shows that within a single AgentLoop.run()
 * invocation, every recorded turn writes the same totalEstimated value to
 * context_debug while actualTotalTokens climbs turn-over-turn. The cold-
 * assembly snapshot of section sizes is captured once and never refreshed
 * inside the `while (continueLoop)` loop, even though each iteration
 * appends a tool_call + tool_result pair to llmMessages.
 *
 * Downstream effects:
 *   - inflation EMA mistakes tool-roundtrip growth for tokenizer error
 *   - adaptive truncation ratio drifts low (observed: 0.85 → 0.71 over
 *     ~13 turns on a thinking-heavy thread)
 *   - context-debug visualization shows history.tokens=7 for every turn
 *     in a thread that's actually accumulated 11 tool roundtrips
 *
 * This test pins the per-turn coherence requirement: each LLM call inside
 * a single run() should record a totalEstimated that reflects the wire
 * payload for THAT call, not the wire payload at cold-assembly time.
 */
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemoryTurnStateStore,
	applyMetricsSchema,
	applySchema,
	createDatabase,
} from "@bound/core";
import type { AppContext } from "@bound/core";
import type { ChatParams, LLMBackend, LLMMessage, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { countContentTokens } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { AgentLoop } from "../agent-loop";

let globalTmpDir: string;
let globalDb: Database;
let globalThreadId: string;
let globalUserId: string;

beforeAll(() => {
	globalTmpDir = mkdtempSync(join(tmpdir(), "inner-loop-temporal-frame-test-"));
	const dbPath = join(globalTmpDir, "test.db");
	globalDb = createDatabase(dbPath);
	applySchema(globalDb);
	applyMetricsSchema(globalDb);

	globalUserId = randomUUID();
	globalDb.run(
		"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
		[globalUserId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
	);
});

beforeEach(() => {
	globalThreadId = randomUUID();
});

afterAll(async () => {
	globalDb.close();
	if (globalTmpDir) await cleanupTmpDir(globalTmpDir);
});

class MockLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private postHooks: Array<(() => void) | null> = [];
	private capturedMessages: ChatParams["messages"][] = [];
	private callCount = 0;

	pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
		this.postHooks.push(null);
	}

	pushResponseWithPostHook(gen: () => AsyncGenerator<StreamChunk>, postHook: () => void) {
		this.responses.push(gen);
		this.postHooks.push(postHook);
	}

	getCallCount() {
		return this.callCount;
	}

	getCapturedMessages() {
		return this.capturedMessages;
	}

	async *chat(params: ChatParams) {
		// Snapshot the messages array as it arrived at this call. We
		// spread-copy so any later mutations to llmMessages by the
		// agent loop don't retroactively alter the captured snapshot.
		this.capturedMessages.push([...params.messages]);
		const gen = this.responses[this.callCount];
		const hook = this.postHooks[this.callCount];
		this.callCount++;
		if (gen) {
			yield* gen();
		} else {
			yield { type: "text" as const, content: "" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		}
		// Run the post-hook AFTER chunks are exhausted but before the
		// outer generator returns. Side effect: any DB mutation here
		// is visible to the next chat() call's volatile-context build.
		if (hook) hook();
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: false,
			max_context: 200000,
		};
	}
}

/**
 * Like MockLLMBackend, but additionally records the per-call wire size
 * (sum of system + tool definitions + countContentTokens over messages,
 * minus cache-marker placeholders). Tests can call `lastWireSize()` from
 * inside their response generators to emit a `done.usage.input_tokens`
 * that mirrors the real wire payload, eliminating arbitrary mock-token
 * noise from inflation-ratio assertions.
 */
class MockLLMBackendWithWireCount extends MockLLMBackend {
	private wireSizes: number[] = [];

	lastWireSize(): number {
		return this.wireSizes[this.wireSizes.length - 1] ?? 0;
	}

	override async *chat(params: ChatParams) {
		const messageTokens = params.messages.reduce((sum, m) => {
			if (m.role === "cache") return sum;
			return sum + countContentTokens(m.content);
		}, 0);
		const systemTokens = params.system ? countContentTokens(params.system) : 0;
		const toolTokens = params.tools ? countContentTokens(JSON.stringify(params.tools)) : 0;
		this.wireSizes.push(messageTokens + systemTokens + toolTokens);
		yield* super.chat(params);
	}
}

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

function makeCtx(turnStateStore?: InMemoryTurnStateStore): AppContext {
	return {
		db: globalDb,
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		eventBus: { on: () => {}, off: () => {}, emit: () => {} },
		hostName: "test-host",
		siteId: "test-site-id",
		turnStateStore: turnStateStore ?? new InMemoryTurnStateStore(),
	} as unknown as AppContext;
}

function createMockSandbox() {
	// Returns enough output tokens that an honestly-counted per-turn
	// estimate would visibly grow across iterations. The exec output is
	// deterministic so test assertions don't depend on timing.
	const padding = " ".concat("token-padding ".repeat(80));
	return {
		calls: [] as string[],
		exec: async (_cmd: string) => ({
			stdout: `mock tool output content${padding}`,
			stderr: "",
			exitCode: 0,
		}),
	};
}

function seedThreadWithUserMessage(
	threadId: string,
	userText: string,
	options: { summary?: string } = {},
) {
	const now = new Date().toISOString();
	globalDb.run(
		"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			threadId,
			globalUserId,
			"web",
			"local",
			0,
			"Inner Loop Frame Test",
			options.summary ?? null,
			options.summary ? now : null,
			null,
			null,
			new Date().toISOString(),
			new Date().toISOString(),
			new Date().toISOString(),
			0,
		],
	);
	globalDb.run(
		"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			randomUUID(),
			threadId,
			"user",
			userText,
			null,
			null,
			new Date().toISOString(),
			new Date().toISOString(),
			"local",
			0,
		],
	);
}

interface TurnRow {
	id: string;
	estimated: number;
	actual: number | null;
	tokens_in: number;
}

function readRecordedTurns(threadId: string): TurnRow[] {
	return globalDb
		.query(
			`SELECT id,
			        json_extract(context_debug, '$.totalEstimated') AS estimated,
			        json_extract(context_debug, '$.actualTotalTokens') AS actual,
			        tokens_in
			 FROM turns
			 WHERE thread_id = ? AND deleted = 0
			 ORDER BY created_at ASC, rowid ASC`,
		)
		.all(threadId) as TurnRow[];
}

describe("inner-loop temporal-frame coherence", () => {
	it("records a per-turn totalEstimated that reflects each LLM call's wire payload, not the cold-assembly snapshot", async () => {
		seedThreadWithUserMessage(globalThreadId, "Run two bash commands then summarize");

		const mockBackend = new MockLLMBackend();

		// Inner loop turn 1: agent emits a bash tool call
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "tool-1", name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: "tool-1",
				partial_json: JSON.stringify({ command: "echo first" }),
			};
			yield { type: "tool_use_end" as const, id: "tool-1" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 100,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		// Inner loop turn 2: agent emits another bash tool call (forces a
		// second iteration of the inner while-continueLoop)
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "tool-2", name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: "tool-2",
				partial_json: JSON.stringify({ command: "echo second" }),
			};
			yield { type: "tool_use_end" as const, id: "tool-2" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 250,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		// Inner loop turn 3: terminal text response — exits the inner loop
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Done with both commands." };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 400,
					output_tokens: 15,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const ctx = makeCtx();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId: globalThreadId,
			userId: globalUserId,
		});
		await loop.run();

		// Sanity: the inner loop ran AT LEAST our three queued responses.
		// (May run one trailing default-empty call against the mock's
		// fallback branch; that's incidental to the temporal-frame
		// invariant we're testing here.)
		expect(mockBackend.getCallCount()).toBeGreaterThanOrEqual(3);

		const rows = readRecordedTurns(globalThreadId);
		// Only the three non-empty responses produce recorded turns
		// (the fallback empty response yields input_tokens=0 which
		// short-circuits the `applyActualUsageToContextDebug` update).
		// Take the first three recorded turns as our inner-loop sample.
		expect(rows.length).toBeGreaterThanOrEqual(3);
		const sample = rows.slice(0, 3);

		// Each turn's recorded actualTotalTokens should match the LLM's
		// reported input_tokens — sanity check that recording wiring works.
		expect(sample[0].actual).toBe(100);
		expect(sample[1].actual).toBe(250);
		expect(sample[2].actual).toBe(400);

		// The core invariant: per-turn totalEstimated must reflect the wire
		// payload at THAT turn. Turn 2 sends [system, history, user,
		// tool_call_1, tool_result_1, volatile-tail] — strictly more wire
		// content than turn 1, which sent only [system, history, user,
		// volatile-tail]. Turn 3 sends two tool roundtrips and must be
		// strictly larger than turn 2.
		//
		// Today this fails because `applyActualUsageToContextDebug` updates
		// only actualTotalTokens; totalEstimated stays frozen at the cold-
		// assembly value across all inner-loop iterations. Live evidence:
		// thread 25687e6c records totalEstimated=79862 across all 11 of its
		// inner-loop turns while actualTotalTokens climbs 90823 → 109701.
		expect(sample[1].estimated).toBeGreaterThan(sample[0].estimated);
		expect(sample[2].estimated).toBeGreaterThan(sample[1].estimated);
	});

	it("does not poison the inflation ratio with tool-roundtrip growth", async () => {
		// Companion assertion: the ratio actualTotalTokens / totalEstimated
		// must reflect tokenizer drift only, not the agent loop's failure
		// to refresh totalEstimated across inner-loop turns. With a mock
		// LLM whose input_tokens equals the actual wire size (no tokenizer
		// drift), the per-turn ratio should be ~1.0 across all inner-loop
		// turns. Today it grows because the denominator is frozen.
		seedThreadWithUserMessage(globalThreadId, "Run bash twice");

		// Make the mock report `input_tokens` that matches the real
		// per-call wire payload (system + messages + tools). Without
		// this the mock emits arbitrary token counts and the (actual
		// / estimated) ratios carry that arbitrariness, defeating the
		// test. Matching wire size means actual and estimated should
		// agree across the entire inner loop — so the ratio span is a
		// direct measure of agent-loop snapshot coherence.
		const mockBackend = new MockLLMBackendWithWireCount();

		function doneFromWire() {
			const wire = mockBackend.lastWireSize();
			return {
				type: "done" as const,
				usage: {
					input_tokens: wire,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		}

		for (let i = 0; i < 2; i++) {
			mockBackend.pushResponse(async function* () {
				yield { type: "tool_use_start" as const, id: `tool-${i}`, name: "bash" };
				yield {
					type: "tool_use_args" as const,
					id: `tool-${i}`,
					partial_json: JSON.stringify({ command: `echo ${i}` }),
				};
				yield { type: "tool_use_end" as const, id: `tool-${i}` };
				yield doneFromWire();
			});
		}
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Done." };
			yield doneFromWire();
		});

		const ctx = makeCtx();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId: globalThreadId,
			userId: globalUserId,
		});
		await loop.run();

		const rows = readRecordedTurns(globalThreadId);
		expect(rows.length).toBeGreaterThanOrEqual(3);
		const sample = rows.slice(0, 3);

		// The ratio range across the run() is the EMA's input. If
		// totalEstimated grows in lockstep with actualTotalTokens, the
		// max-min span should be small (~within 1.2x). If totalEstimated
		// is frozen, the span widens dramatically: live data showed
		// 90823/79862=1.14 at turn 1 and 109701/79862=1.37 at turn 11
		// — a ~20% widening that ends up tightening the adaptive
		// truncation ratio for no real reason.
		const ratios = sample
			.filter((r) => r.actual !== null && r.estimated > 0)
			.map((r) => (r.actual as number) / r.estimated);
		expect(ratios.length).toBe(3);
		const minRatio = Math.min(...ratios);
		const maxRatio = Math.max(...ratios);
		// With a coherent per-turn estimate, the ratio span should be
		// modest (well under 1.2x). With the frozen-snapshot bug, the
		// span widens past this threshold as actualTotalTokens grows.
		expect(maxRatio / minRatio).toBeLessThan(1.2);
	});

	it("rebuilds the volatile-tail developer message to reflect mid-run state mutations", async () => {
		// Live evidence from thread 25687e6c-ff06-4e91-ae3f-7db91f112d9c:
		// across 11 inner-loop turns the agent re-stated "the user is
		// asking me to delete /Users again - this is on the web platform"
		// in its thinking blocks even AFTER its own prior tool calls had
		// already deleted the file row, because the volatile-tail
		// developer message in llmMessages was set once at cold-assembly
		// time and never refreshed.
		//
		// This test pins the rebuild requirement using `applied`
		// advisories, which `renderLiveState` formats as
		// `- [advisory] <title> — applied <relative-time>`. The advisory
		// query has a wallclock 24h cutoff (not baseline-dependent), so
		// the test isolates the volatile-tail rebuild question from the
		// L3-baseline question.
		seedThreadWithUserMessage(globalThreadId, "Run a bash command then summarize");

		const advisoryTitle = `mid-run-mutation-marker-${randomUUID()}`;
		const advisoryId = randomUUID();

		const mockBackend = new MockLLMBackend();

		// Inner loop turn 1: tool_use bash. AFTER chunks consumed but
		// BEFORE the next chat() call, insert an applied advisory
		// timestamped now. If the volatile-tail is rebuilt per inner-
		// loop turn, the next call's developer message will include
		// this advisory; if frozen, it won't.
		mockBackend.pushResponseWithPostHook(
			async function* () {
				yield { type: "tool_use_start" as const, id: "tool-1", name: "bash" };
				yield {
					type: "tool_use_args" as const,
					id: "tool-1",
					partial_json: JSON.stringify({ command: "echo first" }),
				};
				yield { type: "tool_use_end" as const, id: "tool-1" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 100,
						output_tokens: 5,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			},
			() => {
				const now = new Date().toISOString();
				globalDb.run(
					"INSERT INTO advisories (id, type, status, title, detail, action, impact, evidence, proposed_at, defer_until, resolved_at, created_by, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[
						advisoryId,
						"general",
						"applied",
						advisoryTitle,
						"Mutation marker — should appear in Live State on next inner-loop call if volatile-tail is rebuilt",
						null,
						null,
						null,
						now,
						null,
						now,
						"test-site-id",
						now,
						0,
					],
				);
			},
		);

		// Inner loop turn 2: terminal text. The captured params.messages
		// for this call is the test target — does its developer message
		// reflect the advisory inserted between calls?
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Done." };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 200,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const ctx = makeCtx();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId: globalThreadId,
			userId: globalUserId,
		});
		await loop.run();

		expect(mockBackend.getCallCount()).toBeGreaterThanOrEqual(2);
		const calls = mockBackend.getCapturedMessages();
		expect(calls.length).toBeGreaterThanOrEqual(2);

		// The volatile-tail is the developer-role message in the
		// cold-assembled messages array. In our test setup (no purge
		// summary, no compaction summary) there's exactly one such
		// message per call.
		function findDeveloperTail(messages: LLMMessage[]): string {
			const dev = messages.find((m) => m.role === "developer");
			if (!dev) return "";
			return typeof dev.content === "string" ? dev.content : JSON.stringify(dev.content);
		}

		const call1Tail = findDeveloperTail(calls[0]);
		const call2Tail = findDeveloperTail(calls[1]);

		// Sanity: each captured call has a non-empty developer-role tail.
		expect(call1Tail.length).toBeGreaterThan(0);
		expect(call2Tail.length).toBeGreaterThan(0);

		// Sanity: call 1's tail must NOT contain the advisory — it was
		// inserted AFTER call 1's chunks completed.
		expect(call1Tail).not.toContain(advisoryTitle);

		// The core invariant: call 2's volatile-tail must reflect the
		// state mutation that happened between calls 1 and 2. Today
		// this fails because llmMessages keeps the same developer
		// message reference across all inner-loop iterations — the
		// agent loop never re-runs `buildVolatileContext` inside
		// `while (continueLoop)`. After fix, each inner-loop iteration
		// rebuilds the volatile-tail and the new advisory line shows
		// up in the next call's developer message.
		expect(call2Tail).toContain(advisoryTitle);
	});

	it("warm path injects ONLY varyingContent into the developer tail (no stable-subsection duplication)", async () => {
		// Live evidence captured via the agent-harness production-shape
		// fixture (2026-05-26): warm-path inferences carried a 226,238-
		// byte trailing user message containing the FULL Working Knowledge
		// + Discoverable Archive + skill index XML — exactly the content
		// already in the cached system prompt. The cold path correctly
		// uses `volatileContext.varyingContent` for the developer tail
		// (varying-only); the warm path uses `volatileContext.content`
		// (stable + varying), duplicating ~224k bytes per warm turn.
		// Effect: every warm-path inference paid `tokens_in` for the
		// stable subsection a SECOND time even though the cache anchor
		// already covered it — a massive pessimization of the
		// hit-rate denominator.
		//
		// The contract: warm-path developer-tail injection uses
		// `varyingContent` only. The stable subsection lives in the
		// cached system prompt; injecting it again in the dev tail
		// merely inflates tokens_in.
		//
		// Detection: assert the developer-tail dev message in the warm-
		// path captured params doesn't contain the Working Knowledge
		// header. The header is a stable-subsection-only literal.
		const summaryMarker = `WARM-PATH-DEV-TAIL-${randomUUID()}`;
		seedThreadWithUserMessage(globalThreadId, "Run two bash commands then summarize", {
			summary: `harness summary ${summaryMarker}`,
		});
		// Seed pinned memory entries so Working Knowledge has rendered
		// content. Without this the stable subsection is empty and the
		// duplication isn't visible — the test would falsely pass.
		const now = new Date().toISOString();
		// Multiple entries — Working Knowledge needs N>0 pinned with
		// rendered content to emit its header.
		for (let i = 0; i < 5; i++) {
			globalDb.run(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					`_pinned:warm-path-test:marker-${i}`,
					`pinned-marker-content-${summaryMarker}-${i} sentence with reasonable length to render in WK section`,
					null,
					now,
					now,
					now,
					0,
					"pinned",
				],
			);
		}

		const mockBackend = new MockLLMBackend();
		// Inner-loop turn 1: cold path. Need this to populate cached
		// turn state so turn 2 takes the warm path. The done chunk
		// MUST report nonzero cache_write — predictCacheState gates
		// warm-vs-cold on the last turn having recorded cache activity.
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "tool-1", name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: "tool-1",
				partial_json: JSON.stringify({ command: "echo first" }),
			};
			yield { type: "tool_use_end" as const, id: "tool-1" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 100,
					output_tokens: 5,
					cache_write_tokens: 100,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Cold path done." };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 200,
					output_tokens: 10,
					cache_write_tokens: 50,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const ctx = makeCtx();
		const loop1 = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId: globalThreadId,
			userId: globalUserId,
		});
		await loop1.run();

		// Insert a NEW user message and run again — second run takes
		// the warm path (cached turn state is alive in turnStateStore).
		globalDb.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				randomUUID(),
				globalThreadId,
				"user",
				"second user message",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
				0,
			],
		);

		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Warm path done." };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 300,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const callsBefore = mockBackend.getCapturedMessages().length;
		const loop2 = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId: globalThreadId,
			userId: globalUserId,
		});
		await loop2.run();

		const allCalls = mockBackend.getCapturedMessages();
		expect(allCalls.length).toBeGreaterThan(callsBefore);

		// First call after the second run — the warm path's first inference.
		const warmCall = allCalls[callsBefore];
		const developers = warmCall.filter((m) => m.role === "developer");
		expect(developers.length).toBeGreaterThan(0);
		// Combine all developer contents — varying content is what we expect
		// to find here. Stable subsection content (pinned marker, Working
		// Knowledge header) MUST NOT appear in any developer message — the
		// system prompt already covers it via the cache anchor.
		const allDevText = developers
			.map((d) => (typeof d.content === "string" ? d.content : JSON.stringify(d.content)))
			.join("\n");

		// Sanity: at least the User/Thread ID line (varying) is present.
		expect(allDevText).toContain(globalThreadId);

		// Load-bearing: the Working Knowledge header (a stable-subsection
		// literal) must NOT appear in the developer tail. If it does, we're
		// duplicating ~Nk bytes that the system-prompt cache anchor
		// already covers. (The header literal lives in summary-extraction.)
		expect(allDevText).not.toContain("## Working Knowledge — operational and durable");
		// And specifically the seeded pinned-memory marker — its presence
		// in the dev tail means the stable subsection got duplicated.
		expect(allDevText).not.toContain("pinned-marker-content-WARM-PATH-DEV-TAIL");
	});

	it("preserves the Stage 1.7 compaction-summary developer when refreshing the volatile-tail (load-bearing)", async () => {
		// Live regression observed via the agent-harness on
		// `production-shape` fixture (2026-05-26): between two consecutive
		// inner-loop iterations of the same outer-turn, cumulative cache
		// dropped by 22,363 tokens (cr 80,952 → 58,589) because the wire
		// body's first user message changed by 232k bytes.
		//
		// Root cause: `refreshVolatileTailForNextTurn` calls
		// `llmMessages.findIndex((m) => m.role === "developer")`, which
		// returns the FIRST developer. When `assembleContext` Stage 1.7
		// prepended a compaction-summary developer at the head of
		// llmMessages (because `thread.summary` is set), that's the one
		// that gets overwritten — silently destroying the byte-stable
		// summary content and leaving the actual TAIL volatile-tail
		// stale.
		//
		// The contract: `refreshVolatileTailForNextTurn` MUST replace
		// the LAST developer (the volatile-tail), not the first. The
		// HEAD compaction summary stays untouched so its byte-stable
		// content keeps Bedrock's cache prefix matching turn-over-turn.
		const summaryMarker = `STAGE-1.7-MARKER-${randomUUID()}`;
		seedThreadWithUserMessage(globalThreadId, "Run two bash commands", {
			summary: `harness compaction summary body containing ${summaryMarker}`,
		});

		const advisoryTitle = `volatile-tail-mutation-${randomUUID()}`;
		const advisoryId = randomUUID();

		const mockBackend = new MockLLMBackend();
		// Inner loop turn 1: tool_use bash. Insert applied advisory
		// after chunks consumed; refresh fires at the top of turn 2.
		mockBackend.pushResponseWithPostHook(
			async function* () {
				yield { type: "tool_use_start" as const, id: "tool-1", name: "bash" };
				yield {
					type: "tool_use_args" as const,
					id: "tool-1",
					partial_json: JSON.stringify({ command: "echo first" }),
				};
				yield { type: "tool_use_end" as const, id: "tool-1" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 100,
						output_tokens: 5,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			},
			() => {
				const now = new Date().toISOString();
				globalDb.run(
					"INSERT INTO advisories (id, type, status, title, detail, action, impact, evidence, proposed_at, defer_until, resolved_at, created_by, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[
						advisoryId,
						"general",
						"applied",
						advisoryTitle,
						"Mutation marker",
						null,
						null,
						null,
						now,
						null,
						now,
						"test-site-id",
						now,
						0,
					],
				);
			},
		);
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Done." };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 200,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const ctx = makeCtx();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId: globalThreadId,
			userId: globalUserId,
		});
		await loop.run();

		const calls = mockBackend.getCapturedMessages();
		expect(calls.length).toBeGreaterThanOrEqual(2);

		// Find ALL developer messages in each call so we can distinguish
		// the head-summary and the tail-volatile-tail.
		function findAllDeveloperContents(messages: LLMMessage[]): string[] {
			return messages
				.filter((m) => m.role === "developer")
				.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
		}

		const call1Devs = findAllDeveloperContents(calls[0]);
		const call2Devs = findAllDeveloperContents(calls[1]);

		// Sanity: call 1 carries TWO developers — the Stage 1.7 head
		// summary AND the tail volatile-tail.
		expect(call1Devs.length).toBeGreaterThanOrEqual(2);
		expect(call1Devs.some((c) => c.includes(summaryMarker))).toBe(true);

		// Call 2: BOTH developers must still be present (head intact, tail
		// refreshed with the new advisory).
		expect(call2Devs.length).toBeGreaterThanOrEqual(2);

		// Load-bearing: the head summary marker must still be in call 2's
		// developer messages. Without the fix, the refresh helper
		// overwrites the head summary with the volatile-tail content,
		// dropping the marker.
		expect(call2Devs.some((c) => c.includes(summaryMarker))).toBe(true);

		// Sanity: the volatile-tail mutation IS observed in call 2's
		// developer messages (so we know the refresh ran).
		expect(call2Devs.some((c) => c.includes(advisoryTitle))).toBe(true);

		// Stronger property: the head summary developer's content is
		// byte-equal between call 1 and call 2 — refresh must touch only
		// the tail.
		const call1Head = call1Devs.find((c) => c.includes(summaryMarker));
		const call2Head = call2Devs.find((c) => c.includes(summaryMarker));
		expect(call2Head).toBe(call1Head);
	});

	it("places a rolling cachePoint on each inner-loop iteration after the first", async () => {
		// Live regression observed via the agent-harness on
		// `production-shape` fixture (2026-05-26, /tmp/h8/turn-{2..6}.json):
		// across a 5-iter cold-path inner loop, the wire body's only
		// message-level cachePoint stayed at user_1 (the semantic anchor).
		// Each iteration's appended `tool_call + tool_result` content lived
		// outside the cache region, so cr stayed pinned at the system+user_1
		// floor (59,510 tokens) while ti climbed 63k → 84k. The next outer-
		// turn's first warm-path inference then had to write ~25k of cache
		// to seed what the inner loop produced cold.
		//
		// Fix: at the top of each inner-loop iteration after the first,
		// maintain a bounded trailing PAIR of rolling cachePoints — retain
		// iter K-1's rolling marker (the explicit "previous write position"
		// breakpoint) and place a fresh one before the volatile-tail. This
		// gives iter K an exact-byte-position breakpoint at iter K-1's write
		// position rather than relying on Bedrock's lookback to bridge a
		// large tool_result append. The fixed semantic-anchor at user_1 is
		// preserved; older rollings (iter K-2 and earlier) are evicted so the
		// pair never accumulates unbounded.
		//
		// This test pins the contract by inspecting `params.messages`
		// captured per chat() call: iter 1 carries the fixed marker only;
		// iter 2 adds the first rolling (fixed + 1 rolling); iter 3 fills the
		// trailing pair (fixed + prev-rolling + new-rolling) and stays bounded
		// there for all later iterations.
		seedThreadWithUserMessage(globalThreadId, "Run 3 bash commands");
		const mockBackend = new MockLLMBackend();

		// Iter 1 — tool_use → continues to iter 2.
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "tool-1", name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: "tool-1",
				partial_json: JSON.stringify({ command: "echo first" }),
			};
			yield { type: "tool_use_end" as const, id: "tool-1" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 100,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		// Iter 2 — tool_use → continues to iter 3.
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "tool-2", name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: "tool-2",
				partial_json: JSON.stringify({ command: "echo second" }),
			};
			yield { type: "tool_use_end" as const, id: "tool-2" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 200,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		// Iter 3 — terminal text exits the inner loop.
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "All done." };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 300,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const ctx = makeCtx();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId: globalThreadId,
			userId: globalUserId,
		});
		await loop.run();

		const calls = mockBackend.getCapturedMessages();
		expect(calls.length).toBeGreaterThanOrEqual(3);

		// The contract: iter 2 adds the first inner-loop rolling marker (no
		// prior rolling exists yet, so it's fixed + 1). Iter 3 fills the
		// trailing PAIR — iter 2's rolling is RETAINED as the previous-write
		// breakpoint and a fresh rolling is placed at the tip, so iter 3
		// carries one more marker than iter 2. Older rollings are evicted so
		// the pair stays bounded (iter 4+ would also carry iter1 + 2).
		const countCacheMarkers = (msgs: (typeof calls)[0]) =>
			msgs.filter((m) => m.role === "cache").length;
		const iter1Count = countCacheMarkers(calls[0]);
		const iter2Count = countCacheMarkers(calls[1]);
		const iter3Count = countCacheMarkers(calls[2]);

		// Iter 2 carries the first rolling that iter 1 didn't.
		expect(iter2Count).toBe(iter1Count + 1);

		// Iter 3: prior rolling RETAINED + new rolling placed — the trailing
		// pair is now full, one more marker than iter 2.
		expect(iter3Count).toBe(iter2Count + 1);

		// Stronger property: iter 2's rolling marker sits at a strictly
		// later index than any marker iter 1 carried. The rolling rides
		// just before the volatile-tail at the END of the message array,
		// while the fixed marker (if any) anchors at the head.
		const iter2RollingIdx = calls[1].findIndex(
			(m, i) => m.role === "cache" && i === calls[1].length - 2,
		);
		expect(iter2RollingIdx).toBeGreaterThanOrEqual(0);
	});
});
