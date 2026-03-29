import { describe, expect, it, mock } from "bun:test";
import { BoundNotRunningError } from "../bound-client";
import type { BoundClient, BoundMessage, ThreadStatus } from "../bound-client";
import { createBoundChatHandler } from "../handler";

function makeClient(overrides: Partial<BoundClient> = {}): BoundClient {
	return {
		createMcpThread: mock(() => Promise.resolve({ thread_id: "new-thread" })),
		sendMessage: mock(() => Promise.resolve()),
		getStatus: mock(() => Promise.resolve({ active: false, state: null, detail: null } as ThreadStatus)),
		getMessages: mock(() =>
			Promise.resolve([
				{
					id: "msg-1",
					thread_id: "new-thread",
					role: "assistant",
					content: "Hello from bound!",
					model_id: null,
					tool_name: null,
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: null,
					host_origin: "localhost",
				} as BoundMessage,
			]),
		),
		...overrides,
	} as unknown as BoundClient;
}

describe("createBoundChatHandler", () => {
	describe("mcp-server.AC4.1: creates new thread when no thread_id supplied", () => {
		it("calls createMcpThread and uses the returned thread_id", async () => {
			const client = makeClient();
			const handler = createBoundChatHandler(client);

			await handler({ message: "Hello" });

			expect(client.createMcpThread).toHaveBeenCalledTimes(1);
			expect(client.sendMessage).toHaveBeenCalledWith("new-thread", "Hello");
		});
	});

	describe("mcp-server.AC4.3: reuses supplied thread_id without creating a new thread", () => {
		it("does not call createMcpThread when thread_id is provided", async () => {
			const client = makeClient();
			const handler = createBoundChatHandler(client);

			await handler({ message: "Follow up", thread_id: "existing-thread" });

			expect(client.createMcpThread).not.toHaveBeenCalled();
			expect(client.sendMessage).toHaveBeenCalledWith("existing-thread", "Follow up");
		});
	});

	describe("mcp-server.AC4.4: returns last assistant message as text content block", () => {
		it("returns correct content from last assistant message", async () => {
			const client = makeClient();
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello" });

			expect(result.isError).toBeUndefined();
			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			expect(result.content[0].text).toBe("Hello from bound!");
		});

		it("returns empty string when no assistant message exists", async () => {
			const client = makeClient({
				getMessages: mock(() => Promise.resolve([])),
			});
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello" });

			expect(result.content[0].text).toBe("");
		});
	});

	describe("mcp-server.AC5.1: returns isError when bound is unreachable", () => {
		it("returns isError:true with URL in message when createMcpThread throws BoundNotRunningError", async () => {
			const client = makeClient({
				createMcpThread: mock(() =>
					Promise.reject(new BoundNotRunningError("http://localhost:3000")),
				),
			});
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello" });

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("http://localhost:3000");
		});

		it("returns isError:true when sendMessage throws BoundNotRunningError", async () => {
			const client = makeClient({
				sendMessage: mock(() =>
					Promise.reject(new BoundNotRunningError("http://localhost:3000")),
				),
			});
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello", thread_id: "t-1" });

			expect(result.isError).toBe(true);
		});

		it("returns isError:true when getStatus throws BoundNotRunningError", async () => {
			const client = makeClient({
				getStatus: mock(() =>
					Promise.reject(new BoundNotRunningError("http://localhost:3000")),
				),
			});
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello", thread_id: "t-1" });

			expect(result.isError).toBe(true);
		});
	});

	describe("mcp-server.AC5.2: returns isError on 5-minute poll timeout", () => {
		it("returns isError:true when agent stays active past timeout", async () => {
			// Always returns active=true to simulate stuck agent.
			// Override the MAX_POLL_MS by making Date.now() advance past limit
			// on the second status call.
			let callCount = 0;
			const startDate = Date.now();
			// Inject a Date.now that jumps 6 minutes after first poll check
			const mockedNow = mock(() => {
				callCount++;
				// After first call (setup), jump past 5 min threshold
				if (callCount > 2) return startDate + 6 * 60 * 1000;
				return startDate;
			});
			const originalDateNow = Date.now;
			Date.now = mockedNow as unknown as typeof Date.now;

			try {
				const client = makeClient({
					getStatus: mock(() =>
						Promise.resolve({ active: true, state: "thinking", detail: null }),
					),
				});
				const handler = createBoundChatHandler(client);

				const result = await handler({ message: "Hello", thread_id: "t-1" });

				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain("5 minutes");
			} finally {
				Date.now = originalDateNow;
			}
		});
	});
});
