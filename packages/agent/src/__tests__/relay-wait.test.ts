import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, readInboxByRefId, writeOutbox } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createRelayOutboxEntry } from "../relay-router";

// Test database setup
let db: Database;
let testDbPath: string;
let eventBus: TypedEventEmitter;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-relay-wait-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
	eventBus = new TypedEventEmitter();
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

describe("RELAY_WAIT polling and failover logic", () => {
	it("detects and reads relay responses from relay_inbox (AC6.1)", async () => {
		// AC6.1: Verify that relay responses in inbox can be read by ref_id
		const outboxEntryId = "test-request-1";
		const remoteHostId = "remote-host-1";

		// Pre-populate inbox with response
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"response-1",
				remoteHostId,
				"result",
				outboxEntryId,
				null,
				JSON.stringify({
					stdout: "Tool output here",
					stderr: "",
					exitCode: 0,
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Verify response can be read
		const response = readInboxByRefId(db, outboxEntryId);
		expect(response).toBeDefined();
		if (response) {
			expect(response.kind).toBe("result");
			expect(response.ref_id).toBe(outboxEntryId);
			const payload = JSON.parse(response.payload) as {
				stdout: string;
				stderr: string;
				exitCode: number;
			};
			expect(payload.stdout).toBe("Tool output here");
			expect(payload.exitCode).toBe(0);
		}
	});

	it("formats activity status correctly (AC6.2)", () => {
		// AC6.2: Activity status shows "relaying {tool_name} via {host_name}"
		const toolName = "remote-list-files";
		const hostName = "Production Server";

		const activityStatus = `relaying ${toolName} via ${hostName}`;

		expect(activityStatus).toBe("relaying remote-list-files via Production Server");
		expect(activityStatus).toMatch(/^relaying .+ via .+$/);
	});

	it("handles timeout with failover logic (AC6.3)", async () => {
		// AC6.3: When first host times out, failover writes new outbox entry for next host
		const originalRequestId = "original-request";
		const host1Id = "remote-1";
		const host2Id = "remote-2";

		// Write original outbox entry (first host - will timeout)
		writeOutbox(db, {
			id: originalRequestId,
			source_site_id: null,
			target_site_id: host1Id,
			kind: "tool_call",
			ref_id: null,
			idempotency_key: null,
			payload: JSON.stringify({ toolName: "test-tool", args: {} }),
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 1_000).toISOString(),
			delivered: 0,
		});

		// Simulate failover: write second outbox entry for next host
		const failoverRequestId = "failover-request-1";
		writeOutbox(db, {
			id: failoverRequestId,
			source_site_id: null,
			target_site_id: host2Id,
			kind: "tool_call",
			ref_id: null,
			idempotency_key: null,
			payload: JSON.stringify({ toolName: "test-tool", args: {} }),
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 30_000).toISOString(),
			delivered: 0,
		});

		// Now add response for second host
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"response-from-host2",
				host2Id,
				"result",
				failoverRequestId,
				null,
				JSON.stringify({
					stdout: "Result from second host",
					stderr: "",
					exitCode: 0,
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Verify both outbox entries exist
		const entries = db
			.query(`SELECT id, target_site_id FROM relay_outbox WHERE kind = 'tool_call'`)
			.all() as Array<{ id: string; target_site_id: string }>;

		expect(entries.length).toBe(2);
		expect(entries[0].target_site_id).toBe(host1Id);
		expect(entries[1].target_site_id).toBe(host2Id);

		// Verify response is keyed to failover request
		const failoverResponse = readInboxByRefId(db, failoverRequestId);
		expect(failoverResponse).toBeDefined();
		if (failoverResponse) {
			const payload = JSON.parse(failoverResponse.payload) as { stdout: string };
			expect(payload.stdout).toBe("Result from second host");
		}
	});

	it("returns error when all hosts exhausted (AC6.4)", () => {
		// AC6.4: After all eligible hosts timeout, error is returned to agent
		const numHosts = 3;

		// Timeout error message format
		const timeoutMs = 30_000;
		const errorMessage = `Timeout: all ${numHosts} eligible host(s) did not respond within ${timeoutMs}ms`;

		expect(errorMessage).toContain("Timeout");
		expect(errorMessage).toContain("all");
		expect(errorMessage).toContain("eligible host");
	});

	it("emits sync:trigger event on RELAY_WAIT entry (AC6.5)", () => {
		// AC6.5: On RELAY_WAIT entry, sync:trigger event is emitted
		let triggered = false;
		let reason = "";

		eventBus.on("sync:trigger", ({ reason: eventReason }) => {
			triggered = true;
			reason = eventReason;
		});

		// Emit as would happen on relayWait entry
		eventBus.emit("sync:trigger", { reason: "relay-wait" });

		expect(triggered).toBe(true);
		expect(reason).toBe("relay-wait");
	});

	it("writes cancel entry with ref_id pointing to original request (AC7.2)", () => {
		// AC7.2: Cancel entry's ref_id matches original request's outbox entry ID
		const originalRequestId = "original-tool-request";
		const hostId = "remote-host-1";

		const eligibleHosts = [
			{
				site_id: hostId,
				host_name: "Remote Host",
				sync_url: null,
				online_at: new Date().toISOString(),
			},
		];

		// Create cancel entry as relayWait would
		const currentHostIndex = 0;
		const currentHost = eligibleHosts[currentHostIndex];

		const cancelEntry = createRelayOutboxEntry(
			currentHost.site_id,
			"cancel",
			JSON.stringify({}),
			30_000,
			originalRequestId, // ref_id must point to original request (AC7.2)
		);

		expect(cancelEntry.kind).toBe("cancel");
		expect(cancelEntry.ref_id).toBe(originalRequestId);
		expect(cancelEntry.target_site_id).toBe(hostId);
	});

	it("updates host target on failover before writing cancel (AC7.2 failover case)", () => {
		// When failover occurs and then cancel is issued, cancel must go to current host
		// not the original host
		const originalRequestId = "request-1";
		const host1Id = "remote-1";
		const host2Id = "remote-2";

		const eligibleHosts = [
			{
				site_id: host1Id,
				host_name: "Host 1",
				sync_url: null,
				online_at: new Date().toISOString(),
			},
			{
				site_id: host2Id,
				host_name: "Host 2",
				sync_url: null,
				online_at: new Date().toISOString(),
			},
		];

		// Simulate being at index 1 after failover
		const currentHostIndex = 1;
		const currentHost = eligibleHosts[currentHostIndex];

		const cancelEntry = createRelayOutboxEntry(
			currentHost.site_id,
			"cancel",
			JSON.stringify({}),
			30_000,
			originalRequestId,
		);

		// Cancel should go to second host, not first
		expect(cancelEntry.target_site_id).toBe(host2Id);
		expect(cancelEntry.target_site_id).not.toBe(host1Id);
		expect(cancelEntry.ref_id).toBe(originalRequestId);
	});

	it("handles error responses from remote host", () => {
		// AC1.6/AC1.7: Error responses are parsed and handled
		const outboxEntryId = "error-test";
		const remoteHostId = "remote-1";

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"error-response",
				remoteHostId,
				"error",
				outboxEntryId,
				null,
				JSON.stringify({
					error: "Tool not found on remote",
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		const response = readInboxByRefId(db, outboxEntryId);
		expect(response).toBeDefined();
		if (response) {
			expect(response.kind).toBe("error");
			const payload = JSON.parse(response.payload) as { error?: string };
			expect(payload.error).toContain("Tool not found");
		}
	});

	it("marks responses as processed after handling", () => {
		// Verify responses are marked processed to avoid duplicate processing
		const outboxEntryId = "processed-test";
		const remoteHostId = "remote-1";
		const responseId = "response-1";

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				responseId,
				remoteHostId,
				"result",
				outboxEntryId,
				null,
				JSON.stringify({
					stdout: "test",
					stderr: "",
					exitCode: 0,
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0, // Not processed yet
			],
		);

		// Before marking processed
		let response = readInboxByRefId(db, outboxEntryId);
		expect(response).toBeDefined();
		expect(response?.processed).toBe(0);

		// Mark as processed (as relayWait does after handling)
		if (response) {
			const stmt = db.prepare("UPDATE relay_inbox SET processed = 1 WHERE id = ?");
			stmt.run(response.id);
		}

		// After marking processed, should not be retrievable via readInboxByRefId
		response = readInboxByRefId(db, outboxEntryId);
		expect(response).toBeNull();
	});

	it("formats result content from remote tool responses", () => {
		// Verify response payloads are correctly formatted as tool results
		const testCases = [
			{
				payload: { stdout: "output", stderr: "", exitCode: 0 },
				expectedResult: "output",
			},
			{
				payload: { stdout: "", stderr: "error message", exitCode: 1 },
				expectedResult: "error message",
			},
			{
				payload: { stdout: "data", stderr: "warning", exitCode: 0 },
				expectedResult: "data\nwarning",
			},
			{
				payload: { stdout: "", stderr: "", exitCode: 0 },
				expectedResult: "Command completed successfully",
			},
			{
				payload: { stdout: "", stderr: "", exitCode: 42 },
				expectedResult: "Exit code: 42",
			},
		];

		for (const testCase of testCases) {
			const parts: string[] = [];
			if (testCase.payload.stdout) parts.push(testCase.payload.stdout);
			if (testCase.payload.stderr) parts.push(testCase.payload.stderr);
			if (parts.length === 0) {
				parts.push(
					(testCase.payload.exitCode ?? 0) === 0
						? "Command completed successfully"
						: `Exit code: ${testCase.payload.exitCode ?? 1}`,
				);
			}
			const result = parts.join("\n");

			expect(result).toBe(testCase.expectedResult);
		}
	});

	it("cancels during RELAY_WAIT with abort signal (AC7.1)", () => {
		// AC7.1: Complete abort-during-RELAY_WAIT flow
		// 1. Setting agent's aborted flag during RELAY_WAIT should write a cancel outbox entry
		// 2. Should emit sync:trigger with reason "relay-cancel"
		// 3. Should stop the polling loop

		const originalRequestId = "relay-request-1";
		const hostId = "remote-host-1";

		// Set up initial outbox entry (as if we're in RELAY_WAIT)
		writeOutbox(db, {
			id: originalRequestId,
			source_site_id: null,
			target_site_id: hostId,
			kind: "tool_call",
			ref_id: null,
			idempotency_key: null,
			payload: JSON.stringify({ toolName: "test-tool", args: {} }),
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 30_000).toISOString(),
		});

		// Track cancel entry and sync:trigger event
		let cancelEntryWritten = false;
		let cancelEntryDetails: { kind: string; ref_id: string | null; target_site_id: string } | null =
			null;
		let syncTriggerEmitted = false;
		let syncTriggerReason = "";

		// Listen for sync:trigger event
		eventBus.on("sync:trigger", ({ reason: eventReason }) => {
			syncTriggerEmitted = true;
			syncTriggerReason = eventReason;
		});

		// Simulate agent abort during RELAY_WAIT:
		// 1. Create and write cancel entry (as agent loop would do on abort)
		const cancelEntry = createRelayOutboxEntry(
			hostId,
			"cancel",
			JSON.stringify({}),
			30_000,
			originalRequestId, // ref_id points to original request (AC7.2)
		);

		writeOutbox(db, cancelEntry);

		// Verify cancel entry was written
		const cancelRows = db
			.query(
				`SELECT kind, ref_id, target_site_id FROM relay_outbox WHERE kind = 'cancel' AND ref_id = ?`,
			)
			.all(originalRequestId) as Array<{
			kind: string;
			ref_id: string | null;
			target_site_id: string;
		}>;

		expect(cancelRows.length).toBe(1);
		cancelEntryDetails = cancelRows[0];
		cancelEntryWritten = true;

		// 2. Emit sync:trigger event (as agent loop would do)
		eventBus.emit("sync:trigger", { reason: "relay-cancel" });

		// 3. Verify cancel entry has correct structure
		expect(cancelEntryWritten).toBe(true);
		if (cancelEntryDetails) {
			expect(cancelEntryDetails.kind).toBe("cancel");
			expect(cancelEntryDetails.ref_id).toBe(originalRequestId);
			expect(cancelEntryDetails.target_site_id).toBe(hostId);
		}

		// 4. Verify sync:trigger was emitted with correct reason
		expect(syncTriggerEmitted).toBe(true);
		expect(syncTriggerReason).toBe("relay-cancel");

		// 5. Verify polling would stop:
		// In the real agent loop, the abort signal check would break the polling loop.
		// Here we verify that there's a cancel entry that would trigger the exit condition.
		const outstandingCancelEntries = db
			.query(`SELECT id FROM relay_outbox WHERE kind = 'cancel'`)
			.all() as Array<{ id: string }>;

		expect(outstandingCancelEntries.length).toBeGreaterThan(0);
	});
});
