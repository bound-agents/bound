import { describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import type { McpServerManager } from "../mcp/manager";
import { useMcpServers } from "../tui/hooks/useMcpServers";
import { useToolCalls } from "../tui/hooks/useToolCalls";

/** Minimal mock BoundClient with event emitter support for testing hooks. */
function createMockClient() {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	return {
		on(event: string, handler: (...args: unknown[]) => void) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)?.add(handler);
		},
		off(event: string, handler: (...args: unknown[]) => void) {
			listeners.get(event)?.delete(handler);
		},
		emit(event: string, data: unknown) {
			for (const handler of listeners.get(event) ?? []) {
				handler(data);
			}
		},
	} as unknown as BoundClient & { emit: (event: string, data: unknown) => void };
}

// ============================================================================
// useToolCalls Tests
// ============================================================================

describe("useToolCalls", () => {
	it("ignores aux completion when the transient start event was missed", async () => {
		const mockClient = createMockClient();
		let count = -1;
		function TestAuxCompletion() {
			const { inFlightTools } = useToolCalls(mockClient, new Map(), "localhost", "/tmp");
			count = inFlightTools.size;
			return React.createElement(Text, null, `size:${count}`);
		}
		render(React.createElement(TestAuxCompletion));
		await new Promise((r) => setTimeout(r, 20));
		mockClient.emit("aux:completed", { thread_id: "missed-start", parent_thread_id: "parent" });
		await new Promise((r) => setTimeout(r, 20));
		expect(count).toBe(0);
	});
});

// ============================================================================
// useMcpServers Tests
// ============================================================================

describe("useMcpServers", () => {
	it("derives runningCount from the running servers reported by the manager", async () => {
		const serverStates = new Map();
		serverStates.set("github", { status: "running", toolCount: 10 });
		serverStates.set("slack", { status: "stopped", toolCount: 5 });
		serverStates.set("notion", { status: "running", toolCount: 2 });

		const mockManager = {
			getServerStates: vi.fn().mockReturnValue(serverStates),
		} as unknown as McpServerManager;

		function TestUseMcpServers() {
			const { runningCount } = useMcpServers(mockManager);
			return React.createElement(Text, null, `running:${runningCount}`);
		}

		const { lastFrame } = render(React.createElement(TestUseMcpServers));
		await new Promise((r) => setTimeout(r, 20));
		expect(lastFrame()).toContain("running:2");
	});

	it("mirrors the manager's server states via serverStates", async () => {
		const serverStates = new Map();
		serverStates.set("github", { status: "running", toolCount: 10 });
		serverStates.set("slack", { status: "stopped", toolCount: 5 });

		const mockManager = {
			getServerStates: vi.fn().mockReturnValue(serverStates),
		} as unknown as McpServerManager;

		function TestUseMcpServersStates() {
			const { serverStates: states } = useMcpServers(mockManager);
			return React.createElement(Text, null, `count:${states.size}`);
		}

		const { lastFrame } = render(React.createElement(TestUseMcpServersStates));
		await new Promise((r) => setTimeout(r, 20));
		expect(lastFrame()).toContain("count:2");
	});
});
