import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { TypedEventEmitter, type YardExecutionEvent } from "@bound/shared";
import type { RegisteredTool, ToolContext } from "../../types.js";
import { createYardTool } from "../yard.js";

describe("yard lifecycle events", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let registry: Map<string, RegisteredTool>;
	let ctx: ToolContext;
	let events: YardExecutionEvent[];

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.exec("INSERT INTO host_meta (key, value) VALUES ('site_id', 'site')");
		eventBus = new TypedEventEmitter();
		registry = new Map();
		events = [];
		eventBus.on("yard:execution", (event) => events.push(event));
		ctx = {
			db,
			siteId: "site",
			threadId: "thread-1",
			eventBus,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			getToolRegistry: () => registry,
		};
	});

	async function invoke(program: string, input?: unknown): Promise<string> {
		const tool = createYardTool(ctx);
		registry.set("yard", tool);
		if (!tool.execute) throw new Error("yard has no execute");
		return tool.execute({ program, input }) as Promise<string>;
	}

	it("emits a root start and completion with bounded input/result previews", async () => {
		await invoke("function* main(input) { return { answer: input.n + 1 }; }", { n: 41 });
		expect(events).toHaveLength(2);
		const [start, done] = events;
		expect(start?.phase).toBe("started");
		expect(start?.node.kind).toBe("run");
		expect(start?.parent_id).toBeNull();
		expect(start?.input_preview).toBe('{"n":41}');
		// The program source rides the root start event so the boundless card
		// (which replaces the request/result rows) can render it highlighted.
		expect(start?.program_preview).toContain("function* main(input)");
		expect(done?.phase).toBe("completed");
		expect(done?.node_id).toBe(start?.node_id);
		expect(done?.result_preview).toContain('"answer":42');
		expect(done?.seq).toBeGreaterThan(start?.seq ?? 0);
	});

	it("serializes a safe completed lifecycle graph into the Yard result", async () => {
		registry.set("plain", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "plain", description: "x", parameters: {} },
			},
			execute: async () => "ok",
		});

		const raw = await invoke(`function* main() {
			yield tool("plain", { secret: "nope" });
			return yield tool("plain", { token: "still-nope" });
		}`);
		const output = JSON.parse(raw);

		expect(output.execution).toMatchObject({
			version: 1,
			trace_id: output.trace_id,
			phase: "completed",
			nodes: [
				expect.objectContaining({ node: { kind: "run", depth: 0 }, phase: "completed" }),
				expect.objectContaining({ node: { kind: "tool", name: "plain" }, phase: "completed" }),
				expect.objectContaining({ node: { kind: "tool", name: "plain" }, phase: "completed" }),
			],
		});
		expect(JSON.stringify(output.execution)).not.toContain("secret");
		expect(JSON.stringify(output.execution)).not.toContain("nope");
		expect(JSON.stringify(output.execution)).not.toContain("still-nope");
	});

	it("emits tool leaves without exposing arguments", async () => {
		registry.set("plain", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "plain", description: "x", parameters: {} },
			},
			execute: async () => "ok",
		});
		await invoke('function* main() { return yield tool("plain", { secret: "nope" }); }');
		const effect = events.find((event) => event.node.kind === "tool" && event.phase === "started");
		expect(effect?.node).toEqual({ kind: "tool", name: "plain" });
		const rootStart = events.find(
			(event) => event.node.kind === "run" && event.phase === "started",
		);
		expect(effect?.run_id).toBe(rootStart?.node_id);
		expect(JSON.stringify(effect)).not.toContain("secret");
		expect(JSON.stringify(effect)).not.toContain("nope");
	});

	it("projects aux identity into the tool node name", async () => {
		registry.set("aux", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "aux", description: "x", parameters: {} },
			},
			execute: async () => "done",
		});
		await invoke('function* main() { return yield aux("skeptic", "review"); }');
		const effect = events.find((event) => event.node.kind === "tool" && event.phase === "started");
		expect(effect?.node).toEqual({ kind: "tool", name: "aux:skeptic" });
	});

	it("marks a failed effect but completed root when the guest catches it", async () => {
		registry.set("boom", {
			kind: "builtin",
			toolDefinition: {
				type: "function",
				function: { name: "boom", description: "x", parameters: {} },
			},
			execute: async () => {
				throw new Error("boom");
			},
		});
		await invoke(`function* main() {
			try { yield tool("boom", {}); } catch (e) {}
			return "recovered";
		}`);
		expect(events.some((event) => event.node.kind === "tool" && event.phase === "failed")).toBe(
			true,
		);
		expect(events.some((event) => event.node.kind === "run" && event.phase === "completed")).toBe(
			true,
		);
	});

	it("lifecycle listener failures never fail the Yard run", async () => {
		eventBus.on("yard:execution", () => {
			throw new Error("listener failed");
		});
		const raw = await invoke("function* main() { return 42; }");
		expect(JSON.parse(raw).result).toBe(42);
	});
});
