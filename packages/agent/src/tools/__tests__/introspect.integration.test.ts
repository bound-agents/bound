import Database from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyMetricsSchema, applySchema, insertRow, writeMessageMetadata } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createIntrospectTool, runIntrospectResponseStamp } from "../introspect";

describe("introspect tool integration", () => {
	let db: Database.Database;
	let ctx: ToolContext;
	let callerThreadId: string;
	let targetThreadId: string;

	beforeAll(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	beforeEach(() => {
		// Clear all tables
		db.exec(
			"DELETE FROM threads; DELETE FROM messages; DELETE FROM dispatch_queue; DELETE FROM change_log; DELETE FROM turns;",
		);

		callerThreadId = randomUUID();
		targetThreadId = randomUUID();
		const now = new Date().toISOString();

		// Insert caller thread
		insertRow(
			db,
			"threads",
			{
				id: callerThreadId,
				user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
				interface: "web",
				host_origin: "test-host",
				title: "Caller Thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			"test-site",
		);

		// Insert target thread
		insertRow(
			db,
			"threads",
			{
				id: targetThreadId,
				user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
				interface: "web",
				host_origin: "test-host",
				title: "Target Thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			"test-site",
		);

		ctx = {
			db,
			siteId: "test-site",
			eventBus: {
				on: () => {},
				off: () => {},
				emit: () => {},
				once: () => {},
			} as any,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId: callerThreadId,
		};
	});

	afterAll(() => {
		db.close();
	});

	describe("AC5.1: Request dispatch generates sync-visible entry", () => {
		it("enqueues notification which when processed generates changelog entries", async () => {
			const tool = createIntrospectTool(ctx);

			// Execute with short timeout to return quickly
			const executePromise = tool.execute({
				thread_id: targetThreadId,
				message: "Test question",
				timeout: 100,
			});

			// Allow dispatch to happen
			await new Promise((r) => setTimeout(r, 50));

			// Query dispatch_queue to extract correlationId
			const queueEntry = db
				.prepare("SELECT event_payload FROM dispatch_queue WHERE thread_id = ?")
				.get(targetThreadId) as { event_payload: string } | null;
			expect(queueEntry).not.toBeNull();

			const payload = JSON.parse(queueEntry?.event_payload ?? "");
			const correlationId = payload.correlation_id;
			expect(correlationId).toBeDefined();

			// Simulate what happens when the agent loop processes this notification:
			// 1. Inject a developer-role message via insertRow (generates changelog)
			const messageId = randomUUID();
			insertRow(
				db,
				"messages",
				{
					id: messageId,
					thread_id: targetThreadId,
					role: "developer",
					content: `[Introspect request from ${callerThreadId}] ${correlationId}`,
					host_origin: "test-host",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				ctx.siteId,
			);

			// 2. Write metadata with introspect_id (generates another changelog entry)
			writeMessageMetadata(db, messageId, { introspect_id: correlationId }, ctx.siteId);

			// Verify changelog has entries for both the message insertion and metadata update
			const changelogEntries = db
				.prepare(
					"SELECT * FROM change_log WHERE table_name = 'messages' ORDER BY timestamp DESC LIMIT 10",
				)
				.all() as Array<{ hlc: string; table_name: string; row_data: string }>;

			// Should have at least 2 entries: one for insert, one for metadata update
			expect(changelogEntries.length).toBeGreaterThanOrEqual(2);
			expect(changelogEntries.some((e) => e.table_name === "messages")).toBe(true);

			// Wait for timeout
			await executePromise;
		});
	});

	describe("AC5.2: Full round-trip with response stamping", () => {
		it("returns assistant message content when stamped with correlation ID", async () => {
			const tool = createIntrospectTool(ctx);
			const turnStartAt = new Date(Date.now() - 5000).toISOString();

			// Start the introspect call
			const executePromise = tool.execute({
				thread_id: targetThreadId,
				message: "What is the meaning?",
				timeout: 5000,
			});

			// Allow dispatch to happen
			await new Promise((r) => setTimeout(r, 50));

			// Extract correlation ID from dispatch_queue
			const queueEntry = db
				.prepare("SELECT event_payload FROM dispatch_queue WHERE thread_id = ?")
				.get(targetThreadId) as { event_payload: string } | null;
			const payload = JSON.parse(queueEntry?.event_payload ?? "");
			const correlationId = payload.correlation_id;

			// Simulate target response: insert developer message with introspect_id
			const devMsgId = randomUUID();
			insertRow(
				db,
				"messages",
				{
					id: devMsgId,
					thread_id: targetThreadId,
					role: "developer",
					content: `[Introspect request] ${correlationId}`,
					metadata: JSON.stringify({ introspect_id: correlationId }),
					host_origin: "test-host",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				ctx.siteId,
			);

			// Insert assistant response message
			const assistantMsgId = randomUUID();
			const assistantContent = "The meaning of life is 42.";
			insertRow(
				db,
				"messages",
				{
					id: assistantMsgId,
					thread_id: targetThreadId,
					role: "assistant",
					content: assistantContent,
					metadata: null,
					host_origin: "test-host",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				ctx.siteId,
			);

			// Call hook to stamp the assistant message
			await runIntrospectResponseStamp({
				db,
				siteId: ctx.siteId,
				threadId: targetThreadId,
				turnStartAt,
			});

			// Verify metadata was written (and thus generates changelog)
			const stamped = db
				.prepare("SELECT metadata FROM messages WHERE id = ?")
				.get(assistantMsgId) as { metadata: string | null } | null;
			expect(stamped?.metadata).not.toBeNull();

			const meta = JSON.parse(stamped?.metadata || "{}");
			expect(meta.introspect_response_id).toBe(correlationId);

			// Verify changelog has UPDATE entry for metadata write
			const metadataUpdateEntries = db
				.prepare("SELECT * FROM change_log WHERE table_name = 'messages' AND row_data LIKE ?")
				.all("%introspect_response_id%") as Array<{
				seq: number;
				table_name: string;
				row_data: string;
			}>;
			expect(metadataUpdateEntries.length).toBeGreaterThan(0);

			// Now the polling should detect the stamped message and return
			const result = await executePromise;
			expect(result).toBe(assistantContent);
		});
	});

	describe("AC4.3: Hook no-op when no assistant message", () => {
		it("does not stamp metadata when no assistant message exists", async () => {
			const turnStartAt = new Date(Date.now() - 5000).toISOString();

			// Insert developer message with introspect_id (simulates incoming introspect request)
			const devMsgId = randomUUID();
			const correlationId = randomUUID();
			insertRow(
				db,
				"messages",
				{
					id: devMsgId,
					thread_id: targetThreadId,
					role: "developer",
					content: `[Introspect request] ${correlationId}`,
					metadata: JSON.stringify({ introspect_id: correlationId }),
					host_origin: "test-host",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				ctx.siteId,
			);

			// Count changelog entries before calling the hook
			const changelogBefore = db
				.prepare("SELECT * FROM change_log WHERE table_name = 'messages'")
				.all() as Array<{ seq: number }>;

			// Do NOT insert any assistant message

			// Call hook
			await runIntrospectResponseStamp({
				db,
				siteId: ctx.siteId,
				threadId: targetThreadId,
				turnStartAt,
			});

			// Count changelog entries after calling the hook
			const changelogAfter = db
				.prepare("SELECT * FROM change_log WHERE table_name = 'messages'")
				.all() as Array<{ seq: number }>;

			// Verify no new changelog entries were created by the hook
			// The hook should return early without stamping metadata
			expect(changelogAfter.length).toBe(changelogBefore.length);
		});
	});

	describe("AC4.2: Multiple introspect requests per turn", () => {
		it("stamps single correlation ID as string", async () => {
			const turnStartAt = new Date(Date.now() - 5000).toISOString();

			// Single introspect request
			const correlationId = randomUUID();
			const devMsgId = randomUUID();
			insertRow(
				db,
				"messages",
				{
					id: devMsgId,
					thread_id: targetThreadId,
					role: "developer",
					content: `[Introspect] ${correlationId}`,
					metadata: JSON.stringify({ introspect_id: correlationId }),
					host_origin: "test-host",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				ctx.siteId,
			);

			// Assistant response
			const assistantMsgId = randomUUID();
			insertRow(
				db,
				"messages",
				{
					id: assistantMsgId,
					thread_id: targetThreadId,
					role: "assistant",
					content: "Response",
					metadata: null,
					host_origin: "test-host",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				ctx.siteId,
			);

			// Run hook
			await runIntrospectResponseStamp({
				db,
				siteId: ctx.siteId,
				threadId: targetThreadId,
				turnStartAt,
			});

			// Verify stored as string (not array) when single
			const stamped = db
				.prepare("SELECT metadata FROM messages WHERE id = ?")
				.get(assistantMsgId) as { metadata: string | null };
			const meta = JSON.parse(stamped.metadata ?? "");
			expect(typeof meta.introspect_response_id).toBe("string");
			expect(meta.introspect_response_id).toBe(correlationId);
		});

		it("stamps multiple correlation IDs as array", async () => {
			const turnStartAt = new Date(Date.now() - 5000).toISOString();

			// Multiple introspect requests in same turn
			const correlationId1 = randomUUID();
			const correlationId2 = randomUUID();

			const devMsg1Id = randomUUID();
			insertRow(
				db,
				"messages",
				{
					id: devMsg1Id,
					thread_id: targetThreadId,
					role: "developer",
					content: `[Introspect] ${correlationId1}`,
					metadata: JSON.stringify({ introspect_id: correlationId1 }),
					host_origin: "test-host",
					created_at: new Date(Date.now() - 100).toISOString(),
					modified_at: new Date(Date.now() - 100).toISOString(),
					deleted: 0,
				},
				ctx.siteId,
			);

			const devMsg2Id = randomUUID();
			insertRow(
				db,
				"messages",
				{
					id: devMsg2Id,
					thread_id: targetThreadId,
					role: "developer",
					content: `[Introspect] ${correlationId2}`,
					metadata: JSON.stringify({ introspect_id: correlationId2 }),
					host_origin: "test-host",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				ctx.siteId,
			);

			// Single assistant response
			const assistantMsgId = randomUUID();
			insertRow(
				db,
				"messages",
				{
					id: assistantMsgId,
					thread_id: targetThreadId,
					role: "assistant",
					content: "Response to both",
					metadata: null,
					host_origin: "test-host",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				ctx.siteId,
			);

			// Run hook
			await runIntrospectResponseStamp({
				db,
				siteId: ctx.siteId,
				threadId: targetThreadId,
				turnStartAt,
			});

			// Verify stored as array with both IDs
			const stamped = db
				.prepare("SELECT metadata FROM messages WHERE id = ?")
				.get(assistantMsgId) as { metadata: string | null };
			const meta = JSON.parse(stamped.metadata ?? "");
			expect(Array.isArray(meta.introspect_response_id)).toBe(true);
			expect(meta.introspect_response_id).toContain(correlationId1);
			expect(meta.introspect_response_id).toContain(correlationId2);
		});
	});
});
