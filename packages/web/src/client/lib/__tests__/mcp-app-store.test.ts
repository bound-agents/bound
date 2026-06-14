import { describe, expect, it } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpAppHost } from "../mcp-app-host";
import {
	type McpAppInstance,
	type McpAppInstanceMap,
	type PersistedToolMessage,
	type UiInstanceSink,
	createToolCallHandler,
	instancesForThread,
	reconstructInstancesFromMessages,
	removeInstance,
	upsertInstance,
} from "../mcp-app-store";

function fakeInstance(overrides: Partial<McpAppInstance> = {}): McpAppInstance {
	return {
		callId: "call-1",
		threadId: "thread-1",
		boundName: "mcp__srv__tool",
		serverName: "srv",
		uiResourceUri: "ui://srv/app.html",
		input: {},
		client: { readResource: async () => ({ contents: [] }) },
		resultPromise: Promise.resolve({ content: [] } as CallToolResult),
		createdAt: 1,
		...overrides,
	};
}

describe("mcp-app-store reducers", () => {
	it("upsertInstance adds without mutating the input map", () => {
		const map: McpAppInstanceMap = {};
		const inst = fakeInstance();
		const next = upsertInstance(map, inst);
		expect(next[inst.callId]).toBe(inst);
		expect(map).toEqual({});
	});

	it("upsertInstance replaces an existing call id", () => {
		const a = fakeInstance({ serverName: "old" });
		const b = fakeInstance({ serverName: "new" });
		const next = upsertInstance(upsertInstance({}, a), b);
		expect(Object.keys(next)).toHaveLength(1);
		expect(next["call-1"].serverName).toBe("new");
	});

	it("removeInstance drops the call id without mutating the input", () => {
		const inst = fakeInstance();
		const map = upsertInstance({}, inst);
		const next = removeInstance(map, "call-1");
		expect(next).toEqual({});
		expect(map["call-1"]).toBe(inst);
	});

	it("removeInstance is a no-op for an unknown call id", () => {
		const inst = fakeInstance();
		const map = upsertInstance({}, inst);
		expect(removeInstance(map, "nope")).toBe(map);
	});

	it("instancesForThread filters by thread and sorts oldest-first", () => {
		const map = [
			fakeInstance({ callId: "c1", threadId: "t1", createdAt: 30 }),
			fakeInstance({ callId: "c2", threadId: "t2", createdAt: 20 }),
			fakeInstance({ callId: "c3", threadId: "t1", createdAt: 10 }),
		].reduce<McpAppInstanceMap>((acc, i) => upsertInstance(acc, i), {});
		const result = instancesForThread(map, "t1");
		expect(result.map((i) => i.callId)).toEqual(["c3", "c1"]);
	});
});

describe("createToolCallHandler", () => {
	function hostWithTool(opts: {
		uiResourceUri?: string;
		callTool: () => Promise<CallToolResult>;
	}): { host: McpAppHost; boundName: string } {
		const host = new McpAppHost();
		const client = { callTool: opts.callTool };
		const defs = host.registerServer("srv", client, [
			{
				name: "do_thing",
				inputSchema: { type: "object", properties: {} },
				...(opts.uiResourceUri
					? {
							_meta: {
								"ui.resourceUri": opts.uiResourceUri,
								ui: { resourceUri: opts.uiResourceUri },
							},
						}
					: {}),
			} as unknown as Parameters<McpAppHost["registerServer"]>[2][number],
		]);
		return { host, boundName: defs[0].function.name };
	}

	it("returns is_error for an unknown tool and registers nothing", async () => {
		const host = new McpAppHost();
		const registered: McpAppInstance[] = [];
		const sink: UiInstanceSink = { register: (i) => registered.push(i) };
		const handler = createToolCallHandler(host, sink);
		const result = await handler({
			call_id: "c1",
			thread_id: "t1",
			tool_name: "mcp__nope__x",
			arguments: {},
		});
		expect(result.is_error).toBe(true);
		expect(result.content).toContain("Unknown MCP tool");
		expect(registered).toHaveLength(0);
	});

	it("dispatches a non-UI tool and registers no app instance", async () => {
		const { host, boundName } = hostWithTool({
			callTool: async () => ({ content: [{ type: "text", text: "ok" }] }) as CallToolResult,
		});
		const registered: McpAppInstance[] = [];
		const handler = createToolCallHandler(host, { register: (i) => registered.push(i) });
		const result = await handler({
			call_id: "c1",
			thread_id: "t1",
			tool_name: boundName,
			arguments: { a: 1 },
		});
		expect(result.content).toBe("ok");
		expect(result.is_error).toBe(false);
		expect(registered).toHaveLength(0);
	});

	it("registers an app instance for a UI-bearing tool and returns the text result", async () => {
		const callResult = { content: [{ type: "text", text: "rendered" }] } as CallToolResult;
		const { host, boundName } = hostWithTool({
			uiResourceUri: "ui://srv/app.html",
			callTool: async () => callResult,
		});
		const registered: McpAppInstance[] = [];
		const handler = createToolCallHandler(host, { register: (i) => registered.push(i) }, () => 42);
		const result = await handler({
			call_id: "c9",
			thread_id: "t1",
			tool_name: boundName,
			arguments: { q: "hi" },
		});
		expect(result.content).toBe("rendered");
		expect(registered).toHaveLength(1);
		const inst = registered[0];
		expect(inst.callId).toBe("c9");
		expect(inst.threadId).toBe("t1");
		expect(inst.uiResourceUri).toBe("ui://srv/app.html");
		expect(inst.input).toEqual({ q: "hi" });
		expect(inst.createdAt).toBe(42);
		await expect(inst.resultPromise).resolves.toBe(callResult);
	});

	it("propagates a tool-call failure as is_error and still registers the instance", async () => {
		const { host, boundName } = hostWithTool({
			uiResourceUri: "ui://srv/app.html",
			callTool: async () => {
				throw new Error("boom");
			},
		});
		const registered: McpAppInstance[] = [];
		const handler = createToolCallHandler(host, { register: (i) => registered.push(i) });
		const result = await handler({
			call_id: "c1",
			thread_id: "t1",
			tool_name: boundName,
			arguments: {},
		});
		expect(result.is_error).toBe(true);
		expect(result.content).toBe("boom");
		expect(registered).toHaveLength(1);
		// The shared in-flight promise rejects; the app side handles it as cancel.
		await expect(registered[0].resultPromise).rejects.toThrow("boom");
	});
});

describe("reconstructInstancesFromMessages", () => {
	// A host with one UI-bearing tool ("do_thing") and one plain tool ("plain").
	function host(): McpAppHost {
		const h = new McpAppHost();
		const client = { callTool: async () => ({ content: [] }) as CallToolResult };
		h.registerServer("srv", client, [
			{
				name: "do_thing",
				inputSchema: { type: "object", properties: {} },
				_meta: { ui: { resourceUri: "ui://srv/app.html" } },
			},
			{ name: "plain", inputSchema: { type: "object", properties: {} } },
		] as unknown as Parameters<McpAppHost["registerServer"]>[2]);
		return h;
	}

	// The bound name the host assigns to the UI tool (namespaced + sanitized).
	function uiBoundName(h: McpAppHost): string {
		return h.getToolDefinitions()[0].function.name;
	}

	// A tool_call row carrying one tool_use block (the call's input lives here).
	function toolCallMsg(
		id: string,
		name: string,
		input: Record<string, unknown>,
	): PersistedToolMessage {
		return {
			role: "tool_call",
			content: JSON.stringify([{ type: "tool_use", id, name, input }]),
		};
	}

	// A tool_result row keyed back to its call (tool_name = tool_use id), with the
	// MCP App binding stamped onto messages.metadata.mcp_app at dispatch — the
	// authoritative render signal the renderer reads (instead of reverse-parsing
	// the call shape). `binding` null means a non-UI tool: no stamp.
	function toolResultMsg(
		toolUseId: string,
		binding: { server: string; tool: string; uiResourceUri: string } | null,
		text = "rendered ok",
	): PersistedToolMessage {
		return {
			role: "tool_result",
			tool_name: toolUseId,
			content: JSON.stringify([{ type: "text", text }]),
			metadata: binding ? JSON.stringify({ mcp_app: binding }) : null,
		};
	}

	const SRV_BINDING = { server: "srv", tool: "do_thing", uiResourceUri: "ui://srv/app.html" };

	it("rebuilds a UI-bearing instance from the result-row binding, pairing the call's input", async () => {
		const h = host();
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_1", "srv", { subcommand: "do_thing", q: "hi" }),
			toolResultMsg("tooluse_1", SRV_BINDING),
		];
		const instances = reconstructInstancesFromMessages(messages, h, "t1", () => 7);
		expect(instances).toHaveLength(1);
		const inst = instances[0];
		expect(inst.callId).toBe("tooluse_1");
		expect(inst.threadId).toBe("t1");
		expect(inst.boundName).toBe(uiBoundName(h));
		expect(inst.serverName).toBe("srv");
		expect(inst.uiResourceUri).toBe("ui://srv/app.html");
		// The omnibus `subcommand` wrapper is stripped; the app gets only its args.
		expect(inst.input).toEqual({ q: "hi" });
		expect(inst.createdAt).toBe(7);
		// The result is reconstructed from the persisted tool_result content blocks.
		await expect(inst.resultPromise).resolves.toEqual({
			content: [{ type: "text", text: "rendered ok" }],
			isError: false,
		});
	});

	it("mounts regardless of call shape — a binding on a bash-wrapped call still renders", () => {
		// The whole point of stamping the binding at dispatch: it doesn't matter
		// where the tool was called from. Here the tool_use is a `bash` call whose
		// input is a shell string (the boundless shape) — no `subcommand` to parse,
		// the old resolveCall heuristic would have found nothing. The result-row
		// binding carries the truth, so the instance still mounts.
		const h = host();
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_b", "bash", { command: "github do_thing" }),
			toolResultMsg("tooluse_b", SRV_BINDING),
		];
		const instances = reconstructInstancesFromMessages(messages, h, "t1");
		expect(instances).toHaveLength(1);
		expect(instances[0].serverName).toBe("srv");
		expect(instances[0].uiResourceUri).toBe("ui://srv/app.html");
	});

	it("resolves an empty result when the bound result row carried no content", async () => {
		const h = host();
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_x", "srv", { subcommand: "do_thing" }),
			{
				role: "tool_result",
				tool_name: "tooluse_x",
				content: JSON.stringify([]),
				metadata: JSON.stringify({ mcp_app: SRV_BINDING }),
			},
		];
		const instances = reconstructInstancesFromMessages(messages, h, "t1");
		expect(instances).toHaveLength(1);
		await expect(instances[0].resultPromise).resolves.toEqual({ content: [], isError: false });
	});

	it("wraps a flattened-text result (bare JSON, not a content-block array) back into a text block", async () => {
		// A sandbox/MCP-bridge dispatch persists the tool RESULT as the flattened
		// text the agent loop consumes — github `get_me` lands as the bare JSON object
		// `{"login":...}`, NOT a `[{type,text}]` content-block array. An app that reads
		// `result.content[].text` (github's get-me app JSON.parses it) needs that text
		// back inside a text block, or it sees no content and renders "No user data".
		const h = host();
		const userJson = '{"login":"polaris-is-online","id":280102667}';
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_j", "srv", { subcommand: "do_thing" }),
			{
				role: "tool_result",
				tool_name: "tooluse_j",
				content: userJson,
				metadata: JSON.stringify({ mcp_app: SRV_BINDING }),
			},
		];
		const instances = reconstructInstancesFromMessages(messages, h, "t1");
		expect(instances).toHaveLength(1);
		await expect(instances[0].resultPromise).resolves.toEqual({
			content: [{ type: "text", text: userJson }],
			isError: false,
		});
	});

	it("does not mount until a bound result lands — an unpaired tool_call yields nothing", () => {
		// The binding lives on the tool_result, so a call whose result hasn't been
		// persisted yet produces no instance. It mounts on the result's arrival.
		const h = host();
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_pending", "srv", { subcommand: "do_thing" }),
		];
		expect(reconstructInstancesFromMessages(messages, h, "t1")).toHaveLength(0);
	});

	it("skips a tool_result with no MCP App binding (a non-UI tool)", () => {
		const h = host();
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_2", "srv", { subcommand: "plain" }),
			toolResultMsg("tooluse_2", null),
		];
		expect(reconstructInstancesFromMessages(messages, h, "t1")).toHaveLength(0);
	});

	it("skips a binding whose server the browser never connected to", () => {
		// The binding names a (server, tool) the host has no live client for, so
		// there's nothing to read the ui:// resource with — it can't render.
		const h = host();
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_3", "gone", { subcommand: "tool" }),
			toolResultMsg("tooluse_3", {
				server: "gone",
				tool: "tool",
				uiResourceUri: "ui://gone/app.html",
			}),
		];
		expect(reconstructInstancesFromMessages(messages, h, "t1")).toHaveLength(0);
	});

	it("ignores messages with no tool_use block and no binding", () => {
		const h = host();
		const messages: PersistedToolMessage[] = [
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "hello" }]) },
			{ role: "user", content: "plain string content" },
		];
		expect(reconstructInstancesFromMessages(messages, h, "t1")).toHaveLength(0);
	});

	it("accepts already-parsed array content (not just JSON strings)", () => {
		const h = host();
		const messages: PersistedToolMessage[] = [
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tooluse_4", name: "srv", input: { a: 1 } }],
			},
			toolResultMsg("tooluse_4", SRV_BINDING),
		];
		const instances = reconstructInstancesFromMessages(messages, h, "t1");
		expect(instances).toHaveLength(1);
		expect(instances[0].input).toEqual({ a: 1 });
	});

	it("tolerates malformed JSON content without throwing", () => {
		const h = host();
		const messages: PersistedToolMessage[] = [{ role: "tool_call", content: "{ not json" }];
		expect(reconstructInstancesFromMessages(messages, h, "t1")).toEqual([]);
	});

	it("tolerates malformed metadata without throwing", () => {
		const h = host();
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_5", "srv", { subcommand: "do_thing" }),
			{ role: "tool_result", tool_name: "tooluse_5", content: "[]", metadata: "{ not json" },
		];
		expect(reconstructInstancesFromMessages(messages, h, "t1")).toEqual([]);
	});
});
