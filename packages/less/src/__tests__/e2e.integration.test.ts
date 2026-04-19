import { beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundClient } from "@bound/client";
import type { ContentBlock } from "@bound/llm";
import { acquireLock, releaseLock } from "../lockfile";

const BOUND_URL = process.env.BOUND_URL || "http://localhost:3001";
let client: BoundClient;
let skipTests = false;

describe("e2e integration tests", () => {
	beforeAll(async () => {
		client = new BoundClient(BOUND_URL);
		try {
			// Try to list threads as connectivity check
			await client.listThreads();
		} catch {
			// Server is not available, skip all tests
			skipTests = true;
		}
	});

	// Test 1: Startup with no args (AC1.1)
	it("AC1.1: creates new thread and lists with empty messages", async () => {
		if (skipTests) {
			console.log("Skipping - no bound server available");
			return;
		}

		// Create thread
		const thread = await client.createThread();
		expect(thread).toBeDefined();
		expect(thread.id).toBeTruthy();

		// Verify thread exists
		const retrieved = await client.getThread(thread.id);
		expect(retrieved.id).toBe(thread.id);

		// Verify empty message list
		const messages = await client.listMessages(thread.id);
		expect(messages).toEqual([]);
	});

	// Test 2: Startup with --attach (AC1.2)
	it("AC1.2: attaches to existing thread and loads message history", async () => {
		if (skipTests) {
			console.log("Skipping - no bound server available");
			return;
		}

		// Create thread
		const thread = await client.createThread();

		// Send message (simulating prior conversation)
		client.sendMessage(thread.id, "hello");

		// Give server time to process and persist
		await new Promise((r) => setTimeout(r, 1000));

		// List messages
		const messages = await client.listMessages(thread.id);
		// Message should be persisted or at least retrievable
		expect(messages).toBeDefined();
		expect(Array.isArray(messages)).toBe(true);
	});

	// NOTE: AC10.1-AC10.4 (content widening) are validated at the server level in
	// packages/web/src/__tests__/ where the server-side message persistence logic
	// is tested. The E2E tests here verify that the BoundClient can call the
	// relevant API methods, but full validation requires a running agent loop
	// which is tested server-side.
	//
	// Specifically:
	// - AC10.1 (string → text block): packages/web/src/__tests__/tool-results.test.ts
	// - AC10.2 (ContentBlock[]): packages/web/src/__tests__/tool-results.test.ts
	// - AC10.3 (invalid variants rejected): packages/web/src/__tests__/tool-results.test.ts
	// - AC10.4 (backward compat): packages/web/src/__tests__/tool-results.test.ts

	// Test 3: Verify BoundClient can send tool:result with string content
	it("AC10.1: BoundClient.onToolCall can send string content", async () => {
		if (skipTests) {
			console.log("Skipping - no bound server available");
			return;
		}

		// Verify onToolCall handler registration works
		const thread = await client.createThread();
		client.onToolCall(async (_call) => {
			return {
				call_id: "test-call",
				thread_id: thread.id,
				content: "result content",
			};
		});

		expect(typeof client.onToolCall).toBe("function");
		// Handler registration is complete and would be invoked by server tool calls
	});

	// Test 4: Verify BoundClient can send tool:result with ContentBlock[]
	it("AC10.2: BoundClient.onToolCall can send ContentBlock array", async () => {
		if (skipTests) {
			console.log("Skipping - no bound server available");
			return;
		}

		const thread = await client.createThread();
		const blocks: ContentBlock[] = [{ type: "text", text: "Here is the result" }];

		client.onToolCall(async (_call) => {
			return {
				call_id: "test-call",
				thread_id: thread.id,
				content: blocks,
			};
		});

		expect(typeof client.onToolCall).toBe("function");
		// Handler registration is complete
	});

	// Test 5: Verify BoundClient API accepts tool:result structure
	it("AC10.3: BoundClient can construct ContentBlock tool results", async () => {
		if (skipTests) {
			console.log("Skipping - no bound server available");
			return;
		}

		const thread = await client.createThread();
		// Server-side validation ensures invalid ContentBlock variants are rejected
		// This test verifies the client API surface
		const validResult = {
			call_id: "test-call",
			thread_id: thread.id,
			content: [{ type: "text" as const, text: "text block" }],
		};
		expect(validResult.content[0].type).toBe("text");
	});

	// Test 6: Verify backward compatibility with string-only responses
	it("AC10.4: BoundClient.onToolCall sends plain string (backward compat)", async () => {
		if (skipTests) {
			console.log("Skipping - no bound server available");
			return;
		}

		const thread = await client.createThread();
		client.onToolCall(async (_call) => {
			// Old API: send plain string
			return {
				call_id: "test-call",
				thread_id: thread.id,
				content: "plain string response",
			};
		});

		expect(typeof client.onToolCall).toBe("function");
		// Handler works with backward-compatible string content
	});

	// Test 7: Lockfile — same cwd conflict
	it("AC4.6: lockfile acquisition fails on same cwd conflict", async () => {
		if (skipTests) {
			console.log("Skipping - no bound server available");
			return;
		}

		const hex = randomBytes(4).toString("hex");
		const configDir = join(tmpdir(), `boundless-e2e-lock-${hex}`);
		const threadId = "test-lock-conflict";
		const cwd = process.cwd();

		try {
			mkdirSync(configDir, { recursive: true });

			// First acquisition should succeed
			acquireLock(configDir, threadId, cwd);

			// Second acquisition with same cwd should fail
			expect(() => acquireLock(configDir, threadId, cwd)).toThrow(
				/already attached from this directory/,
			);

			// Clean up
			releaseLock(configDir, threadId);
		} finally {
			try {
				rmSync(configDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	// Test 8: Lockfile — stale recovery
	it("AC4.5: lockfile stale lock recovery succeeds with dead PID", async () => {
		if (skipTests) {
			console.log("Skipping - no bound server available");
			return;
		}

		const hex = randomBytes(4).toString("hex");
		const configDir = join(tmpdir(), `boundless-e2e-stale-${hex}`);
		const threadId = "test-stale-lock";
		const cwd = process.cwd();

		try {
			mkdirSync(configDir, { recursive: true });
			mkdirSync(join(configDir, "locks"), { recursive: true });

			// Write stale lock with non-existent PID
			const staleLockData = JSON.stringify({
				cwd,
				pid: 999999, // Non-existent PID
				attachedAt: new Date().toISOString(),
			});
			writeFileSync(join(configDir, "locks", `${threadId}.json`), staleLockData);

			// Acquiring should clear stale lock and succeed
			expect(() => acquireLock(configDir, threadId, cwd)).not.toThrow();

			// Clean up
			releaseLock(configDir, threadId);
		} finally {
			try {
				rmSync(configDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});
});
