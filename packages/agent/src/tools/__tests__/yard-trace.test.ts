import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { RegisteredTool, ToolContext } from "../../types.js";
import { createYardTool } from "../yard.js";

/**
 * Yard execution-tree trace (design plan, "Trace"): one structured tree per
 * root invocation — run IDs, parent-child depth, program/input hashes,
 * per-effect timing/status, explicit inference model IDs, child Yard links,
 * and completion status. Emitted as OTEL spans through the same global tracer
 * provider the loop uses, so a configured exporter sees Yard trees alongside
 * loop.turn / tool.execute spans.
 */

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeAll(() => {
	exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider();
	provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
	trace.setGlobalTracerProvider(provider);
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterAll(async () => {
	await provider.shutdown();
	trace.disable();
	context.disable();
});

describe("yard execution-tree trace", () => {
	let db: Database;
	let ctx: ToolContext;
	let registry: Map<string, RegisteredTool>;

	beforeEach(() => {
		exporter.reset();
		db = new Database(":memory:");
		applySchema(db);
		db.exec("INSERT INTO host_meta (key, value) VALUES ('site_id', 'test-site')");
		registry = new Map();
		ctx = {
			db,
			siteId: "test-site",
			eventBus: { emit: () => {} } as never,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			getToolRegistry: () => registry,
		};
	});

	function invoke(input: Record<string, unknown>) {
		const tool = createYardTool(ctx);
		registry.set("yard", tool);
		if (!tool.execute) throw new Error("yard tool has no execute");
		return tool.execute(input) as Promise<string>;
	}

	it("emits one yard.run span with run id, depth, hashes, and usage", async () => {
		const raw = await invoke({
			program: "function* main(input) { return input.n + 1; }",
			input: { n: 1 },
		});
		const out = JSON.parse(raw);

		const spans = exporter.getFinishedSpans();
		const runSpans = spans.filter((s) => s.name === "yard.run");
		expect(runSpans).toHaveLength(1);
		const run = runSpans[0];
		if (!run) throw new Error("no run span");
		// The span's run id IS the trace_id returned to the caller.
		expect(run.attributes["yard.trace_id"]).toBe(out.trace_id);
		expect(run.attributes["yard.depth"]).toBe(0);
		// Program and input identified by hash, not by content (a program can
		// be arbitrarily large; the trace must stay bounded).
		expect(typeof run.attributes["yard.program_hash"]).toBe("string");
		expect(typeof run.attributes["yard.input_hash"]).toBe("string");
		expect(String(run.attributes["yard.program_hash"])).toHaveLength(16);
		// Effective limits recorded on the root.
		expect(typeof run.attributes["yard.deadline_ms"]).toBe("number");
		expect(run.attributes["yard.concurrency"]).toBe(4);
		// Usage + completion status.
		expect(run.attributes["yard.tool_calls"]).toBe(0);
		expect(run.attributes["yard.inference_calls"]).toBe(0);
		expect(run.attributes["yard.status"]).toBe("completed");
		expect(typeof run.attributes["yard.result_hash"]).toBe("string");
	});

	it("emits yard.effect child spans with per-effect timing and status", async () => {
		registry.set("fake_tool", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "fake_tool", description: "x", parameters: {} },
			},
			execute: async () => "ok",
		});
		await invoke({
			program: `function* main() { return yield tool("fake_tool", { a: 1 }); }`,
		});

		const spans = exporter.getFinishedSpans();
		const run = spans.find((s) => s.name === "yard.run");
		const effects = spans.filter((s) => s.name === "yard.effect");
		expect(effects).toHaveLength(1);
		const effect = effects[0];
		if (!effect || !run) throw new Error("missing spans");
		// Effect is a child of the run span — the tree structure IS the trace.
		expect(effect.parentSpanId).toBe(run.spanContext().spanId);
		expect(effect.attributes["yard.effect.kind"]).toBe("tool");
		expect(effect.attributes["yard.effect.tool"]).toBe("fake_tool");
		expect(effect.attributes["yard.effect.status"]).toBe("ok");
	});

	it("marks a failed effect span and still completes the run when caught", async () => {
		registry.set("boom", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "boom", description: "x", parameters: {} },
			},
			execute: async () => {
				throw new Error("kaboom");
			},
		});
		const raw = await invoke({
			program: `function* main() {
				try {
					yield tool("boom", {});
					return "unreachable";
				} catch (e) {
					return "recovered";
				}
			}`,
		});
		expect(JSON.parse(raw).result).toBe("recovered");

		const spans = exporter.getFinishedSpans();
		const effect = spans.find((s) => s.name === "yard.effect");
		const run = spans.find((s) => s.name === "yard.run");
		if (!effect || !run) throw new Error("missing spans");
		expect(effect.attributes["yard.effect.status"]).toBe("error");
		// Guest caught the failure, so the run itself completed.
		expect(run.attributes["yard.status"]).toBe("completed");
	});

	it("marks the run span failed when the program throws", async () => {
		await invoke({ program: "function* main() { throw new Error('dead'); }" });
		const run = exporter.getFinishedSpans().find((s) => s.name === "yard.run");
		if (!run) throw new Error("no run span");
		expect(run.attributes["yard.status"]).toBe("failed");
	});

	it("links nested yard runs as child spans sharing the root trace id", async () => {
		const raw = await invoke({
			program: `function* main() {
				const child = yield tool("yard", {
					program: "function* main(input) { return input.a; }",
					input: { a: 7 },
				});
				return child.result;
			}`,
		});
		expect(JSON.parse(raw).result).toBe(7);

		const spans = exporter.getFinishedSpans();
		const runs = spans.filter((s) => s.name === "yard.run");
		expect(runs).toHaveLength(2);
		const root = runs.find((s) => s.attributes["yard.depth"] === 0);
		const child = runs.find((s) => s.attributes["yard.depth"] === 1);
		if (!root || !child) throw new Error("missing root/child run spans");
		// Same root trace id ties the whole tree together...
		expect(child.attributes["yard.trace_id"]).toBe(root.attributes["yard.trace_id"]);
		// ...while each run keeps its own distinct run id.
		expect(child.attributes["yard.run_id"]).not.toBe(root.attributes["yard.run_id"]);
		expect(typeof child.attributes["yard.run_id"]).toBe("string");
		// And the child run span sits inside the parent's dispatching effect
		// span, so the OTEL tree mirrors the yard tree.
		expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
	});
});
