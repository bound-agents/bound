import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { RegisteredTool, ToolContext } from "../../types.js";
import type { YardHost } from "../../yard/driver.js";
import { runYardProgram } from "../../yard/driver.js";
import { createYardTool } from "../yard.js";

/**
 * Nested-aux fail-fast (incident: thread 5411b76f / aux 5076d967).
 *
 * An aux agent's toolset structurally excludes `aux` (EXCLUDED_TOOLS in
 * agent-factory: nested fan-out would deadlock the shared ConcurrentCap and
 * escalate past the capability boundary). A Yard running inside an aux used
 * to discover that only at dispatch, with the generic "not available in the
 * current toolset" error — after the program had already been written around
 * aux() — and then degrade into a serial tool() grind. The contract pinned
 * here: fail at the EARLIEST point in the graph with a message that steers
 * the model to return findings for the main agent to orchestrate.
 *
 * Three layers, earliest first:
 *  1. construction — the guest aux() constructor throws immediately when the
 *     host marks aux unavailable, before anything dispatches;
 *  2. dispatch — tool("aux", ...) bypasses the sugar, so the host-side guard
 *     throws the same steering error (the driver never trusts guest memory);
 *  3. description — the yard description an aux sees carries the warning up
 *     front, so the doomed program is never written.
 */

function fakeHost(overrides: Partial<YardHost> = {}): YardHost {
	return {
		dispatchTool: async () => {
			throw new Error("dispatchTool not stubbed");
		},
		dispatchInference: async () => {
			throw new Error("dispatchInference not stubbed");
		},
		...overrides,
	};
}

describe("runYardProgram — aux unavailable (construction-time fail-fast)", () => {
	it("aux() throws the host's reason at construction, before any dispatch", async () => {
		const dispatched: string[] = [];
		await expect(
			runYardProgram({
				program: `function* main() {
					return yield aux("skeptic", "review this");
				}`,
				host: fakeHost({
					dispatchTool: async (name) => {
						dispatched.push(name);
						return "ok";
					},
				}),
				auxUnavailableReason: "aux() is not available inside an auxiliary agent",
			}),
		).rejects.toThrow(/not available inside an auxiliary agent/);
		expect(dispatched).toEqual([]);
	});

	it("fails the whole graph at the first aux() inside all(), before siblings dispatch", async () => {
		const dispatched: string[] = [];
		await expect(
			runYardProgram({
				program: `function* main() {
					return yield all([
						tool("bms_search", { pattern: "x" }),
						aux("scout", "survey"),
					]);
				}`,
				host: fakeHost({
					dispatchTool: async (name) => {
						dispatched.push(name);
						return "ok";
					},
				}),
				auxUnavailableReason: "aux() is not available inside an auxiliary agent",
			}),
		).rejects.toThrow(/not available inside an auxiliary agent/);
		// all() children construct eagerly at the call site — the aux() throw
		// fires before the yield, so not even the sibling tool() dispatches.
		expect(dispatched).toEqual([]);
	});

	it("leaves aux() working when the host does not restrict it", async () => {
		const dispatched: string[] = [];
		const out = await runYardProgram({
			program: `function* main() {
				return yield aux("skeptic", "review this");
			}`,
			host: fakeHost({
				dispatchTool: async (name) => {
					dispatched.push(name);
					return "review done";
				},
			}),
		});
		expect(out.result).toBe("review done");
		expect(dispatched).toEqual(["aux"]);
	});
});

function textBackend(reply: string): LLMBackend {
	return {
		async *chat(_params: ChatParams): AsyncIterable<StreamChunk> {
			yield { type: "text", content: reply };
			yield {
				type: "done",
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		},
		capabilities(): BackendCapabilities {
			return {
				streaming: true,
				tool_use: false,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				extended_thinking: false,
				max_context: 100_000,
			};
		},
	};
}

describe("createYardTool — inside an aux toolset (ctx.agentId set)", () => {
	let db: Database;
	let ctx: ToolContext;
	let registry: Map<string, RegisteredTool>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.exec("INSERT INTO host_meta (key, value) VALUES ('site_id', 'test-site')");
		registry = new Map();
		ctx = {
			db,
			siteId: "test-site",
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			modelRouter: new ModelRouter(new Map([["test-model", textBackend("ok")]]), "test-model"),
			getToolRegistry: () => registry,
			agentId: "aux-identity-1",
		};
	});

	function invoke(input: Record<string, unknown>) {
		const tool = createYardTool(ctx);
		registry.set("yard", tool);
		if (!tool.execute) throw new Error("yard tool has no execute");
		return tool.execute(input) as Promise<string>;
	}

	it("carries the aux-unavailable notice up front in the description", () => {
		const description = createYardTool(ctx).toolDefinition.function.description ?? "";
		expect(description).toMatch(/aux\(\).*not available/i);
		// The steering must name the alternative, not just the prohibition.
		expect(description).toMatch(/main agent/i);
	});

	it("fails a program at the aux() call site with the steering message", async () => {
		const raw = await invoke({
			program: `function* main() {
				return yield aux("scout", "survey the repo");
			}`,
		});
		expect(raw).toMatch(/^Error:/);
		expect(raw).toMatch(/not available inside an auxiliary agent/);
		expect(raw).toMatch(/main agent/i);
	});

	it('guards the raw tool("aux", ...) bypass at dispatch with the same steering', async () => {
		// A guest can skip the aux() sugar entirely; the host-side dispatch
		// guard must not trust guest construction.
		registry.set("aux", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "aux", description: "x", parameters: {} },
			},
			execute: async () => "must never run",
		});
		const raw = await invoke({
			program: `function* main() {
				try {
					return yield tool("aux", { action: "invoke", name: "scout", instructions: "go" });
				} catch (e) {
					return "caught: " + e.message;
				}
			}`,
		});
		expect(JSON.parse(raw).result).toMatch(/caught:.*not available inside an auxiliary agent/);
	});
});

describe("createYardTool — main-agent toolset (no agentId)", () => {
	it("does not carry the aux-unavailable notice", () => {
		const db = new Database(":memory:");
		applySchema(db);
		db.exec("INSERT INTO host_meta (key, value) VALUES ('site_id', 'test-site')");
		const ctx: ToolContext = {
			db,
			siteId: "test-site",
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			modelRouter: new ModelRouter(new Map([["test-model", textBackend("ok")]]), "test-model"),
			getToolRegistry: () => new Map(),
		};
		const description = createYardTool(ctx).toolDefinition.function.description ?? "";
		expect(description).not.toMatch(/not available inside an auxiliary agent/i);
	});
});
