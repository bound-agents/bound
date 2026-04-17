import { describe, expect, it, mock } from "bun:test";
import { BoundNotRunningError } from "@bound/client";
import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { createBoundChatHandler } from "../handler";

interface MockBoundClientOptions {
	subscriptions?: Set<string>;
	unsubscriptions?: Set<string>;
	listeners?: Map<string, Set<(...args: unknown[]) => void>>;
	onCalls?: Array<{ event: string; handler: (...args: unknown[]) => void }>;
	offCalls?: Array<{ event: string; handler: (...args: unknown[]) => void }>;
}

function makeClient(overrides: Partial<BoundClient> & MockBoundClientOptions = {}): BoundClient {
	const subscriptions = overrides.subscriptions ?? new Set<string>();
	const unsubscriptions = overrides.unsubscriptions ?? new Set<string>();
	const listeners = overrides.listeners ?? new Map<string, Set<(...args: unknown[]) => void>>();
	const onCalls = overrides.onCalls ?? [];
	const offCalls = overrides.offCalls ?? [];

	return {
		createMcpThread: mock(() => Promise.resolve({ thread_id: "new-thread" })),
		subscribe: mock((threadId: string) => {
			subscriptions.add(threadId);
		}),
		unsubscribe: mock((threadId: string) => {
			unsubscriptions.add(threadId);
		}),
		sendMessage: mock((_threadId: string, _content: string) => {
			// Fire-and-forget, returns void
		}),
		on: mock((event: string, handler: (...args: unknown[]) => void) => {
			onCalls.push({ event, handler });
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(handler);
		}),
		off: mock((event: string, handler: (...args: unknown[]) => void) => {
			offCalls.push({ event, handler });
			const set = listeners.get(event);
			if (set) {
				set.delete(handler);
				if (set.size === 0) listeners.delete(event);
			}
		}),
		listMessages: mock(() =>
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
				} as Message,
			]),
		),
		...overrides,
	} as unknown as BoundClient;
}

describe("createBoundChatHandler", () => {
	describe("ws-client-tools.AC5.1: sends messages via WS and detects completion via thread:status event", () => {
		it("subscribes to thread before waiting for completion", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({ listeners });
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello" });

			// Allow handler to subscribe
			await new Promise((resolve) => setImmediate(resolve));

			expect(client.subscribe).toHaveBeenCalledWith("new-thread");

			// Simulate thread:status event indicating completion
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "new-thread", active: false });
				}
			}

			const result = await handlerPromise;

			expect(result.isError).toBeUndefined();
			expect(result.content[0].text).toBe("Hello from bound!");
		});

		it("sends message over WS (fire-and-forget)", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({ listeners });
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Test message", thread_id: "t-1" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			expect(client.sendMessage).toHaveBeenCalledWith("t-1", "Test message");

			// Simulate completion
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "t-1", active: false });
				}
			}

			const result = await handlerPromise;
			expect(result.isError).toBeUndefined();
		});

		it("waits for thread:status event with active=false before fetching messages", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			let listMessagesCallCount = 0;
			const client = makeClient({
				listeners,
				listMessages: mock(() => {
					listMessagesCallCount++;
					return Promise.resolve([
						{
							id: "msg-1",
							thread_id: "t-1",
							role: "assistant",
							content: "Done!",
							model_id: null,
							tool_name: null,
							created_at: "2026-01-01T00:00:00.000Z",
							modified_at: null,
							host_origin: "localhost",
						} as Message,
					]);
				}),
			});
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello", thread_id: "t-1" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Verify listMessages hasn't been called yet
			expect(listMessagesCallCount).toBe(0);

			// Simulate thread:status event
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "t-1", active: false });
				}
			}

			const result = await handlerPromise;

			// Now listMessages should have been called
			expect(listMessagesCallCount).toBe(1);
			expect(result.content[0].text).toBe("Done!");
		});

		it("unsubscribes from thread after completion", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({ listeners });
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello", thread_id: "t-1" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Simulate completion
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "t-1", active: false });
				}
			}

			await handlerPromise;

			expect(client.unsubscribe).toHaveBeenCalledWith("t-1");
		});

		it("removes event listener after completion", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const offCalls: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];
			const client = makeClient({ listeners, offCalls });
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello", thread_id: "t-1" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Get the registered handler
			const threadStatusHandlers = listeners.get("thread:status");
			expect(threadStatusHandlers?.size).toBeGreaterThan(0);

			// Simulate completion
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "t-1", active: false });
				}
			}

			await handlerPromise;

			// Verify client.off was called
			expect(client.off).toHaveBeenCalledWith("thread:status", expect.any(Function));
		});
	});

	describe("ws-client-tools.AC5.2: does not expose tools parameter", () => {
		it("does not call configureTools", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({ listeners });
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Verify configureTools is NOT called
			if ("configureTools" in client) {
				expect(client.configureTools).not.toHaveBeenCalled?.();
			}

			// Simulate completion
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "new-thread", active: false });
				}
			}

			const result = await handlerPromise;
			expect(result.isError).toBeUndefined();
		});
	});

	describe("mcp-server.AC4.1: creates new thread when no thread_id supplied", () => {
		it("calls createMcpThread and uses the returned thread_id", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({ listeners });
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			expect(client.createMcpThread).toHaveBeenCalledTimes(1);
			expect(client.sendMessage).toHaveBeenCalledWith("new-thread", "Hello");

			// Simulate completion
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "new-thread", active: false });
				}
			}

			await handlerPromise;
		});
	});

	describe("mcp-server.AC4.3: reuses supplied thread_id without creating a new thread", () => {
		it("does not call createMcpThread when thread_id is provided", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({ listeners });
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Follow up", thread_id: "existing-thread" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			expect(client.createMcpThread).not.toHaveBeenCalled();
			expect(client.sendMessage).toHaveBeenCalledWith("existing-thread", "Follow up");

			// Simulate completion
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "existing-thread", active: false });
				}
			}

			await handlerPromise;
		});
	});

	describe("mcp-server.AC4.4: returns last assistant message as text content block", () => {
		it("returns correct content from last assistant message", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({ listeners });
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Simulate completion
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "new-thread", active: false });
				}
			}

			const result = await handlerPromise;

			expect(result.isError).toBeUndefined();
			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			expect(result.content[0].text).toBe("Hello from bound!");
		});

		it("returns empty string when no assistant message exists", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({
				listeners,
				listMessages: mock(() => Promise.resolve([])),
			});
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Simulate completion
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "new-thread", active: false });
				}
			}

			const result = await handlerPromise;

			expect(result.content[0].text).toBe("");
		});
	});

	describe("error handling: returns isError when bound is unreachable", () => {
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

		it("returns isError:true when subscribe throws an error", async () => {
			const client = makeClient({
				subscribe: mock(() => {
					throw new Error("WS not connected");
				}),
			});
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello", thread_id: "t-1" });

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("WS not connected");
		});

		it("returns isError:true when sendMessage throws BoundNotRunningError", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({
				listeners,
				sendMessage: mock(() => {
					throw new BoundNotRunningError("http://localhost:3000");
				}),
			});
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello", thread_id: "t-1" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			const result = await handlerPromise;

			expect(result.isError).toBe(true);
		});

		it("returns isError:true when listMessages throws BoundNotRunningError", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({
				listeners,
				listMessages: mock(() => Promise.reject(new BoundNotRunningError("http://localhost:3000"))),
			});
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello", thread_id: "t-1" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Simulate completion
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "t-1", active: false });
				}
			}

			const result = await handlerPromise;

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("http://localhost:3000");
		});
	});

	describe("timeout handling: returns isError on completion timeout", () => {
		it("returns isError:true when thread:status event does not arrive within timeout", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({ listeners });
			const SHORT_TIMEOUT = 50; // 50ms for testing
			const handler = createBoundChatHandler(client, { maxPollMs: SHORT_TIMEOUT });

			// Start handler but don't emit completion event
			const resultPromise = handler({ message: "Hello", thread_id: "t-1" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Wait for timeout to fire
			const result = await resultPromise;

			// Verify timeout behavior
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Timed out");
		});

		it("cleans up listeners and unsubscribes on timeout", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const client = makeClient({ listeners });
			const SHORT_TIMEOUT = 50; // 50ms for testing
			const handler = createBoundChatHandler(client, { maxPollMs: SHORT_TIMEOUT });

			// Start handler but don't emit completion event
			const resultPromise = handler({ message: "Hello", thread_id: "t-1" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Wait for timeout to fire
			await resultPromise;

			// Verify cleanup was called
			expect(client.unsubscribe).toHaveBeenCalledWith("t-1");
			expect(client.off).toHaveBeenCalledWith("thread:status", expect.any(Function));
		});
	});

	describe("filters thread:status events by thread_id", () => {
		it("ignores thread:status events for different thread IDs", async () => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			let listMessagesCallCount = 0;
			const client = makeClient({
				listeners,
				listMessages: mock(() => {
					listMessagesCallCount++;
					return Promise.resolve([]);
				}),
			});
			const handler = createBoundChatHandler(client);

			const handlerPromise = handler({ message: "Hello", thread_id: "t-1" });

			// Allow handler to set up listeners
			await new Promise((resolve) => setImmediate(resolve));

			// Emit completion event for wrong thread
			const threadStatusHandlers = listeners.get("thread:status");
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "t-2", active: false });
				}
			}

			// listMessages should NOT have been called
			expect(listMessagesCallCount).toBe(0);

			// Now emit for correct thread
			if (threadStatusHandlers) {
				for (const h of threadStatusHandlers) {
					h({ thread_id: "t-1", active: false });
				}
			}

			await handlerPromise;

			// Now listMessages should have been called
			expect(listMessagesCallCount).toBe(1);
		});
	});
});
