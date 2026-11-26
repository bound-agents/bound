import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { BoundClient, ToolCallRequest, ToolCallResult } from "@bound/client";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import type { ResolvedSandboxConfig } from "../tools/sandbox-policy";
import { resolveShell } from "../tools/shell";
import type { ToolHandler } from "../tools/types";
import { useToolCalls } from "../tui/hooks/useToolCalls";

/** Let React effects flush. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

type EventHandler = (...args: unknown[]) => void;

interface MockClient extends BoundClient {
	emit: (event: string, data: unknown) => void;
	fireToolCall: (call: ToolCallRequest) => Promise<ToolCallResult>;
}

function createMockClient(): MockClient {
	const listeners = new Map<string, Set<EventHandler>>();
	let toolHandler: ((call: ToolCallRequest) => Promise<ToolCallResult>) | null = null;
	return {
		onToolCall: vi.fn((handler: (call: ToolCallRequest) => Promise<ToolCallResult>) => {
			toolHandler = handler;
		}),
		on: vi.fn((event: string, handler: EventHandler) => {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)?.add(handler);
		}),
		off: vi.fn((event: string, handler: EventHandler) => {
			listeners.get(event)?.delete(handler);
		}),
		emit: (event: string, data: unknown) => {
			for (const handler of listeners.get(event) ?? []) handler(data);
		},
		fireToolCall: (call: ToolCallRequest) => {
			if (!toolHandler) throw new Error("no tool handler registered");
			return toolHandler(call);
		},
	} as unknown as MockClient;
}

const DISABLED_SANDBOX: ResolvedSandboxConfig = {
	mode: "disabled",
	onUnavailable: "error",
	writableRoots: [],
	readableRoots: [],
	networkAllowlist: [],
} as unknown as ResolvedSandboxConfig;

const shell = resolveShell(undefined, { platform: "linux" });

function callRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
	return {
		call_id: "c1",
		tool_name: "read",
		arguments: { file_path: "/tmp/x.ts" },
		thread_id: "t1",
		...overrides,
	} as ToolCallRequest;
}

/** Mount the hook and expose its result across renders. */
function mountHook(
	client: MockClient,
	handlers: Map<string, ToolHandler>,
): { result: () => ReturnType<typeof useToolCalls>; unmount: () => void } {
	let latest: ReturnType<typeof useToolCalls> | null = null;
	function Harness() {
		latest = useToolCalls(client, handlers, "host", "/cwd", shell, DISABLED_SANDBOX);
		return React.createElement(Text, null, `n:${latest.inFlightTools.size}`);
	}
	const { unmount } = render(React.createElement(Harness));
	return { result: () => latest as ReturnType<typeof useToolCalls>, unmount };
}

describe("useToolCalls", () => {
	let originalEnv: string | undefined;
	beforeEach(() => {
		originalEnv = process.env.FORCE_COLOR;
	});
	afterEach(() => {
		if (originalEnv === undefined) process.env.FORCE_COLOR = undefined;
		else process.env.FORCE_COLOR = originalEnv;
	});

	it("does nothing when client is null", async () => {
		let latest: ReturnType<typeof useToolCalls> | null = null;
		function Harness() {
			latest = useToolCalls(null, new Map(), "host", "/cwd", shell, DISABLED_SANDBOX);
			return React.createElement(Text, null, "ok");
		}
		render(React.createElement(Harness));
		await tick();
		expect(latest?.inFlightTools.size).toBe(0);
	});

	it("runs a registered handler and returns its content", async () => {
		const client = createMockClient();
		const handler: ToolHandler = vi.fn(async () => ({
			content: [{ type: "text", text: "hello" }],
			isError: false,
		}));
		mountHook(client, new Map([["read", handler]]));
		await tick();

		const result = await client.fireToolCall(callRequest());
		expect(handler).toHaveBeenCalledTimes(1);
		expect(result.call_id).toBe("c1");
		expect(result.thread_id).toBe("t1");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(result.is_error).toBe(false);
	});

	it("passes the abort signal and cwd through to the handler", async () => {
		const client = createMockClient();
		let seenCwd = "";
		let seenSignal: AbortSignal | null = null;
		const handler: ToolHandler = vi.fn(async (_args, signal, cwd) => {
			seenCwd = cwd;
			seenSignal = signal;
			return { content: [{ type: "text", text: "ok" }], isError: false };
		});
		mountHook(client, new Map([["read", handler]]));
		await tick();

		await client.fireToolCall(callRequest());
		expect(seenCwd).toBe("/cwd");
		expect(seenSignal).toBeInstanceOf(AbortSignal);
	});

	it("returns an error result when the tool is not found", async () => {
		const client = createMockClient();
		mountHook(client, new Map());
		await tick();

		const result = await client.fireToolCall(callRequest({ tool_name: "nope" }));
		expect(result.is_error).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Error: Tool 'nope' not found",
		});
	});

	it("catches a thrown handler error and surfaces it as an error result", async () => {
		const client = createMockClient();
		const handler: ToolHandler = vi.fn(async () => {
			throw new Error("boom");
		});
		mountHook(client, new Map([["read", handler]]));
		await tick();

		const result = await client.fireToolCall(callRequest());
		expect(result.is_error).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text", text: "Error: boom" });
	});

	it("stringifies a non-Error throw", async () => {
		const client = createMockClient();
		const thrower = () => {
			throw "plain string";
		};
		const handler: ToolHandler = vi.fn(async () => thrower());
		mountHook(client, new Map([["read", handler]]));
		await tick();

		const result = await client.fireToolCall(callRequest());
		expect(result.is_error).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text", text: "Error: plain string" });
	});

	it("tracks a tool as in-flight while running and removes it after", async () => {
		const client = createMockClient();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handler: ToolHandler = vi.fn(async () => {
			await gate;
			return { content: [{ type: "text", text: "done" }], isError: false };
		});
		const h = mountHook(client, new Map([["read", handler]]));
		await tick();

		const pending = client.fireToolCall(callRequest());
		await tick();
		expect(h.result().inFlightTools.size).toBe(1);
		const inflight = h.result().inFlightTools.get("c1");
		expect(inflight?.toolName).toBe("read");
		expect(inflight?.args).toEqual({ file_path: "/tmp/x.ts" });
		expect(inflight?.threadId).toBe("t1");

		release();
		await pending;
		await tick();
		expect(h.result().inFlightTools.size).toBe(0);
	});

	it("aborts the matching controller on a tool:cancel event and clears it", async () => {
		const client = createMockClient();
		let capturedSignal: AbortSignal | null = null;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handler: ToolHandler = vi.fn(async (_a, signal) => {
			capturedSignal = signal;
			await gate;
			return { content: [{ type: "text", text: "done" }], isError: false };
		});
		const h = mountHook(client, new Map([["read", handler]]));
		await tick();

		const pending = client.fireToolCall(callRequest());
		await tick();
		expect(h.result().inFlightTools.size).toBe(1);

		client.emit("tool:cancel", { callId: "c1" });
		await tick();
		expect(capturedSignal?.aborted).toBe(true);
		expect(h.result().inFlightTools.size).toBe(0);

		release();
		await pending;
	});

	it("ignores a tool:cancel event for an unknown call id", async () => {
		const client = createMockClient();
		const h = mountHook(client, new Map());
		await tick();
		client.emit("tool:cancel", { callId: "missing" });
		await tick();
		expect(h.result().inFlightTools.size).toBe(0);
	});

	it("adds and removes an aux card on aux:started / aux:completed", async () => {
		const client = createMockClient();
		const h = mountHook(client, new Map());
		await tick();

		client.emit("aux:started", {
			thread_id: "aux1",
			parent_thread_id: "parent",
			agent_name: "implementer",
		});
		await tick();
		const card = h.result().inFlightTools.get("aux:aux1");
		expect(card?.toolName).toBe("aux");
		expect(card?.threadId).toBe("parent");
		expect(card?.args).toMatchObject({ action: "invoke", name: "implementer", thread_id: "aux1" });

		client.emit("aux:completed", { thread_id: "aux1" });
		await tick();
		expect(h.result().inFlightTools.get("aux:aux1")).toBeUndefined();
	});

	it("abortAll aborts every in-flight controller and empties the map", async () => {
		const client = createMockClient();
		const signals: AbortSignal[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handler: ToolHandler = vi.fn(async (_a, signal) => {
			signals.push(signal);
			await gate;
			return { content: [{ type: "text", text: "done" }], isError: false };
		});
		const h = mountHook(client, new Map([["read", handler]]));
		await tick();

		const p1 = client.fireToolCall(callRequest({ call_id: "a" }));
		const p2 = client.fireToolCall(callRequest({ call_id: "b" }));
		await tick();
		expect(h.result().inFlightTools.size).toBe(2);

		h.result().abortAll();
		await tick();
		expect(h.result().inFlightTools.size).toBe(0);
		expect(signals.every((s) => s.aborted)).toBe(true);

		release();
		await Promise.all([p1, p2]);
	});

	it("removes event listeners on unmount", async () => {
		const client = createMockClient();
		const h = mountHook(client, new Map());
		await tick();
		h.unmount();
		await tick();
		expect(client.off).toHaveBeenCalledWith("tool:cancel", expect.any(Function));
		expect(client.off).toHaveBeenCalledWith("aux:started", expect.any(Function));
		expect(client.off).toHaveBeenCalledWith("aux:completed", expect.any(Function));
	});

	it("defaults missing arguments to an empty object in the in-flight card", async () => {
		const client = createMockClient();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handler: ToolHandler = vi.fn(async () => {
			await gate;
			return { content: [], isError: false };
		});
		const h = mountHook(client, new Map([["read", handler]]));
		await tick();

		const pending = client.fireToolCall(
			callRequest({ arguments: undefined as unknown as Record<string, unknown> }),
		);
		await tick();
		expect(h.result().inFlightTools.get("c1")?.args).toEqual({});
		release();
		await pending;
		await tick();
	});
});
