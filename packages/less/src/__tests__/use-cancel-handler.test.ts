import { describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { useCancelHandler } from "../tui/hooks/useCancelHandler";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

type EventHandler = (...args: unknown[]) => void;

function createMockClient() {
	const listeners = new Map<string, Set<EventHandler>>();
	return {
		on: vi.fn((event: string, handler: EventHandler) => {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)?.add(handler);
		}),
		off: vi.fn((event: string, handler: EventHandler) => {
			listeners.get(event)?.delete(handler);
		}),
		cancelThread: vi.fn(async () => {}),
		emit: (event: string, data: unknown) => {
			for (const handler of listeners.get(event) ?? []) {
				handler(data);
			}
		},
	} as unknown as BoundClient & { emit: (event: string, data: unknown) => void };
}

describe("useCancelHandler", () => {
	it("calls cancelThread on first Ctrl-C when turn is active", async () => {
		const mockClient = createMockClient();
		// biome-ignore lint/style/noNonNullAssertion: set synchronously in first render
		let smRef: ReturnType<typeof useCancelHandler>["stateMachine"] | null = null;

		function Harness() {
			const { stateMachine } = useCancelHandler({
				client: mockClient as unknown as BoundClient,
				threadId: "t1",
				abortAll: vi.fn(),
				dismissModal: () => false,
				showHint: vi.fn(),
			});
			smRef = stateMachine;
			return React.createElement(Text, null, "ok");
		}

		const { stdin } = render(React.createElement(Harness));
		await tick();

		if (smRef) smRef.turnActive = true;

		stdin.write("\x03");
		await tick();

		expect(mockClient.cancelThread).toHaveBeenCalledWith("t1");
	});

	it("shows hint on Ctrl-C when idle", async () => {
		const mockClient = createMockClient();
		const showHintSpy = vi.fn();

		function Harness() {
			useCancelHandler({
				client: mockClient as unknown as BoundClient,
				threadId: "t1",
				abortAll: vi.fn(),
				dismissModal: () => false,
				showHint: showHintSpy,
			});
			return React.createElement(Text, null, "ok");
		}

		const { stdin } = render(React.createElement(Harness));
		await tick();

		stdin.write("\x03");
		await tick();

		expect(showHintSpy).toHaveBeenCalledWith("Press Ctrl-C again to exit");
	});

	it("tracks turn-active state from thread:status events", async () => {
		const mockClient = createMockClient();
		let smRef: ReturnType<typeof useCancelHandler>["stateMachine"] | null = null;

		function Harness() {
			const { stateMachine } = useCancelHandler({
				client: mockClient as unknown as BoundClient,
				threadId: "t1",
				abortAll: vi.fn(),
				dismissModal: () => false,
				showHint: vi.fn(),
			});
			smRef = stateMachine;
			return React.createElement(Text, null, `active:${stateMachine.turnActive}`);
		}

		render(React.createElement(Harness));
		await tick();

		expect(smRef?.turnActive).toBe(false);

		mockClient.emit("thread:status", { thread_id: "t1", active: true });
		await tick();

		expect(smRef?.turnActive).toBe(true);

		mockClient.emit("thread:status", { thread_id: "t1", active: false });
		await tick();

		expect(smRef?.turnActive).toBe(false);
	});

	it("ignores thread:status for different thread", async () => {
		const mockClient = createMockClient();
		let smRef: ReturnType<typeof useCancelHandler>["stateMachine"] | null = null;

		function Harness() {
			const { stateMachine } = useCancelHandler({
				client: mockClient as unknown as BoundClient,
				threadId: "t1",
				abortAll: vi.fn(),
				dismissModal: () => false,
				showHint: vi.fn(),
			});
			smRef = stateMachine;
			return React.createElement(Text, null, "ok");
		}

		render(React.createElement(Harness));
		await tick();

		mockClient.emit("thread:status", { thread_id: "t2", active: true });
		await tick();

		expect(smRef?.turnActive).toBe(false);
	});
});
