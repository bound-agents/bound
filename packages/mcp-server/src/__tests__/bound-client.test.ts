import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { BoundClient, BoundNotRunningError } from "../bound-client";

// Save original fetch — must be restored to prevent polluting other test suites
let originalFetch: typeof fetch;
let mockFetch: ReturnType<typeof mock>;

beforeAll(() => {
	originalFetch = global.fetch;
});

afterAll(() => {
	global.fetch = originalFetch;
});

beforeEach(() => {
	mockFetch = mock(() => Promise.resolve(new Response()));
	global.fetch = mockFetch as unknown as typeof fetch;
});

describe("BoundClient", () => {
	const BASE_URL = "http://localhost:3000";
	let client: BoundClient;

	beforeEach(() => {
		client = new BoundClient(BASE_URL);
	});

	describe("createMcpThread", () => {
		it("POST /api/mcp/threads and returns thread_id", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify({ thread_id: "abc-123" }), {
						status: 201,
						headers: { "Content-Type": "application/json" },
					}),
				),
			);

			const result = await client.createMcpThread();

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${BASE_URL}/api/mcp/threads`);
			expect(init.method).toBe("POST");
			expect(result.thread_id).toBe("abc-123");
		});

		it("throws BoundNotRunningError on non-2xx response", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve(new Response("Not found", { status: 404 })),
			);

			await expect(client.createMcpThread()).rejects.toBeInstanceOf(BoundNotRunningError);
		});

		it("throws BoundNotRunningError when fetch throws (connection refused)", async () => {
			mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

			await expect(client.createMcpThread()).rejects.toBeInstanceOf(BoundNotRunningError);
		});
	});

	describe("sendMessage", () => {
		it("POST /api/threads/:id/messages with content body", async () => {
			mockFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 201 })));

			await client.sendMessage("thread-1", "Hello!");

			const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${BASE_URL}/api/threads/thread-1/messages`);
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body as string)).toEqual({ content: "Hello!" });
		});

		it("throws BoundNotRunningError on non-2xx response", async () => {
			mockFetch.mockImplementation(() => Promise.resolve(new Response("Error", { status: 500 })));

			await expect(client.sendMessage("thread-1", "Hello!")).rejects.toBeInstanceOf(
				BoundNotRunningError,
			);
		});

		it("throws BoundNotRunningError when fetch throws", async () => {
			mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

			await expect(client.sendMessage("thread-1", "Hi")).rejects.toBeInstanceOf(
				BoundNotRunningError,
			);
		});
	});

	describe("getStatus", () => {
		it("GET /api/threads/:id/status and returns status object", async () => {
			const statusPayload = { active: false, state: null, detail: null };
			mockFetch.mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify(statusPayload), {
						headers: { "Content-Type": "application/json" },
					}),
				),
			);

			const status = await client.getStatus("thread-1");

			const [url] = mockFetch.mock.calls[0] as [string];
			expect(url).toBe(`${BASE_URL}/api/threads/thread-1/status`);
			expect(status.active).toBe(false);
		});

		it("throws BoundNotRunningError on non-2xx response", async () => {
			mockFetch.mockImplementation(() => Promise.resolve(new Response("Error", { status: 503 })));

			await expect(client.getStatus("thread-1")).rejects.toBeInstanceOf(BoundNotRunningError);
		});

		it("throws BoundNotRunningError when fetch throws", async () => {
			mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

			await expect(client.getStatus("thread-1")).rejects.toBeInstanceOf(BoundNotRunningError);
		});
	});

	describe("getMessages", () => {
		it("GET /api/threads/:id/messages and returns message array", async () => {
			const messages = [
				{
					id: "msg-1",
					thread_id: "thread-1",
					role: "assistant",
					content: "Hello!",
					model_id: null,
					tool_name: null,
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: null,
					host_origin: "localhost",
				},
			];
			mockFetch.mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify(messages), {
						headers: { "Content-Type": "application/json" },
					}),
				),
			);

			const result = await client.getMessages("thread-1");

			const [url] = mockFetch.mock.calls[0] as [string];
			expect(url).toBe(`${BASE_URL}/api/threads/thread-1/messages`);
			expect(result).toHaveLength(1);
			expect(result[0].role).toBe("assistant");
			expect(result[0].content).toBe("Hello!");
		});

		it("throws BoundNotRunningError on non-2xx response", async () => {
			mockFetch.mockImplementation(() => Promise.resolve(new Response("Error", { status: 404 })));

			await expect(client.getMessages("thread-1")).rejects.toBeInstanceOf(BoundNotRunningError);
		});

		it("throws BoundNotRunningError when fetch throws", async () => {
			mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

			await expect(client.getMessages("thread-1")).rejects.toBeInstanceOf(BoundNotRunningError);
		});
	});

	describe("BoundNotRunningError", () => {
		it("message contains the base URL", () => {
			const err = new BoundNotRunningError("http://localhost:3000");
			expect(err.message).toContain("http://localhost:3000");
			expect(err.name).toBe("BoundNotRunningError");
		});
	});
});
