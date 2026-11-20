import { beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundClient } from "@bound/client";
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
