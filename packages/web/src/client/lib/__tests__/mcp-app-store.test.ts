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

	// The bound names the host assigns (namespaced + sanitized).
	function names(h: McpAppHost): { ui: string; plain: string } {
		const defs = h.getToolDefinitions();
		return { ui: defs[0].function.name, plain: defs[1].function.name };
	}

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

	it("rebuilds a UI-bearing instance from a persisted tool_call, pairing its result", async () => {
		const h = host();
		const { ui } = names(h);
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_1", ui, { q: "hi" }),
			{
				role: "tool_result",
				// the tool_result row keys back to its call via tool_name = tool_use id
				tool_name: "tooluse_1",
				content: JSON.stringify([{ type: "text", text: "rendered ok" }]),
			},
		];
		const instances = reconstructInstancesFromMessages(messages, h, "t1", () => 7);
		expect(instances).toHaveLength(1);
		const inst = instances[0];
		expect(inst.callId).toBe("tooluse_1");
		expect(inst.threadId).toBe("t1");
		expect(inst.boundName).toBe(ui);
		expect(inst.serverName).toBe("srv");
		expect(inst.uiResourceUri).toBe("ui://srv/app.html");
		expect(inst.input).toEqual({ q: "hi" });
		expect(inst.createdAt).toBe(7);
		// The result is reconstructed from the persisted tool_result content blocks.
		await expect(inst.resultPromise).resolves.toEqual({
			content: [{ type: "text", text: "rendered ok" }],
			isError: false,
		});
	});

	it("resolves an empty result when no tool_result was persisted yet", async () => {
		const h = host();
		const { ui } = names(h);
		const instances = reconstructInstancesFromMessages([toolCallMsg("tooluse_x", ui, {})], h, "t1");
		expect(instances).toHaveLength(1);
		await expect(instances[0].resultPromise).resolves.toEqual({ content: [], isError: false });
	});

	it("skips non-UI tool calls and unknown tools", () => {
		const h = host();
		const { plain } = names(h);
		const messages: PersistedToolMessage[] = [
			toolCallMsg("tooluse_2", plain, {}),
			toolCallMsg("tooluse_3", "mcp__gone__tool", {}),
		];
		expect(reconstructInstancesFromMessages(messages, h, "t1")).toHaveLength(0);
	});

	it("ignores messages with no tool_use block", () => {
		const h = host();
		const messages: PersistedToolMessage[] = [
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "hello" }]) },
			{ role: "user", content: "plain string content" },
		];
		expect(reconstructInstancesFromMessages(messages, h, "t1")).toHaveLength(0);
	});

	it("accepts already-parsed array content (not just JSON strings)", () => {
		const h = host();
		const { ui } = names(h);
		const messages: PersistedToolMessage[] = [
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tooluse_4", name: ui, input: { a: 1 } }],
			},
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

	it("resolves the agent's omnibus tool_use (server name + subcommand) to its UI binding", async () => {
		const h = host();
		// The agent calls UI-bearing MCP tools through the per-server omnibus
		// command — the persisted tool_use name is the SERVER ("srv"), the real
		// tool rides in input.subcommand ("do_thing"). The render trigger must
		// unwrap that to find the ui:// binding (generateMCPCommands).
		const messages: PersistedToolMessage[] = [
			{
				role: "tool_call",
				content: JSON.stringify([
					{
						type: "tool_use",
						id: "tooluse_omni",
						name: "srv",
						input: { subcommand: "do_thing", q: "hi" },
					},
				]),
			},
			{
				role: "tool_result",
				tool_name: "tooluse_omni",
				content: JSON.stringify([{ type: "text", text: "rendered ok" }]),
			},
		];
		const instances = reconstructInstancesFromMessages(messages, h, "t1", () => 9);
		expect(instances).toHaveLength(1);
		const inst = instances[0];
		expect(inst.callId).toBe("tooluse_omni");
		expect(inst.serverName).toBe("srv");
		expect(inst.uiResourceUri).toBe("ui://srv/app.html");
		// The boundName is the canonical per-tool name, not the omnibus "srv".
		expect(inst.boundName).toBe(names(h).ui);
		// The subcommand wrapper is stripped from the args forwarded to the app.
		expect(inst.input).toEqual({ q: "hi" });
		await expect(inst.resultPromise).resolves.toEqual({
			content: [{ type: "text", text: "rendered ok" }],
			isError: false,
		});
	});

	it("skips an omnibus tool_use whose subcommand is not a UI-bearing tool", () => {
		const h = host();
		const messages: PersistedToolMessage[] = [
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "t_p", name: "srv", input: { subcommand: "plain" } },
				]),
			},
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "t_x", name: "srv", input: { subcommand: "nope" } },
				]),
			},
		];
		expect(reconstructInstancesFromMessages(messages, h, "t1")).toHaveLength(0);
	});
});
