import { describe, expect, it, mock } from "bun:test";
import type { BoundClient } from "@bound/client";
import type { Message, Thread } from "@bound/shared";
import { parseArgs, resolveThreadId } from "../boundless";

// Mock types for testing
const mockClient = (): BoundClient => {
	const instance = {
		connect: mock(() => Promise.resolve()),
		disconnect: mock(() => void 0),
		getThread: mock(async (_id: string): Promise<Thread> => ({
			id: "test-thread",
			title: "Test Thread",
			created_at: new Date().toISOString(),
		})),
		createThread: mock(async (): Promise<Thread> => ({
			id: "new-thread",
			title: "",
			created_at: new Date().toISOString(),
		})),
		listMessages: mock(async (_id: string): Promise<Message[]> => []),
		subscribe: mock((_id: string) => void 0),
		configureTools: mock((_tools, _opts) => void 0),
		on: mock(() => void 0),
		off: mock(() => void 0),
		onToolCall: mock((_handler) => void 0),
		sendMessage: mock(() => Promise.resolve()),
	} as unknown as BoundClient;
	return instance;
};

describe("boundless startup", () => {
	describe("argument parsing", () => {
		it("should parse --attach <threadId> argument", async () => {
			const args = ["--attach", "thread-123"];
			const result = await parseArgs(args);
			expect(result.attachArg).toBe("thread-123");
		});

		it("should parse --url <url> argument", async () => {
			const args = ["--url", "http://localhost:3002"];
			const result = await parseArgs(args);
			expect(result.urlArg).toBe("http://localhost:3002");
		});

		it("should parse combined arguments", async () => {
			const args = ["--attach", "thread-123", "--url", "http://example.com"];
			const result = await parseArgs(args);
			expect(result.attachArg).toBe("thread-123");
			expect(result.urlArg).toBe("http://example.com");
		});

		it("should default acp to false", async () => {
			const result = await parseArgs([]);
			expect(result.acp).toBe(false);
		});

		it("should parse --acp flag", async () => {
			const result = await parseArgs(["--acp"]);
			expect(result.acp).toBe(true);
		});

		it("should parse --acp combined with --url", async () => {
			const result = await parseArgs(["--acp", "--url", "http://example.com"]);
			expect(result.acp).toBe(true);
			expect(result.urlArg).toBe("http://example.com");
		});

		it("should reject unknown flags", async () => {
			const args = ["--unknown"];
			await expect(parseArgs(args)).rejects.toThrow("Unknown flag: --unknown");
		});

		it("should require value for --attach", async () => {
			const args = ["--attach"];
			await expect(parseArgs(args)).rejects.toThrow("Flag --attach requires a value");
		});

		it("should require value for --url", async () => {
			const args = ["--url"];
			await expect(parseArgs(args)).rejects.toThrow("Flag --url requires a value");
		});
	});

	describe("thread resolution", () => {
		it("AC1.1: should create new thread when no --attach provided", async () => {
			const client = mockClient();
			const threadId = await resolveThreadId(client, null);
			expect(threadId).toBe("new-thread");
			expect((client.createThread as any).mock.calls.length).toBe(1);
		});

		it("AC1.2: should attach to existing thread when --attach provided", async () => {
			const client = mockClient();
			const threadId = await resolveThreadId(client, "thread-123");
			expect(threadId).toBe("test-thread");
			expect((client.getThread as any).mock.calls.length).toBe(1);
			expect((client.getThread as any).mock.calls[0][0]).toBe("thread-123");
		});
	});
});
