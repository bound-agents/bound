import { describe, expect, it } from "bun:test";
import { runYardProgram } from "../driver";
import type { YardHost } from "../driver";

/**
 * Yard driver slice 1: QuickJS runtime lifecycle, guest bootstrap, branded
 * effect constructors, and the yield → dispatch → resume loop against a fake
 * host. No real tool registry or model router — the host seam is the unit
 * boundary (the real wiring is a later slice).
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

describe("runYardProgram — pure programs", () => {
	it("runs a generator that returns a JSON value derived from input", async () => {
		const out = await runYardProgram({
			program: "function* main(input) { return input.a + 1; }",
			input: { a: 41 },
			host: fakeHost(),
		});
		expect(out.result).toBe(42);
		expect(out.usage.tool_calls).toBe(0);
		expect(out.usage.inference_calls).toBe(0);
	});

	it("exposes input deeply frozen", async () => {
		const out = await runYardProgram({
			program: `function* main(input) {
				try { input.nested.x = 99; } catch (e) {}
				return input.nested.x;
			}`,
			input: { nested: { x: 1 } },
			host: fakeHost(),
		});
		expect(out.result).toBe(1);
	});

	it("provides no ambient I/O globals", async () => {
		const out = await runYardProgram({
			program: `function* main() {
				return [
					typeof fetch, typeof process, typeof require,
					typeof setTimeout, typeof Bun, typeof Date.now === "function" ? Date.now() : "no-clock",
				];
			}`,
			host: fakeHost(),
		});
		const [fetchT, processT, requireT, setTimeoutT] = out.result as unknown[];
		expect(fetchT).toBe("undefined");
		expect(processT).toBe("undefined");
		expect(requireT).toBe("undefined");
		expect(setTimeoutT).toBe("undefined");
	});

	it("rejects a program without a main generator", async () => {
		await expect(runYardProgram({ program: "const x = 1;", host: fakeHost() })).rejects.toThrow(
			/main/,
		);
	});

	it("surfaces guest syntax errors", async () => {
		await expect(
			runYardProgram({ program: "function* main( {", host: fakeHost() }),
		).rejects.toThrow();
	});
});

describe("runYardProgram — tool effects", () => {
	it("dispatches a yielded tool effect and resumes with its result", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const host = fakeHost({
			dispatchTool: async (name, args) => {
				calls.push({ name, args });
				return { hits: ["a", "b"] };
			},
		});
		const out = await runYardProgram({
			program: `function* main(input) {
				const res = yield tool("bms_search", { pattern: input.pattern });
				return res.hits.length;
			}`,
			input: { pattern: "dispatch" },
			host,
		});
		expect(out.result).toBe(2);
		expect(calls).toEqual([{ name: "bms_search", args: { pattern: "dispatch" } }]);
		expect(out.usage.tool_calls).toBe(1);
	});

	it("rejects a plain effect-shaped object yielded without the brand", async () => {
		await expect(
			runYardProgram({
				program: `function* main() {
					return yield { kind: "tool", name: "bms_search", args: {} };
				}`,
				host: fakeHost(),
			}),
		).rejects.toThrow(/effect/i);
	});

	it("throws a dispatch failure into the generator as a catchable error", async () => {
		const host = fakeHost({
			dispatchTool: async () => {
				throw new Error("tool exploded");
			},
		});
		const out = await runYardProgram({
			program: `function* main() {
				try {
					yield tool("bms_search", {});
					return "unreachable";
				} catch (e) {
					return "caught: " + e.message;
				}
			}`,
			host,
		});
		expect(out.result).toBe("caught: tool exploded");
	});
});

describe("runYardProgram — inference effects", () => {
	it("dispatches infer() with the explicit model id", async () => {
		const seen: Array<{ model: string; request: unknown }> = [];
		const host = fakeHost({
			dispatchInference: async (model, request) => {
				seen.push({ model, request });
				return "classified";
			},
		});
		const out = await runYardProgram({
			program: `function* main() {
				return yield infer("gpt-5.6-sol", { prompt: "Classify.", input: { x: 1 } });
			}`,
			host,
		});
		expect(out.result).toBe("classified");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.model).toBe("gpt-5.6-sol");
		expect(out.usage.inference_calls).toBe(1);
	});

	it("requires a model id string", async () => {
		await expect(
			runYardProgram({
				program: `function* main() { return yield infer(undefined, { prompt: "p" }); }`,
				host: fakeHost(),
			}),
		).rejects.toThrow();
	});
});

describe("runYardProgram — compound effects", () => {
	it("all() runs children and preserves input order", async () => {
		const host = fakeHost({
			dispatchTool: async (_name, args) => {
				const n = (args as { n: number }).n;
				// Later children resolve sooner to prove order preservation.
				await new Promise((r) => setTimeout(r, 20 - n * 5));
				return n * 10;
			},
		});
		const out = await runYardProgram({
			program: `function* main() {
				return yield all([1, 2, 3].map(n => tool("t", { n })));
			}`,
			host,
		});
		expect(out.result).toEqual([10, 20, 30]);
		expect(out.usage.tool_calls).toBe(3);
	});

	it("all() fail-fast throws the first failure into the generator", async () => {
		const host = fakeHost({
			dispatchTool: async (_name, args) => {
				if ((args as { n: number }).n === 2) throw new Error("child failed");
				return "ok";
			},
		});
		const out = await runYardProgram({
			program: `function* main() {
				try {
					yield all([1, 2].map(n => tool("t", { n })));
					return "unreachable";
				} catch (e) {
					return e.message;
				}
			}`,
			host,
		});
		expect(out.result).toBe("child failed");
	});

	it('all() with errors: "settled" returns input-ordered status entries', async () => {
		const host = fakeHost({
			dispatchTool: async (_name, args) => {
				if ((args as { n: number }).n === 2) throw new Error("boom");
				return (args as { n: number }).n;
			},
		});
		const out = await runYardProgram({
			program: `function* main() {
				return yield all([1, 2, 3].map(n => tool("t", { n })), { errors: "settled" });
			}`,
			host,
		});
		expect(out.result).toEqual([
			{ status: "fulfilled", value: 1 },
			{ status: "rejected", reason: "boom" },
			{ status: "fulfilled", value: 3 },
		]);
	});

	it("sequence() runs children in order, fail-fast", async () => {
		const order: number[] = [];
		const host = fakeHost({
			dispatchTool: async (_name, args) => {
				order.push((args as { n: number }).n);
				return (args as { n: number }).n;
			},
		});
		const out = await runYardProgram({
			program: `function* main() {
				return yield sequence([tool("t", { n: 1 }), tool("t", { n: 2 })]);
			}`,
			host,
		});
		expect(out.result).toEqual([1, 2]);
		expect(order).toEqual([1, 2]);
	});

	it("all() rejects unbranded children", async () => {
		await expect(
			runYardProgram({
				program: `function* main() {
					return yield all([{ kind: "tool", name: "t", args: {} }]);
				}`,
				host: fakeHost(),
			}),
		).rejects.toThrow(/effect/i);
	});
});

describe("runYardProgram — aux sugar", () => {
	it("aux() constructs a tool effect targeting the aux tool", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const host = fakeHost({
			dispatchTool: async (name, args) => {
				calls.push({ name, args });
				return "review done";
			},
		});
		const out = await runYardProgram({
			program: `function* main() {
				return yield aux("skeptic", "review this", { model: "opus" });
			}`,
			host,
		});
		expect(out.result).toBe("review done");
		expect(calls).toEqual([
			{
				name: "aux",
				args: { action: "invoke", name: "skeptic", instructions: "review this", model: "opus" },
			},
		]);
	});
});

describe("runYardProgram — limits", () => {
	it("interrupts a runaway loop via the CPU deadline", async () => {
		await expect(
			runYardProgram({
				program: "function* main() { while (true) {} }",
				host: fakeHost(),
				limits: { cpuSliceMs: 100 },
			}),
		).rejects.toThrow(/interrupt|timeout/i);
	});

	it("rejects a non-JSON-compatible return value", async () => {
		await expect(
			runYardProgram({
				program: "function* main() { return () => 1; }",
				host: fakeHost(),
			}),
		).rejects.toThrow(/JSON/i);
	});
});
