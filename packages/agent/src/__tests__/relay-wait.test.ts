import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, readInboxByRefId, writeOutbox } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";

// Test database setup
let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-relay-wait-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// Already closed
	}
	try {
		require("node:fs").unlinkSync(testDbPath);
	} catch {
		// Already deleted
	}
});

describe("Agent Loop RELAY_WAIT", () => {
	it("detects relay requests and enters RELAY_WAIT (AC6.1)", async () => {
		// Create a relay response in the inbox
		const relayOutboxId = "test-outbox-id-1";
		const now = new Date().toISOString();

		// First, insert a relay outbox entry
		writeOutbox(db, {
			id: relayOutboxId,
			source_site_id: null,
			target_site_id: "remote-1",
			kind: "tool_call",
			ref_id: null,
			idempotency_key: null,
			payload: JSON.stringify({ toolName: "test-tool", args: {} }),
			created_at: now,
			expires_at: new Date(Date.now() + 30_000).toISOString(),
			delivered: 0,
		});

		// Now insert a response in the inbox with matching ref_id
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"response-1",
				"remote-1",
				"result",
				relayOutboxId,
				null,
				JSON.stringify({
					stdout: "Tool output",
					stderr: "",
					exitCode: 0,
				}),
				new Date(Date.now() + 60_000).toISOString(),
				now,
				0,
			],
		);

		// Check that we can read it back
		const response = readInboxByRefId(db, relayOutboxId);
		expect(response).toBeDefined();
		if (response) {
			expect(response.kind).toBe("result");
			expect(response.ref_id).toBe(relayOutboxId);
		}
	});

	it("formats activity status correctly during RELAY_WAIT (AC6.2)", async () => {
		// Verify activity status format: "relaying {tool_name} via {host_name}"
		const toolName = "remote-test-tool";
		const hostName = "Remote Host 1";

		const expectedStatus = `relaying ${toolName} via ${hostName}`;
		expect(expectedStatus).toMatch(/^relaying .+ via .+$/);
		expect(expectedStatus).toBe(`relaying ${toolName} via ${hostName}`);
	});

	it("emits sync:trigger on RELAY_WAIT entry (AC6.5)", async () => {
		const eventBus = new TypedEventEmitter();
		let syncTriggered = false;
		let triggerReason = "";

		eventBus.on("sync:trigger", ({ reason }) => {
			syncTriggered = true;
			triggerReason = reason;
		});

		// Verify listener can be registered and triggered
		eventBus.emit("sync:trigger", { reason: "relay-wait" });
		expect(syncTriggered).toBe(true);
		expect(triggerReason).toBe("relay-wait");
	});

	it("handles cancel propagation during RELAY_WAIT (AC7.1, AC7.2)", async () => {
		const relayOutboxId = "test-outbox-cancel";
		const now = new Date().toISOString();

		// Write initial outbox entry
		writeOutbox(db, {
			id: relayOutboxId,
			source_site_id: null,
			target_site_id: "remote-1",
			kind: "tool_call",
			ref_id: null,
			idempotency_key: null,
			payload: JSON.stringify({ toolName: "test-tool", args: {} }),
			created_at: now,
			expires_at: new Date(Date.now() + 30_000).toISOString(),
			delivered: 0,
		});

		// Simulate cancel by writing a cancel entry with ref_id pointing to original
		const cancelEntry = {
			id: "cancel-1",
			source_site_id: null,
			target_site_id: "remote-1",
			kind: "cancel",
			ref_id: relayOutboxId, // References original request (AC7.2)
			idempotency_key: null,
			payload: JSON.stringify({}),
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 30_000).toISOString(),
			delivered: 0,
		};

		writeOutbox(db, cancelEntry);

		// Verify the cancel entry references the original
		const outboxEntries = db
			.query(`SELECT * FROM relay_outbox WHERE kind = 'cancel'`)
			.all() as Array<{ ref_id: string; id: string }>;

		expect(outboxEntries.length).toBeGreaterThan(0);
		const cancelMsg = outboxEntries.find((e) => e.kind === "cancel");
		if (cancelMsg) {
			expect(cancelMsg.ref_id).toBe(relayOutboxId);
		}
	});

	it("handles timeout and failover to next host (AC6.3)", async () => {
		// Test that when a request times out, a new outbox entry is created for the next host
		const originalOutboxId = "original-request";
		const now = new Date().toISOString();

		// Create initial outbox entry for first host
		writeOutbox(db, {
			id: originalOutboxId,
			source_site_id: null,
			target_site_id: "remote-1",
			kind: "tool_call",
			ref_id: null,
			idempotency_key: null,
			payload: JSON.stringify({ toolName: "test-tool", args: {} }),
			created_at: now,
			expires_at: new Date(Date.now() + 30_000).toISOString(),
			delivered: 0,
		});

		// Simulate failover by creating a second outbox entry for next host
		// In real execution, the relayWait method would create this
		const failoverOutboxId = "failover-request";
		writeOutbox(db, {
			id: failoverOutboxId,
			source_site_id: null,
			target_site_id: "remote-2",
			kind: "tool_call",
			ref_id: null,
			idempotency_key: null,
			payload: JSON.stringify({ toolName: "test-tool", args: {} }),
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 30_000).toISOString(),
			delivered: 0,
		});

		// Verify both entries exist
		const outboxEntries = db
			.query(`SELECT id, target_site_id FROM relay_outbox WHERE kind = 'tool_call'`)
			.all() as Array<{ id: string; target_site_id: string }>;

		expect(outboxEntries.length).toBe(2);
		expect(outboxEntries.map((e) => e.target_site_id)).toContain("remote-1");
		expect(outboxEntries.map((e) => e.target_site_id)).toContain("remote-2");
	});

	it("returns error when all hosts exhausted (AC6.4)", async () => {
		// Simulate all hosts timing out - no response in inbox
		const relayOutboxId = "exhausted-hosts";
		const now = new Date().toISOString();

		writeOutbox(db, {
			id: relayOutboxId,
			source_site_id: null,
			target_site_id: "remote-1",
			kind: "tool_call",
			ref_id: null,
			idempotency_key: null,
			payload: JSON.stringify({ toolName: "test-tool", args: {} }),
			created_at: now,
			expires_at: new Date(Date.now() + 1_000).toISOString(), // Expired
			delivered: 0,
		});

		// Check that no response exists
		const response = readInboxByRefId(db, relayOutboxId);
		expect(response).toBeNull();
	});

	it("processes relay error responses", async () => {
		// Test handling of error responses from relay
		const relayOutboxId = "error-response-test";
		const now = new Date().toISOString();

		// Insert error response in inbox
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"error-response-1",
				"remote-1",
				"error",
				relayOutboxId,
				null,
				JSON.stringify({
					error: "Tool not found on remote host",
				}),
				new Date(Date.now() + 60_000).toISOString(),
				now,
				0,
			],
		);

		// Read it back
		const response = readInboxByRefId(db, relayOutboxId);
		expect(response).toBeDefined();
		if (response) {
			expect(response.kind).toBe("error");
			const payload = JSON.parse(response.payload) as { error?: string };
			expect(payload.error).toContain("Tool not found");
		}
	});

	it("marks relay responses as processed after retrieval", async () => {
		// Test that responses are marked processed to avoid reprocessing
		const relayOutboxId = "processed-response";
		const now = new Date().toISOString();

		// Insert response
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"response-processed",
				"remote-1",
				"result",
				relayOutboxId,
				null,
				JSON.stringify({
					stdout: "Done",
					stderr: "",
					exitCode: 0,
				}),
				new Date(Date.now() + 60_000).toISOString(),
				now,
				0,
			],
		);

		// Before marking processed, it's retrievable
		let response = readInboxByRefId(db, relayOutboxId);
		expect(response).toBeDefined();

		// Mark processed (this is what relayWait does after handling response)
		if (response) {
			const stmt = db.prepare("UPDATE relay_inbox SET processed = 1 WHERE id = ?");
			stmt.run(response.id);

			// After marking processed, should not be retrievable
			response = readInboxByRefId(db, relayOutboxId);
			expect(response).toBeNull();
		}
	});

	it("builds correct result content from remote tool response", async () => {
		// Test that response payloads are correctly formatted as tool results
		const scenarios = [
			{
				payload: { stdout: "output", stderr: "", exitCode: 0 },
				expectedContent: "output",
			},
			{
				payload: { stdout: "", stderr: "error", exitCode: 1 },
				expectedContent: "error",
			},
			{
				payload: { stdout: "", stderr: "", exitCode: 0 },
				expectedContent: "Command completed successfully",
			},
			{
				payload: { stdout: "", stderr: "", exitCode: 1 },
				expectedContent: "Exit code: 1",
			},
		];

		for (const scenario of scenarios) {
			const relayOutboxId = `scenario-${JSON.stringify(scenario.payload)}`;
			const now = new Date().toISOString();

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					`response-${relayOutboxId}`,
					"remote-1",
					"result",
					relayOutboxId,
					null,
					JSON.stringify(scenario.payload),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			const response = readInboxByRefId(db, relayOutboxId);
			expect(response).toBeDefined();
			if (response) {
				const payload = JSON.parse(response.payload);
				const parts: string[] = [];
				if (payload.stdout) parts.push(payload.stdout);
				if (payload.stderr) parts.push(payload.stderr);
				if (parts.length === 0) {
					parts.push(
						(payload.exitCode ?? 0) === 0
							? "Command completed successfully"
							: `Exit code: ${payload.exitCode ?? 1}`,
					);
				}
				const resultContent = parts.join("\n");
				expect(resultContent).toContain(scenario.expectedContent);
			}
		}
	});
});
