import { describe, expect, it } from "bun:test";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import type { ContextDebugInfo } from "@bound/shared";
import type { LoopExtensions } from "./extensions";
import {
	type LoopToolExecutionBatch,
	type LoopTurnDecision,
	ModularAgentLoop,
} from "./modular-agent-loop";
import type { ParsedToolCall } from "./stream-parser";
import type { ToolExecutionResult } from "./types";

class MockBackend implements LLMBackend {
	constructor(private readonly turns: StreamChunk[][]) {}

	async *chat(_params: ChatParams): AsyncIterable<StreamChunk> {
		const chunks = this.turns.shift() ?? [];
		for (const chunk of chunks) {
			yield chunk;
		}
	}

	capabilities(): BackendCapabilities {
		return {} as BackendCapabilities;
	}
}

const done = (input = 10, output = 5): StreamChunk => ({
	type: "done",
	usage: {
		input_tokens: input,
		output_tokens: output,
		cache_read_tokens: null,
		cache_write_tokens: null,
		estimated: false,
	},
});

const debug: ContextDebugInfo = {
	contextWindow: 200_000,
	totalEstimated: 0,
	model: "mock",
	sections: [],
	budgetPressure: false,
	truncated: 0,
};

function makeExtensions(
	backend: LLMBackend,
	executeTool: (toolCall: ParsedToolCall) => Promise<ToolExecutionResult> = async () => ({
		content: "ok",
		exitCode: 0,
	}),
) {
	const persisted = {
		assistant: [] as unknown[],
		tools: [] as unknown[],
		turns: [] as unknown[],
		alerts: [] as string[],
	};
	const extensions: LoopExtensions = {
		context: {
			siteId: "site",
			hostName: "host",
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
		},
		modelRouter: {} as LoopExtensions["modelRouter"],
		resolveModel: () => ({ kind: "local", modelId: "mock", backend, max_context: 200_000 }),
		assembleContext: async () => ({
			messages: [{ role: "user", content: "hello" }],
			systemPrompt: "system",
			debug,
		}),
		listTools: () => [
			{
				kind: "builtin",
				toolDefinition: {
					type: "function",
					function: {
						name: "lookup",
						description: "Lookup",
						parameters: { type: "object", properties: {}, additionalProperties: true },
					},
				},
				execute: async () => "ok",
			},
		],
		executeTool,
		persistence: {
			recordTurn: async (metrics) => {
				persisted.turns.push(metrics);
				return `turn-${persisted.turns.length}`;
			},
			persistAssistantResponse: async (content) => {
				persisted.assistant.push(content);
			},
			persistToolRoundTrip: async (roundTrip) => {
				persisted.tools.push(roundTrip);
			},
			persistAlert: async (content) => {
				persisted.alerts.push(content);
			},
		},
	};
	return { extensions, persisted };
}

describe("ModularAgentLoop", () => {
	it("persists a final assistant response and turn metrics", async () => {
		const backend = new MockBackend([[{ type: "text", content: "hi" }, done()]]);
		const { extensions, persisted } = makeExtensions(backend);

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(result.messagesCreated).toBe(1);
		expect(result.toolCallsMade).toBe(0);
		expect(persisted.turns).toHaveLength(1);
		expect(persisted.assistant).toHaveLength(1);
		expect(persisted.alerts).toHaveLength(0);
	});

	it("executes tool calls and continues until a final response", async () => {
		const backend = new MockBackend([
			[
				{ type: "tool_use_start", id: "call-1", name: "lookup" },
				{ type: "tool_use_args", id: "call-1", partial_json: '{"q":"bound"}' },
				{ type: "tool_use_end", id: "call-1" },
				done(),
			],
			[{ type: "text", content: "done" }, done()],
		]);
		const { extensions, persisted } = makeExtensions(backend, async () => ({
			content: "result",
			exitCode: 0,
		}));

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(result.toolCallsMade).toBe(1);
		expect(result.messagesCreated).toBe(3);
		expect(persisted.turns).toHaveLength(2);
		expect(persisted.tools).toHaveLength(1);
		expect(persisted.assistant).toHaveLength(1);
	});

	it("lets model-error hooks retry through the base turn loop", async () => {
		const backend = new MockBackend([]);
		const { extensions, persisted } = makeExtensions(backend);

		class RetryLoop extends ModularAgentLoop {
			private calls = 0;

			protected override async callModel(): Promise<StreamChunk[]> {
				this.calls++;
				if (this.calls === 1) {
					throw new Error("temporary");
				}
				return [{ type: "text", content: "recovered" }, done()];
			}

			protected override handleModelError(): LoopTurnDecision {
				return { action: "retry" };
			}
		}

		const loop = new RetryLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(persisted.turns).toHaveLength(1);
		expect(persisted.assistant).toHaveLength(1);
		expect(persisted.alerts).toHaveLength(0);
	});

	it("applies post-record stop decisions before final response persistence", async () => {
		const backend = new MockBackend([[{ type: "text", content: "stop here" }, done()]]);
		const { extensions, persisted } = makeExtensions(backend);

		class StopAfterRecordLoop extends ModularAgentLoop {
			protected override afterRecord(): LoopTurnDecision {
				return { action: "stop" };
			}
		}

		const loop = new StopAfterRecordLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(persisted.turns).toHaveLength(1);
		expect(persisted.assistant).toHaveLength(0);
	});

	it("returns yielded when the tool handler yields", async () => {
		const backend = new MockBackend([
			[
				{ type: "tool_use_start", id: "call-1", name: "lookup" },
				{ type: "tool_use_end", id: "call-1" },
				done(),
			],
		]);
		const { extensions, persisted } = makeExtensions(backend);

		class YieldingToolLoop extends ModularAgentLoop {
			protected override async handleToolCalls(): Promise<LoopTurnDecision> {
				return { action: "yield" };
			}
		}

		const loop = new YieldingToolLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.yielded).toBe(true);
		expect(persisted.turns).toHaveLength(1);
		expect(persisted.tools).toHaveLength(0);
	});

	it("runs tool round-trip hooks around default persistence", async () => {
		const backend = new MockBackend([
			[
				{ type: "tool_use_start", id: "call-1", name: "lookup" },
				{ type: "tool_use_end", id: "call-1" },
				done(),
			],
			[{ type: "text", content: "done" }, done()],
		]);
		const { extensions, persisted } = makeExtensions(backend, async () => ({
			content: "hook-result",
			exitCode: 0,
		}));
		const events: string[] = [];

		class HookedToolLoop extends ModularAgentLoop {
			protected override beforeToolRoundTrip(): LoopTurnDecision {
				events.push("before");
				return { action: "continue" };
			}

			protected override async afterToolExecution(
				_parsed: unknown,
				_frame: unknown,
				batch: LoopToolExecutionBatch,
			): Promise<LoopTurnDecision> {
				events.push(`after-exec:${batch.results.length}`);
				return { action: "continue" };
			}

			protected override afterToolPersistence(): LoopTurnDecision {
				events.push("after-persist");
				return { action: "continue" };
			}
		}

		const loop = new HookedToolLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(events).toEqual(["before", "after-exec:1", "after-persist"]);
		expect(persisted.tools).toHaveLength(1);
		expect(persisted.assistant).toHaveLength(1);
	});

	it("records an error turn and alert when unhandled turn execution fails", async () => {
		const backend = new MockBackend([]);
		const { extensions, persisted } = makeExtensions(backend);

		class FailingLoop extends ModularAgentLoop {
			protected override async callModel(): Promise<StreamChunk[]> {
				throw new Error("fatal");
			}
		}

		const loop = new FailingLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBe("fatal");
		expect(persisted.turns).toHaveLength(1);
		expect((persisted.turns[0] as { status?: string }).status).toBe("error");
		expect(persisted.alerts).toEqual(["Loop error: fatal"]);
	});
});

// A backend driven by a per-call script. Each entry is either fixed chunks or a
// thunk (which may throw to simulate a transport fault). Calls past the end of
// the script repeat the last entry, so a single-entry script loops forever.
class ScriptedBackend implements LLMBackend {
	readonly calls: ChatParams[] = [];

	constructor(private readonly script: Array<StreamChunk[] | (() => StreamChunk[])>) {}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		this.calls.push(params);
		const entry = this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
		const chunks = typeof entry === "function" ? entry() : entry;
		for (const chunk of chunks) {
			yield chunk;
		}
	}

	capabilities(): BackendCapabilities {
		return {} as BackendCapabilities;
	}
}

const toolTurn = (id: string, name: string, args: Record<string, unknown>): StreamChunk[] => [
	{ type: "tool_use_start", id, name },
	{ type: "tool_use_args", id, partial_json: JSON.stringify(args) },
	{ type: "tool_use_end", id },
	done(),
];

// A turn that emitted ONLY thinking and then ended. `finishReason` distinguishes
// the two degenerate causes that share the same no-actionable-output symptom:
//   "length"  → model ran out of output budget mid-thinking.
//   "stop"/null → stream dropped (e.g. relay/transport death) after thinking.
// Both must be handled identically: notify the model and retry the SAME budget.
const thinkingOnlyTurn = (finishReason: "length" | "stop" | null = "length"): StreamChunk[] => [
	{ type: "thinking", content: "still reasoning" },
	{
		type: "done",
		...(finishReason ? { finish_reason: finishReason } : {}),
		usage: {
			input_tokens: 10,
			output_tokens: 5,
			cache_read_tokens: null,
			cache_write_tokens: null,
			estimated: false,
		},
	},
];

describe("ModularAgentLoop resilience (base self-sufficiency)", () => {
	it("aborts on consecutive identical tool calls without a host override", async () => {
		// Same call every turn → duplicate-call breaker (threshold 12) trips before
		// the default maxTurns. The base default onLoopGuardTripped surfaces an alert.
		const backend = new ScriptedBackend([toolTurn("call", "lookup", { q: "x" })]);
		const { extensions, persisted } = makeExtensions(backend, async () => ({
			content: "ok",
			exitCode: 0,
		}));

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(backend.calls).toHaveLength(12);
		expect(persisted.alerts).toHaveLength(1);
		expect(persisted.alerts[0]).toContain("identical tool call");
	});

	it("nudges once then aborts on a run of byte-identical tool errors", async () => {
		// Distinct args each turn (so the duplicate breaker never trips) but an
		// identical error result → identical-error breaker. Nudge fires once at 5,
		// hard abort at 12.
		const backend = new ScriptedBackend([
			() => toolTurn(`call-${backend.calls.length}`, "lookup", { n: backend.calls.length }),
		]);
		const { extensions, persisted } = makeExtensions(backend, async () => ({
			content: "boom",
			exitCode: 1,
		}));

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(backend.calls).toHaveLength(12);
		const nudges = persisted.alerts.filter((a) => a.includes("[Loop guard]"));
		const aborts = persisted.alerts.filter((a) => a.includes("identical error"));
		expect(nudges).toHaveLength(1);
		expect(aborts).toHaveLength(1);
	});

	it("notifies and retries with the SAME budget on a length-truncated thinking turn", async () => {
		// CONTRACT CHANGE (notify-and-retry): a thinking-only turn no longer blindly
		// doubles max_tokens (we don't know the provider's real ceiling, so doubling
		// risks a request-time 400). Instead we inject a developer notification and
		// retry the SAME budget, relying on the model to produce a shorter, complete
		// response. Unifies the finishReason="length" and stream-death cases.
		const backend = new ScriptedBackend([
			thinkingOnlyTurn("length"),
			[{ type: "text", content: "answer" }, done()],
		]);
		const { extensions, persisted } = makeExtensions(backend);

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(backend.calls).toHaveLength(2);
		// Budget is unchanged between the original call and the retry — no doubling.
		expect(backend.calls[1].max_tokens).toBe(backend.calls[0].max_tokens);
		expect(persisted.assistant).toHaveLength(1);
	});

	it("notifies and retries a thinking-only turn caused by a dropped stream (finishReason=stop)", async () => {
		// The production bug: a relay/transport stream drops after the model emits
		// only thinking. finishReason is "stop" (or absent), NOT "length", so the
		// old length-gated retry never fired and the loop went silently IDLE.
		const backend = new ScriptedBackend([
			thinkingOnlyTurn("stop"),
			[{ type: "text", content: "answer" }, done()],
		]);
		const { extensions, persisted } = makeExtensions(backend);

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(backend.calls).toHaveLength(2);
		expect(backend.calls[1].max_tokens).toBe(backend.calls[0].max_tokens);
		expect(persisted.assistant).toHaveLength(1);
	});

	it("surfaces an error (never silent ok/IDLE) after exhausting degenerate retries", async () => {
		// A backend that ALWAYS returns thinking-only: the loop must bound its
		// retries and then surface a terminal error rather than spinning forever or
		// completing silently with a non-actionable turn.
		const backend = new ScriptedBackend([thinkingOnlyTurn("stop")]);
		const { extensions, persisted } = makeExtensions(backend);

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		// Bounded: original attempt + DEFAULT_DEGENERATE_RETRY_MAX (2) retries = 3 calls,
		// not maxTurns (16) and not infinite.
		expect(backend.calls.length).toBeLessThanOrEqual(3);
		expect(result.error).toBeDefined();
		// No assistant message persisted from a non-actionable turn.
		expect(persisted.assistant).toHaveLength(0);
		// Only the TERMINAL degenerate turn records as "error"; the intermediate
		// attempts that were retried record as "success", so a thread that
		// recovers never leaves an "error" turn row for introspect / error_count
		// to misread as a hard failure.
		const statuses = (persisted.turns as Array<{ status?: string }>).map((t) => t.status);
		expect(statuses[statuses.length - 1]).toBe("error");
		expect(statuses.slice(0, -1).every((s) => s === "success")).toBe(true);
	});

	it("does NOT retry a content-filter safety stop, even when thinking-only", async () => {
		// A content-filter finish is a deliberate safety termination, not a
		// truncation or dropped stream. Retrying would re-prompt the model past
		// its own safety stop, so isDegenerateTurn must exclude it — the turn is
		// accepted as final (one call, no retry).
		const backend = new ScriptedBackend([
			[
				{ type: "thinking", content: "considering the request" },
				{
					type: "done",
					finish_reason: "content-filter",
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_read_tokens: null,
						cache_write_tokens: null,
						estimated: false,
					},
				},
			],
		]);
		const { extensions } = makeExtensions(backend);

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		// Single call — the safety stop was not retried.
		expect(backend.calls).toHaveLength(1);
	});

	it("retries a transient transport fault and then succeeds", async () => {
		const backend = new ScriptedBackend([
			() => {
				throw new Error("operation timed out");
			},
			[{ type: "text", content: "recovered" }, done()],
		]);
		const { extensions, persisted } = makeExtensions(backend);

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(backend.calls).toHaveLength(2);
		expect(persisted.assistant).toHaveLength(1);
		expect(persisted.alerts).toHaveLength(0);
	});

	it("does not retry a non-transient model error", async () => {
		const backend = new ScriptedBackend([
			() => {
				throw new Error("malformed request");
			},
		]);
		const { extensions, persisted } = makeExtensions(backend);

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBe("malformed request");
		expect(backend.calls).toHaveLength(1);
		expect(persisted.alerts).toEqual(["Loop error: malformed request"]);
	});

	it("completes a 20-turn run of genuinely distinct tool calls without a configured maxTurns", async () => {
		// No maxTurns option is passed below — this exercises whatever default
		// (if any) the base loop applies. Every turn issues a DIFFERENT tool call
		// with different args, so none of the existing circuit breakers
		// (duplicate-call, identical-error, truncated, routing-error) ever have a
		// reason to fire — this is what legitimate, varied multi-step tool use
		// looks like, and it must not be capped by an unrelated turn-count fuse.
		// 20 turns > the old DEFAULT_MAX_TURNS (16), so this only passes once the
		// blanket cap is gone and the loop is bounded purely by the specific
		// circuit breakers above (none of which trip here).
		const totalToolTurns = 20;
		const backend = new ScriptedBackend([
			...Array.from({ length: totalToolTurns }, (_, i) =>
				toolTurn(`call-${i}`, "lookup", { step: i }),
			),
			[{ type: "text", content: "final answer" }, done()],
		]);
		const { extensions, persisted } = makeExtensions(backend, async () => ({
			content: "ok",
			exitCode: 0,
		}));

		const loop = new ModularAgentLoop(extensions, { threadId: "t1", userId: "u1" });
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(backend.calls).toHaveLength(totalToolTurns + 1);
		expect(result.toolCallsMade).toBe(totalToolTurns);
		expect(persisted.assistant).toHaveLength(1);
		expect(persisted.alerts).toHaveLength(0);
	});
});
