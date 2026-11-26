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
		// Examples lead with successful production patterns: concurrent specialist
		// review and compact synthesis from parallel effect output.
		expect(description).toContain("concurrent specialist reviews");
		expect(description).toContain('aux("pricing-skeptic"');
		expect(description).toContain('aux("yard-ui-scout"');
		expect(description).toMatch(/synthesize a compact decision artifact/i);
		expect(description).not.toContain('tool("bms_read"');
	});

	it("normalizes a JSON-string input into a value for the guest", async () => {
		// Models routinely emit nested object params as JSON *text* rather than a
		// nested object (same class as the tavily list-arg serialization). The
		// schema is z.any(), so a string passes validation, then the driver
		// JSON.stringify()s it and the guest JSON.parse()s it straight back to a
		// string — faithfully round-tripping the wrong thing. Observed live: the
		// guest saw typeof input === "string" with Object.keys() returning
		// character indices, so input.field was undefined.
		const raw = await invoke({
			program:
				"function* main(input) { return { t: typeof input, alpha: input.alpha, deep: input.nested.deep }; }",
			input: '{"alpha": 1, "nested": {"deep": true}}',
		});
		const parsed = JSON.parse(raw) as { result: { t: string; alpha: number; deep: boolean } };
		expect(parsed.result.t).toBe("object");
		expect(parsed.result.alpha).toBe(1);
		expect(parsed.result.deep).toBe(true);
	});

	it("passes a genuine object input through unchanged", async () => {
		const raw = await invoke({
			program: "function* main(input) { return { t: typeof input, alpha: input.alpha }; }",
			input: { alpha: 7 },
		});
		const parsed = JSON.parse(raw) as { result: { t: string; alpha: number } };
		expect(parsed.result.t).toBe("object");
		expect(parsed.result.alpha).toBe(7);
	});

	it("keeps a non-JSON string input as a string", async () => {
		// Only strings that parse to an object/array are treated as marshalling
		// artifacts. A plain scalar string is a legitimate input value.
		const raw = await invoke({
			program: "function* main(input) { return { t: typeof input, v: input }; }",
			input: "hello",
		});
		const parsed = JSON.parse(raw) as { result: { t: string; v: string } };
		expect(parsed.result.t).toBe("string");
		expect(parsed.result.v).toBe("hello");
	});

	it("keeps a numeric-looking string input as a string", async () => {
		const raw = await invoke({
			program: "function* main(input) { return { t: typeof input, v: input }; }",
			input: "42",
		});
		const parsed = JSON.parse(raw) as { result: { t: string; v: string } };
		expect(parsed.result.t).toBe("string");
		expect(parsed.result.v).toBe("42");
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

	it("fails the infer() effect once schema repair attempts are exhausted, with a raw excerpt", async () => {
		const prompts: string[] = [];
		ctx.modelRouter = makeRouter(
			{
				"test-model": textBackend((params) => {
					prompts.push(String(params.messages[0]?.content));
					return '{"confidence": 0.9}';
				}),
			},
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
		const out = JSON.parse(raw);
		// Default schema_retries is 1: the original attempt plus one re-ask.
		expect(prompts).toHaveLength(2);
		expect(out.result).toMatch(/caught:.*violates the requested schema/i);
		expect(out.result).toMatch(/after 2 attempts/);
		expect(out.result).toContain('{\\"confidence\\": 0.9}');
		// Both attempts' tokens are counted (15 per textBackend reply).
		expect(out.usage.inference_tokens).toBe(30);
		expect(out.usage.inference_calls).toBe(1);
	});

	it("re-asks once with the validation error and raw excerpt, then returns the repaired JSON", async () => {
		const prompts: string[] = [];
		ctx.modelRouter = makeRouter(
			{
				"test-model": textBackend((params) => {
					prompts.push(String(params.messages[0]?.content));
					return prompts.length === 1 ? "Sure! Here is the label: bug" : '{"label": "bug"}';
				}),
			},
			"test-model",
		);
		const raw = await invoke({
			program: `function* main() {
				return yield infer("test-model", {
					prompt: "Classify the issue.",
					schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
				});
			}`,
		});
		const out = JSON.parse(raw);
		expect(out.result).toEqual({ label: "bug" });
		expect(prompts).toHaveLength(2);
		const reask = prompts[1] ?? "";
		// The re-ask re-sends the original request...
		expect(reask).toContain("Classify the issue.");
		expect(reask).toContain("JSON Schema");
		// ...plus why the previous reply failed and what it said.
		expect(reask).toContain("Your previous reply failed:");
		expect(reask).toContain("not valid JSON");
		expect(reask).toContain("Sure! Here is the label: bug");
		expect(reask).toMatch(/reply with ONLY a JSON value/i);
		expect(out.usage.inference_tokens).toBe(30);
	});

	it("passes the validator's violations into the re-ask", async () => {
		const prompts: string[] = [];
		ctx.modelRouter = makeRouter(
			{
				"test-model": textBackend((params) => {
					prompts.push(String(params.messages[0]?.content));
					return prompts.length === 1 ? '{"confidence": 0.9}' : '{"label": "bug"}';
				}),
			},
			"test-model",
		);
		const raw = await invoke({
			program: `function* main() {
				return yield infer("test-model", {
					prompt: "Classify.",
					schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
				});
			}`,
		});
		expect(JSON.parse(raw).result).toEqual({ label: "bug" });
		expect(prompts[1]).toContain("violates the requested schema");
		expect(prompts[1]).toContain("label");
	});

	it("makes a single attempt when schema_retries is 0", async () => {
		let calls = 0;
		ctx.modelRouter = makeRouter(
			{
				"test-model": textBackend(() => {
					calls++;
					return "not json";
				}),
			},
			"test-model",
		);
		const raw = await invoke({
			program: `function* main() {
				try {
					yield infer("test-model", { prompt: "p", schema: { type: "object" }, schema_retries: 0 });
					return "unreachable";
				} catch (e) {
					return "caught: " + e.message;
				}
			}`,
		});
		const out = JSON.parse(raw);
		expect(calls).toBe(1);
		expect(out.result).toMatch(/caught:.*not valid JSON.*after 1 attempt\b/);
		expect(out.result).toContain("not json");
	});

	it("honors schema_retries: 2 and ignores it without a schema", async () => {
		let calls = 0;
		ctx.modelRouter = makeRouter(
			{
				"test-model": textBackend(() => {
					calls++;
					return "not json";
				}),
			},
			"test-model",
		);
		const raw = await invoke({
			program: `function* main() {
				const text = yield infer("test-model", { prompt: "p", schema_retries: 2 });
				try {
					yield infer("test-model", { prompt: "p", schema: { type: "object" }, schema_retries: 2 });
				} catch (e) {
					return text + " | " + e.message;
				}
			}`,
		});
		expect(calls).toBe(4);
		expect(JSON.parse(raw).result).toMatch(/^not json \| .*after 3 attempts/);
	});

	it("rejects an out-of-range schema_retries at construction", async () => {
		const raw = await invoke({
			program: `function* main() {
				const errors = [];
				for (const n of [3, -1, 1.5, "1"]) {
					try { infer("test-model", { prompt: "p", schema: {}, schema_retries: n }); errors.push("ok"); }
					catch (e) { errors.push(e.message); }
				}
				return errors;
			}`,
		});
		const result = JSON.parse(raw).result as string[];
		expect(result).toHaveLength(4);
		for (const message of result)
			expect(message).toMatch(/schema_retries must be an integer from 0 to 2/);
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

	describe("fatal aux dispatch rejection (#316)", () => {
		const REASON =
			"client session unavailable for aux dispatch: parent thread p is attached to a client session, but no live session can serve this errand's client tools";
		let rejectingCalls: number;

		beforeEach(() => {
			rejectingCalls = 0;
			registry.set("rejecting", {
				kind: "builtin",
				toolDefinition: {
					type: "function",
					function: { name: "rejecting", description: "x", parameters: {} },
				},
				execute: async () => {
					rejectingCalls++;
					// The message text is deliberately unrelated: Yard must key on
					// the typed metadata, never on the content string.
					return {
						content: "Error: auxiliary agent 'impl' was not started",
						metadata: { aux_dispatch_rejected: true, aux_dispatch_reason: REASON },
					};
				},
			});
		});

		it("fails the run, skips the guest catch, and aborts in-flight siblings", async () => {
			let seenSignal: AbortSignal | undefined;
			ctx.executeClientTool = async (_name, _args, _timeout, signal) => {
				seenSignal = signal;
				await new Promise<void>((resolve) => {
					if (signal?.aborted) return resolve();
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return null;
			};
			registry.set("slow_client", {
				kind: "client",
				toolDefinition: {
					type: "function",
					function: { name: "slow_client", description: "x", parameters: {} },
				},
			});
			const started = Date.now();
			const raw = await invoke({
				program: `function* main() {
					const caught = [];
					for (let round = 0; round < 3; round++) {
						try {
							yield all([tool("slow_client", {}), tool("rejecting", {})], { errors: "settled" });
						} catch (e) {
							caught.push(e.message);
						}
					}
					return caught;
				}`,
				budget: { timeout_seconds: 20, concurrency: 2 },
			});
			expect(raw).toBe(`Error: ${REASON}`);
			expect(rejectingCalls).toBe(1);
			expect(seenSignal?.aborted).toBe(true);
			expect((seenSignal?.reason as Error).message).toBe(REASON);
			expect(Date.now() - started).toBeLessThan(10_000);
		});

		it("ends the parent run when a nested yard hits the rejection", async () => {
			const raw = await invoke({
				program: `function* main() {
					const caught = [];
					for (let round = 0; round < 3; round++) {
						try {
							yield tool("yard", { program: 'function* main() { try { return yield tool("rejecting", {}); } catch (e) { return "inner caught"; } }' });
						} catch (e) {
							caught.push(e.message);
						}
					}
					return caught;
				}`,
			});
			expect(raw).toBe(`Error: ${REASON}`);
			expect(rejectingCalls).toBe(1);
		});

		it("keeps an ordinary Error: tool result catchable", async () => {
			registry.set("failing", {
				kind: "builtin",
				toolDefinition: {
					type: "function",
					function: { name: "failing", description: "x", parameters: {} },
				},
				execute: async () => ({
					content: "Auxiliary agent 'impl' completed with error: tests failed",
					metadata: { aux_thread: "t" },
				}),
			});
			registry.set("erroring", {
				kind: "builtin",
				toolDefinition: {
					type: "function",
					function: { name: "erroring", description: "x", parameters: {} },
				},
				execute: async () => "Error: file not found",
			});
			const raw = await invoke({
				program: `function* main() {
					const report = yield tool("failing", {});
					try { yield tool("erroring", {}); return "unreachable"; }
					catch (e) { return [report, e.message]; }
				}`,
			});
			expect(JSON.parse(raw).result).toEqual([
				"Auxiliary agent 'impl' completed with error: tests failed",
				"Error: file not found",
			]);
		});
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
