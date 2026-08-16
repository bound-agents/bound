import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { RegisteredTool, ToolContext } from "../../types.js";
import { createYardTool } from "../yard.js";

/**
 * Yard native tool (slice 2): registry-backed tool dispatch, local model
 * inference through resolveModel, budget limits, and nested-call inheritance.
 * The QuickJS driver itself is covered by yard/__tests__/driver.test.ts; these
 * tests pin the wiring — the YardHost implementation over ToolContext.
 */

function textBackend(reply: string | ((params: ChatParams) => string)): LLMBackend {
	return {
		async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
			const text = typeof reply === "function" ? reply(params) : reply;
			yield { type: "text", content: text };
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

function makeRouter(backends: Record<string, LLMBackend>, defaultId: string): ModelRouter {
	return new ModelRouter(new Map(Object.entries(backends)), defaultId);
}

describe("createYardTool", () => {
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
			modelRouter: makeRouter({ "test-model": textBackend("classified") }, "test-model"),
			getToolRegistry: () => registry,
		};
	});

	function invoke(input: Record<string, unknown>) {
		const tool = createYardTool(ctx);
		registry.set("yard", tool);
		if (!tool.execute) throw new Error("yard tool has no execute");
		return tool.execute(input) as Promise<string>;
	}

	it("registers as a builtin named yard with a description carrying the guest reference", () => {
		const tool = createYardTool(ctx);
		expect(tool.kind).toBe("builtin");
		expect(tool.toolDefinition.function.name).toBe("yard");
		const description = tool.toolDefinition.function.description;
		// The shipped description must teach the full guest syntax (design
		// plan: complete reference, not a summary).
		for (const marker of ["function* main", "tool(", "infer(", "aux(", "all(", "sequence("]) {
			expect(description).toContain(marker);
		}
		// The no-backgrounding rule must be taught up front: a guest that
		// passes background: true gets a runtime rejection (deferred results
		// have no resolution path inside a yard run), so the description has
		// to steer programs to all() for concurrency instead.
		expect(description).toContain("background");
		expect(description).toMatch(/background:\s*true.*(reject|fail|not)/i);
	});

	it("runs a pure program and returns result + usage + trace_id", async () => {
		const raw = await invoke({
			program: "function* main(input) { return input.n * 2; }",
			input: { n: 21 },
		});
		const out = JSON.parse(raw);
		expect(out.result).toBe(42);
		expect(typeof out.trace_id).toBe("string");
		expect(out.usage.tool_calls).toBe(0);
		expect(out.usage.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	it("dispatches yielded tool effects through the registry", async () => {
		const seen: unknown[] = [];
		registry.set("fake_search", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "fake_search", description: "x", parameters: {} },
			},
			execute: async (input) => {
				seen.push(input);
				return JSON.stringify(["a", "b", "c"]);
			},
		});
		const raw = await invoke({
			program: `function* main() {
				const hits = yield tool("fake_search", { pattern: "x" });
				return hits.length;
			}`,
		});
		expect(JSON.parse(raw).result).toBe(3);
		expect(seen).toEqual([{ pattern: "x" }]);
	});

	it("dispatches sandbox-kind tools through the ordinary sandbox runner", async () => {
		const seen: Array<{ command: string; timeout?: number; cwd?: string }> = [];
		ctx.executeSandboxTool = async (command, timeout, cwd) => {
			seen.push({ command, timeout, cwd });
			return { stdout: '["a","b"]', stderr: "", exitCode: 0 };
		};
		registry.set("bms_bash", {
			kind: "sandbox",
			toolDefinition: {
				type: "function",
				function: { name: "bms_bash", description: "x", parameters: {} },
			},
		});
		const raw = await invoke({
			program: `function* main() {
				const hits = yield tool("bms_bash", { command: "search", timeout: 1000, cwd: "/x" });
				return hits.length;
			}`,
		});
		expect(JSON.parse(raw).result).toBe(2);
		expect(seen).toEqual([{ command: "search", timeout: 1000, cwd: "/x" }]);
	});

	it("returns non-JSON tool output to the guest as a string", async () => {
		registry.set("plain", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "plain", description: "x", parameters: {} },
			},
			execute: async () => "just some text",
		});
		const raw = await invoke({
			program: `function* main() { return yield tool("plain", {}); }`,
		});
		expect(JSON.parse(raw).result).toBe("just some text");
	});

	it("rejects a tool effect naming a tool absent from the registry", async () => {
		const raw = await invoke({
			program: `function* main() {
				try {
					yield tool("no_such_tool", {});
					return "unreachable";
				} catch (e) {
					return "caught: " + e.message;
				}
			}`,
		});
		expect(JSON.parse(raw).result).toMatch(/caught:.*no_such_tool/);
	});

	it("dispatches client-kind tools through the awaitable client runner", async () => {
		const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
		ctx.executeClientTool = async (name, args) => {
			seen.push({ name, args });
			return { content: '{"path":"README.md","lines":2}', isError: false };
		};
		registry.set("boundless_read", {
			kind: "client",
			toolDefinition: {
				type: "function",
				function: { name: "boundless_read", description: "x", parameters: {} },
			},
		});
		const raw = await invoke({
			program: `function* main() {
				return yield tool("boundless_read", { file_path: "README.md" });
			}`,
		});
		expect(JSON.parse(raw).result).toEqual({ path: "README.md", lines: 2 });
		expect(seen).toEqual([{ name: "boundless_read", args: { file_path: "README.md" } }]);
	});

	it("throws client-tool errors into the guest generator", async () => {
		ctx.executeClientTool = async () => ({ content: "Error: denied", isError: true });
		registry.set("boundless_read", {
			kind: "client",
			toolDefinition: {
				type: "function",
				function: { name: "boundless_read", description: "x", parameters: {} },
			},
		});
		const raw = await invoke({
			program: `function* main() {
				try { yield tool("boundless_read", {}); return "unreachable"; }
				catch (e) { return e.message; }
			}`,
		});
		expect(JSON.parse(raw).result).toContain("denied");
	});

	it("dispatches infer() through the model router and counts usage", async () => {
		const raw = await invoke({
			program: `function* main() {
				return yield infer("test-model", { prompt: "Classify." });
			}`,
		});
		const out = JSON.parse(raw);
		expect(out.result).toBe("classified");
		expect(out.usage.inference_calls).toBe(1);
		expect(out.usage.inference_tokens).toBeGreaterThan(0);
	});

	it("returns schema-validated JSON from infer() with a schema", async () => {
		ctx.modelRouter = makeRouter(
			{ "test-model": textBackend('{"label": "bug", "confidence": 0.9}') },
			"test-model",
		);
		const raw = await invoke({
			program: `function* main() {
				return yield infer("test-model", {
					prompt: "Classify.",
					schema: {
						type: "object",
						properties: { label: { type: "string" }, confidence: { type: "number" } },
						required: ["label"],
					},
				});
			}`,
		});
		expect(JSON.parse(raw).result).toEqual({ label: "bug", confidence: 0.9 });
	});

	it("fails the infer() effect when output violates the schema (no hidden repair)", async () => {
		ctx.modelRouter = makeRouter(
			{ "test-model": textBackend('{"confidence": 0.9}') },
			"test-model",
		);
		const raw = await invoke({
			program: `function* main() {
				try {
					yield infer("test-model", {
						prompt: "Classify.",
						schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
					});
					return "unreachable";
				} catch (e) {
					return "caught: " + e.message;
				}
			}`,
		});
		expect(JSON.parse(raw).result).toMatch(/caught:.*schema/i);
	});

	it("fails an infer() naming an unknown model", async () => {
		const raw = await invoke({
			program: `function* main() {
				try {
					yield infer("no-such-model", { prompt: "p" });
					return "unreachable";
				} catch (e) {
					return "caught: " + e.message;
				}
			}`,
		});
		expect(JSON.parse(raw).result).toMatch(/caught:/);
	});

	it("errors when no tool registry is wired", async () => {
		ctx.getToolRegistry = undefined;
		const tool = createYardTool(ctx);
		if (!tool.execute) throw new Error("no execute");
		const raw = (await tool.execute({
			program: "function* main() { return 1; }",
		})) as string;
		expect(raw).toMatch(/^Error:/);
	});

	it("enforces the budget timeout across the run", async () => {
		registry.set("slow", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "slow", description: "x", parameters: {} },
			},
			execute: async () => {
				await new Promise((r) => setTimeout(r, 5_000));
				return "late";
			},
		});
		const start = Date.now();
		const raw = await invoke({
			program: `function* main() { return yield tool("slow", {}); }`,
			budget: { timeout_seconds: 1, concurrency: 2 },
		});
		expect(Date.now() - start).toBeLessThan(4_000);
		expect(raw).toMatch(/Error:.*(deadline|timeout|timed out)/i);
	});

	it("caps nested yard depth", async () => {
		// A program that recurses into yard forever must be cut off by the
		// structural depth ceiling, not the wall clock.
		const program = `function* main(input) {
			return yield tool("yard", { program: input.self, input: { self: input.self } });
		}`;
		const raw = await invoke({
			program,
			input: { self: program },
			budget: { timeout_seconds: 30, concurrency: 2 },
		});
		// Depth failure surfaces as an Error: string (exit-code convention),
		// not a successful JSON payload.
		expect(raw).toMatch(/^Error:/);
		expect(raw).toMatch(/depth/i);
	});

	it("runs a nested yard call and copies the child result to the parent", async () => {
		const raw = await invoke({
			program: `function* main() {
				const child = yield tool("yard", {
					program: "function* main(input) { return input.a + 1; }",
					input: { a: 1 },
				});
				return child.result + 40;
			}`,
		});
		expect(JSON.parse(raw).result).toBe(42);
	});

	it("rejects invalid input (missing program)", async () => {
		const raw = await invoke({ input: { a: 1 } });
		expect(raw).toMatch(/^Error:/);
	});

	it("surfaces guest failures as an Error: result (exit-code convention)", async () => {
		const raw = await invoke({ program: "function* main() { throw new Error('boom'); }" });
		expect(raw).toMatch(/^Error:/);
		expect(raw).toContain("boom");
	});
});

describe("yard tool description examples — conformance", () => {
	// The design plan requires every documented example to run against the
	// real evaluator so the description can't drift from the runtime.
	it("executes the documented tool + parallel-inference example shape", async () => {
		const { runYardProgram } = await import("../../yard/driver.js");
		const out = await runYardProgram({
			program: `function* main(input) {
				const hits = yield tool("bms_search", { pattern: input.pattern, path: input.path });
				const findings = yield all(
					hits.map(hit => infer(input.model, { prompt: "Classify this match.", input: hit, schema: input.schema })),
					{ concurrency: 8 },
				);
				return findings.filter(x => x.confidence >= 0.75);
			}`,
			input: {
				pattern: "p",
				path: "/x",
				model: "m",
				schema: { type: "object" },
			},
			host: {
				dispatchTool: async () => [{ id: 1 }, { id: 2 }],
				dispatchInference: async (_model, request) => ({
					confidence: (request.input as { id: number }).id === 1 ? 0.9 : 0.1,
				}),
			},
		});
		expect(out.result).toEqual([{ confidence: 0.9 }]);
	});

	it("executes the documented aux + write example shape", async () => {
		const { runYardProgram } = await import("../../yard/driver.js");
		const calls: Array<{ name: string; args: unknown }> = [];
		const out = await runYardProgram({
			program: `function* main(input) {
				const review = yield aux("skeptic", input.instructions, { model: input.model });
				yield tool("bms_write", { path: input.output_path, content: review });
				return { path: input.output_path, review };
			}`,
			input: { instructions: "review", model: "m", output_path: "/tmp/r.md" },
			host: {
				dispatchTool: async (name, args) => {
					calls.push({ name, args });
					return name === "aux" ? "looks fine" : "ok";
				},
				dispatchInference: async () => "unused",
			},
		});
		expect(out.result).toEqual({ path: "/tmp/r.md", review: "looks fine" });
		expect(calls.map((c) => c.name)).toEqual(["aux", "bms_write"]);
	});
});
