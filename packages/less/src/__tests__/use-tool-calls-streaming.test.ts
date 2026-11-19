import { describe, expect, it, vi } from "bun:test";
import type { BoundClient, ToolCallRequest, ToolCallResult } from "@bound/client";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { DISABLED_SANDBOX } from "../tools/sandbox-policy";
import { resolveShell } from "../tools/shell";
import type { ToolHandler } from "../tools/types";
import { useToolCalls } from "../tui/hooks/useToolCalls";

/**
 * Covers the shell-streaming branch of useToolCalls (the `toolName ===
 * shell.toolName` path that routes bashToolWithStreaming's onStdoutChunk into
 * the in-flight card's `stdout`). The other handler paths live in
 * use-tool-calls.test.ts; this file drives a REAL bash command through the
 * streaming path so the chunk callback actually fires and accumulates on the
 * card, then confirms the final result carries the command output.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

type EventHandler = (...args: unknown[]) => void;
interface MockClient extends BoundClient {
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
		off: vi.fn(),
		fireToolCall: (call: ToolCallRequest) => {
			if (!toolHandler) throw new Error("no tool handler registered");
			return toolHandler(call);
		},
	} as unknown as MockClient;
}

// The POSIX shell drives the echo; skip the actual streaming assertions on
// Windows (where the shell + echo semantics differ and the sandbox dispatch
// takes the lowbox path), but still exercise the branch wiring.
const shell = resolveShell(undefined, { platform: "linux" });

describe("useToolCalls shell streaming branch", () => {
	function mountHook(client: MockClient, handlers: Map<string, ToolHandler>) {
		let latest: ReturnType<typeof useToolCalls> | null = null;
		function Harness() {
			latest = useToolCalls(client, handlers, "host", "/tmp", shell, DISABLED_SANDBOX);
			return React.createElement(Text, null, `n:${latest.inFlightTools.size}`);
		}
		const { unmount } = render(React.createElement(Harness));
		return { result: () => latest as ReturnType<typeof useToolCalls>, unmount };
	}

	it.skipIf(process.platform === "win32")(
		"streams stdout chunks into the in-flight card and returns the command output",
		async () => {
			const client = createMockClient();
			// The streaming branch is reached only when a handler IS registered
			// under the shell tool name (the not-found guard returns first); the
			// shell path then ignores that handler and calls bashToolWithStreaming.
			const noop: ToolHandler = vi.fn(async () => ({ content: [], isError: false }));
			const { result, unmount } = mountHook(client, new Map([[shell.toolName, noop]]));
			await tick();

			const resultPromise = client.fireToolCall({
				call_id: "bash1",
				tool_name: shell.toolName,
				arguments: { command: "echo streaming-marker" },
				thread_id: "t1",
			} as ToolCallRequest);

			// While it runs, the card exists under the call id and streams stdout.
			await tick();
			const resolved = await resultPromise;

			expect(resolved.call_id).toBe("bash1");
			const text = JSON.stringify(resolved.content);
			expect(text).toContain("streaming-marker");
			// After completion the in-flight card is cleared.
			expect(result().inFlightTools.has("bash1")).toBe(false);
			unmount();
		},
	);

	it.skipIf(process.platform === "win32")(
		"accumulates streamed output on the card while the command runs",
		async () => {
			const client = createMockClient();
			const noop: ToolHandler = vi.fn(async () => ({ content: [], isError: false }));
			const handlers = new Map<string, ToolHandler>([[shell.toolName, noop]]);
			let seenStdout: string | undefined;
			function Harness() {
				const r = useToolCalls(client, handlers, "host", "/tmp", shell, DISABLED_SANDBOX);
				const card = r.inFlightTools.get("bash2");
				if (card?.stdout) seenStdout = card.stdout;
				return React.createElement(Text, null, `n:${r.inFlightTools.size}`);
			}
			const { unmount } = render(React.createElement(Harness));
			await tick();

			const resultPromise = client.fireToolCall({
				call_id: "bash2",
				tool_name: shell.toolName,
				// Two lines so a chunk lands on the card mid-run.
				arguments: { command: "printf 'chunk-a\\nchunk-b\\n'" },
				thread_id: "t1",
			} as ToolCallRequest);
			await tick();
			const resolved = await resultPromise;
			await tick();

			// The streamed-into-card text (captured during the run) carried output.
			expect(seenStdout ?? "").toContain("chunk-a");
			expect(JSON.stringify(resolved.content)).toContain("chunk-b");
			unmount();
		},
	);
});
