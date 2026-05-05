import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow, softDelete } from "@bound/core";
import { applyMetricsSchema } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createIntrospectTool } from "../introspect";

describe("introspect tool", () => {
	let db: Database.Database;
	let ctx: ToolContext;
	let emittedEvents: Array<{ event: string; payload: unknown }>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		emittedEvents = [];

		ctx = {
			db,
			siteId: "test-site",
			eventBus: {
				on: () => {},
				off: () => {},
				emit: (event: string, payload: unknown) => {
					emittedEvents.push({ event, payload });
				},
				once: () => {},
			} as any,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId: "current-thread",
		};
	});

	afterEach(() => {
		db.close();
	});

	describe("AC1.1: Valid thread_id and message accepted", () => {
		it("enqueues notification and returns correlation_id", async () => {
			const tool = createIntrospectTool(ctx);
			const now = new Date().toISOString();

			// Insert target thread
			insertRow(
				db,
				"threads",
				{
					id: "target-thread",
					user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
					interface: "web",
					host_origin: "test-host",
					title: "Test Thread",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			// Execute with very short timeout to verify dispatch happens before polling starts timeout
			const executePromise = tool.execute({
				thread_id: "target-thread",
				message: "What do you think about this?",
				timeout: 50, // Short timeout for immediate phase 1 verification
			});

			// Check dispatch_queue immediately (before timeout)
			await new Promise((r) => setTimeout(r, 10));
			const queueEntry = db
				.prepare("SELECT event_payload FROM dispatch_queue WHERE thread_id = ? LIMIT 1")
				.get("target-thread") as { event_payload: string } | null;
			expect(queueEntry).not.toBeNull();

			// Verify payload structure before timeout
			const payload = JSON.parse(queueEntry?.event_payload || "{}");
			expect(payload.type).toBe("introspect");
			expect(payload.correlation_id).toBeDefined();
			expect(payload.source_thread).toBe("current-thread");
			expect(payload.content).toBe("What do you think about this?");

			// Event should be emitted
			expect(emittedEvents.length).toBe(1);
			expect(emittedEvents[0].event).toBe("notify:enqueued");
			expect(emittedEvents[0].payload).toEqual({ thread_id: "target-thread" });

			// Wait for timeout
			const result = await executePromise;
			expect(result).toContain("Error");
			expect(result).toContain("timed out");
		});
	});

	describe("AC1.2: Missing or empty thread_id returns error", () => {
		it("returns error when thread_id is missing", async () => {
			const tool = createIntrospectTool(ctx);

			const result = await tool.execute({
				message: "Hello",
			} as any);

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("thread_id");
			expect(emittedEvents.length).toBe(0);
		});

		it("returns error when thread_id is empty string", async () => {
			const tool = createIntrospectTool(ctx);

			const result = await tool.execute({
				thread_id: "",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(emittedEvents.length).toBe(0);
		});
	});

	describe("AC1.3: Self-introspect guard", () => {
		it("returns error when target thread is current thread", async () => {
			const tool = createIntrospectTool(ctx);
			const now = new Date().toISOString();

			// Insert current thread
			insertRow(
				db,
				"threads",
				{
					id: "current-thread",
					user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
					interface: "web",
					host_origin: "test-host",
					title: "Current Thread",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			const result = await tool.execute({
				thread_id: "current-thread",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("self");
			expect(emittedEvents.length).toBe(0);
		});
	});

	describe("AC1.4: Thread not found or deleted returns error", () => {
		it("returns error when thread does not exist", async () => {
			const tool = createIntrospectTool(ctx);

			const result = await tool.execute({
				thread_id: "nonexistent-thread",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("not found");
			expect(emittedEvents.length).toBe(0);
		});

		it("returns error when thread is soft-deleted", async () => {
			const tool = createIntrospectTool(ctx);
			const now = new Date().toISOString();

			// Insert thread
			insertRow(
				db,
				"threads",
				{
					id: "deleted-thread",
					user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
					interface: "web",
					host_origin: "test-host",
					title: "Deleted Thread",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			// Soft-delete it
			softDelete(db, "threads", "deleted-thread", ctx.siteId);

			const result = await tool.execute({
				thread_id: "deleted-thread",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("deleted");
			expect(emittedEvents.length).toBe(0);
		});
	});

	describe("AC2.1: Notification payload structure", () => {
		it("payload contains type=introspect, correlation_id, source_thread, and content", async () => {
			const tool = createIntrospectTool(ctx);
			const now = new Date().toISOString();

			// Insert target thread
			insertRow(
				db,
				"threads",
				{
					id: "target-thread",
					user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
					interface: "web",
					host_origin: "test-host",
					title: "Test Thread",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			// Execute with short timeout to verify dispatch happens
			const executePromise = tool.execute({
				thread_id: "target-thread",
				message: "Introspect this for me",
				timeout: 50,
			});

			// Check dispatch_queue immediately (before timeout)
			await new Promise((r) => setTimeout(r, 10));
			const queueEntry = db
				.prepare("SELECT event_payload FROM dispatch_queue WHERE thread_id = ? LIMIT 1")
				.get("target-thread") as { event_payload: string } | null;

			expect(queueEntry).not.toBeNull();

			const payload = JSON.parse(queueEntry?.event_payload || "{}");
			expect(payload.type).toBe("introspect");
			expect(typeof payload.correlation_id).toBe("string");
			expect(payload.correlation_id.length).toBeGreaterThan(0);
			expect(payload.source_thread).toBe("current-thread");
			expect(payload.content).toBe("Introspect this for me");

			// Wait for timeout result
			const result = await executePromise;
			expect(result).toContain("Error");
		});
	});

	describe("polling loop", () => {
		const getCorrelationIdFromQueue = (threadId: string): string => {
			const queueEntry = db
				.prepare(
					"SELECT event_payload FROM dispatch_queue WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
				)
				.get(threadId) as { event_payload: string } | null;
			if (!queueEntry) throw new Error("No queue entry found");
			const payload = JSON.parse(queueEntry.event_payload);
			return payload.correlation_id;
		};

		const setupTargetThread = (threadId: string) => {
			const now = new Date().toISOString();
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
					interface: "web",
					host_origin: "test-host",
					title: "Target Thread",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);
		};

		describe("introspect-tool.AC2.2 + AC2.3: Successful round-trip detection", () => {
			it("polls for response and detects stamped message with introspect_response_id", async () => {
				const tool = createIntrospectTool(ctx);
				setupTargetThread("target-thread");

				// Start polling (returns a Promise)
				const executePromise = tool.execute({
					thread_id: "target-thread",
					message: "What do you think?",
					timeout: 5000,
				});

				// Small delay to ensure poll started
				await new Promise((r) => setTimeout(r, 50));

				// Extract correlation ID from dispatch queue
				const correlationId = getCorrelationIdFromQueue("target-thread");

				// Insert response with stamped metadata (simulates post-loop hook)
				const responseNow = new Date().toISOString();
				insertRow(
					db,
					"messages",
					{
						id: "response-msg-1",
						thread_id: "target-thread",
						role: "assistant",
						content: "The answer is 42",
						metadata: JSON.stringify({ introspect_response_id: correlationId }),
						host_origin: "test-host",
						created_at: responseNow,
						modified_at: responseNow,
						deleted: 0,
					},
					ctx.siteId,
				);

				// Execute promise should resolve with response content
				const result = await executePromise;
				expect(result).toBe("The answer is 42");
			});
		});

		describe("introspect-tool.AC3.1: Timeout error detection", () => {
			it("returns timeout error when no response within configured timeout", async () => {
				const tool = createIntrospectTool(ctx);
				setupTargetThread("target-thread");

				// Call with very short timeout
				const result = await tool.execute({
					thread_id: "target-thread",
					message: "What do you think?",
					timeout: 100, // 100ms
				});

				expect(result).toContain("Error");
				expect(result).toContain("timed out");
				expect(result).toContain("100"); // Should show the actual timeout value
			});
		});

		describe("introspect-tool.AC3.2: Error turn detection", () => {
			it("detects target turn with status=error and returns early with error message", async () => {
				const tool = createIntrospectTool(ctx);
				setupTargetThread("target-thread");

				// Start polling
				const executePromise = tool.execute({
					thread_id: "target-thread",
					message: "What do you think?",
					timeout: 5000,
				});

				// Small delay to ensure poll started
				await new Promise((r) => setTimeout(r, 50));

				// Insert error turn with created_at after dispatch (using direct SQL to bypass schema validation)
				const errorTurnTime = new Date().toISOString();
				db.prepare(
					"INSERT INTO turns (id, thread_id, model_id, tokens_in, tokens_out, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
				).run("error-turn-1", "target-thread", "test-model", 100, 50, errorTurnTime, "error");

				// Execute should resolve with error message
				const result = await executePromise;
				expect(result).toContain("Error");
				expect(result).toContain("error");
				expect(result.toLowerCase()).toContain("target thread");
			});
		});

		describe("introspect-tool.AC3.3: Abort turn detection", () => {
			it("detects target turn with status=aborted and returns early with abort message", async () => {
				const tool = createIntrospectTool(ctx);
				setupTargetThread("target-thread");

				// Start polling
				const executePromise = tool.execute({
					thread_id: "target-thread",
					message: "What do you think?",
					timeout: 5000,
				});

				// Small delay to ensure poll started
				await new Promise((r) => setTimeout(r, 50));

				// Insert aborted turn with created_at after dispatch (using direct SQL)
				const abortTurnTime = new Date().toISOString();
				db.prepare(
					"INSERT INTO turns (id, thread_id, model_id, tokens_in, tokens_out, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
				).run("abort-turn-1", "target-thread", "test-model", 100, 50, abortTurnTime, "aborted");

				// Execute should resolve with abort message
				const result = await executePromise;
				expect(result).toContain("Error");
				expect(result.toLowerCase()).toContain("aborted");
			});
		});

		describe("response detection with array of correlation IDs", () => {
			it("detects response when metadata has introspect_response_id as array", async () => {
				const tool = createIntrospectTool(ctx);
				setupTargetThread("target-thread");

				// Start polling
				const executePromise = tool.execute({
					thread_id: "target-thread",
					message: "What do you think?",
					timeout: 5000,
				});

				// Small delay to ensure poll started
				await new Promise((r) => setTimeout(r, 50));

				// Extract correlation ID
				const correlationId = getCorrelationIdFromQueue("target-thread");

				// Insert response with introspect_response_id as array
				const responseNow = new Date().toISOString();
				insertRow(
					db,
					"messages",
					{
						id: "response-msg-2",
						thread_id: "target-thread",
						role: "assistant",
						content: "Array response",
						metadata: JSON.stringify({ introspect_response_id: [correlationId, "other-id"] }),
						host_origin: "test-host",
						created_at: responseNow,
						modified_at: responseNow,
						deleted: 0,
					},
					ctx.siteId,
				);

				// Should find response
				const result = await executePromise;
				expect(result).toBe("Array response");
			});
		});

		describe("malformed metadata handling", () => {
			it("skips messages with malformed metadata JSON", async () => {
				const tool = createIntrospectTool(ctx);
				setupTargetThread("target-thread");

				// Start polling
				const executePromise = tool.execute({
					thread_id: "target-thread",
					message: "What do you think?",
					timeout: 5000,
				});

				// Small delay to ensure poll started
				await new Promise((r) => setTimeout(r, 50));

				// Extract correlation ID
				const correlationId = getCorrelationIdFromQueue("target-thread");

				const responseNow = new Date().toISOString();

				// Insert message with malformed metadata (should be skipped)
				insertRow(
					db,
					"messages",
					{
						id: "malformed-msg",
						thread_id: "target-thread",
						role: "assistant",
						content: "Bad metadata",
						metadata: "not-valid-json{",
						host_origin: "test-host",
						created_at: responseNow,
						modified_at: responseNow,
						deleted: 0,
					},
					ctx.siteId,
				);

				// Insert valid response message after
				await new Promise((r) => setTimeout(r, 50));
				insertRow(
					db,
					"messages",
					{
						id: "valid-msg",
						thread_id: "target-thread",
						role: "assistant",
						content: "Correct response",
						metadata: JSON.stringify({ introspect_response_id: correlationId }),
						host_origin: "test-host",
						created_at: new Date().toISOString(),
						modified_at: new Date().toISOString(),
						deleted: 0,
					},
					ctx.siteId,
				);

				// Should find valid response, skipping malformed
				const result = await executePromise;
				expect(result).toBe("Correct response");
			});
		});
	});
});
