import { describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import { render } from "ink-testing-library";
import React from "react";
import type { McpServerManager } from "../mcp/manager";
import { App } from "../tui/App";

const tick = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient(overrides: Record<string, unknown> = {}): BoundClient {
	return {
		listThreads: vi.fn().mockResolvedValue([
			{ id: "t-current", title: "Current" },
			{ id: "t-other", title: "Other" },
		]),
		listModels: vi.fn().mockResolvedValue({ models: [], default: "" }),
		getThread: vi.fn().mockResolvedValue({ id: "t-current", title: "Current" }),
		createThread: vi.fn().mockResolvedValue({ id: "t-new" }),
		listMessages: vi.fn().mockResolvedValue([]),
		subscribe: vi.fn(),
		unsubscribe: vi.fn(),
		on: vi.fn().mockReturnValue(() => {}),
		off: vi.fn(),
		onToolCall: vi.fn(),
		sendMessage: vi.fn().mockResolvedValue(undefined),
		configureTools: vi.fn(),
		connectionState: "connected",
		...overrides,
	} as unknown as BoundClient;
}

const mcpManager = {
	getServerStates: vi.fn().mockReturnValue(new Map()),
	getRunningTools: vi.fn().mockReturnValue(new Map()),
	ensureAllEnabled: vi.fn(),
} as unknown as McpServerManager;

function renderApp(client: BoundClient | null) {
	return render(
		React.createElement(App, {
			client,
			threadId: "t-current",
			configDir: "/tmp",
			cwd: "/home/user",
			hostname: "localhost",
			mcpManager,
			mcpConfigs: [],
			// biome-ignore lint/suspicious/noExplicitAny: test logger stub
			logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
			initialMessages: [],
			model: "gpt-4",
			toolHandlers: new Map(),
		}),
	);
}

async function openAttach(r: ReturnType<typeof renderApp>) {
	await tick();
	r.stdin.write("/attach");
	await tick();
	r.stdin.write("\r");
	await tick();
	expect(r.lastFrame() ?? "").toContain("Select Thread");
}

describe("App /attach transitions", () => {
	it("re-selecting the current thread just closes the picker", async () => {
		const client = makeClient();
		const r = renderApp(client);
		await openAttach(r);
		r.stdin.write("\r");
		await tick();
		expect(r.lastFrame() ?? "").not.toContain("Select Thread");
		expect(client.unsubscribe).not.toHaveBeenCalled();
		r.unmount();
	});

	it("a failed attach closes the picker and a second Enter does not start a second transition", async () => {
		let reject: (e: Error) => void = () => {};
		const getThread = vi.fn(
			() =>
				new Promise((_, rej) => {
					reject = rej;
				}),
		);
		const client = makeClient({ getThread });
		const r = renderApp(client);
		await openAttach(r);
		r.stdin.write("\u001B[B"); // down to t-other
		await tick();
		r.stdin.write("\r");
		await tick();
		r.stdin.write("\r");
		await tick();
		const calls = getThread.mock.calls.filter((c) => c[0] === "t-other").length;
		expect(calls).toBe(1);
		reject(new Error("boom"));
		await tick(250);
		expect(r.lastFrame() ?? "").not.toContain("Select Thread");
		r.unmount();
	});
});

describe("App /clear", () => {
	it("starts a new thread and resets the processing indicator", async () => {
		const client = makeClient();
		const r = renderApp(client);
		await tick();
		r.stdin.write("/clear");
		await tick();
		r.stdin.write("\r");
		await tick(250);
		expect(client.createThread).toHaveBeenCalled();
		r.unmount();
	});
});

describe("App hint timer", () => {
	it("re-arms the hint timer and clears it on unmount", async () => {
		const r = renderApp(makeClient());
		await tick();
		r.stdin.write("\u0003");
		await tick(40);
		r.stdin.write("x");
		await tick(40);
		r.stdin.write("\u0003");
		await tick(40);
		r.unmount();
	});
});

describe("ChatView offline submit", () => {
	it("refuses the send and keeps the draft when disconnected", async () => {
		const client = makeClient({ connectionState: "disconnected" });
		const r = renderApp(client);
		await tick();
		r.stdin.write("hello there");
		await tick();
		r.stdin.write("\r");
		await tick();
		const frame = r.lastFrame() ?? "";
		expect(frame).toContain("Not connected");
		expect(frame).toContain("hello there");
		expect(client.sendMessage).not.toHaveBeenCalled();
		r.unmount();
	});
});
