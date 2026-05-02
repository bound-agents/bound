import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { Subject, firstValueFrom } from "rxjs";
import { type EligibleHost, createRelayOutboxEntry } from "../relay-router";
import { type RelayWaitParams, createRelayWait$ } from "../relay-wait$";

describe("createRelayWait$", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	const siteId = "test-site";
	const threadId = "test-thread";

	beforeAll(() => {
		const tmpDir = mkdtempSync(join(tmpdir(), "relay-wait-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);
		eventBus = new (require("@bound/shared").TypedEventEmitter)();
	});

	afterAll(() => {
		db.close();
	});

	const createHostsAndParams = (hostCount = 1) => {
		const hosts: EligibleHost[] = Array.from({ length: hostCount }, (_, i) => ({
			site_id: `host-${i}`,
			host_name: `host-${i}.test`,
			models: [],
			mcp_tools: [],
		}));

		const outboxEntry = createRelayOutboxEntry(
			hosts[0].site_id,
			siteId,
			"tool_call",
			JSON.stringify({ kind: "tool_call", toolName: "test_tool", args: {} }),
			30_000,
		);
		writeOutbox(db, outboxEntry);

		const params: RelayWaitParams = {
			outboxEntryId: outboxEntry.id,
			toolName: "test_tool",
			toolInput: {},
			eligibleHosts: hosts,
			currentHostIndex: 0,
			currentTurnId: null,
			threadId,
		};

		return { hosts, params, outboxEntryId: outboxEntry.id };
	};

	it("AC2.1: Parses result response and marks processed", async () => {
		const { hosts, params, outboxEntryId } = createHostsAndParams();
		const aborted$ = new Subject<void>();

		// Subscribe to observable
		const promise = firstValueFrom(
			createRelayWait$(
				{
					db,
					eventBus,
					siteId,
					logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
				},
				params,
				aborted$,
			),
			{ defaultValue: "cancelled" },
		);

		// Wait a tick for subscription
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Insert a result response into relay_inbox
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, payload, expires_at, received_at, processed)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			"result-1",
			hosts[0].site_id,
			"result",
			outboxEntryId,
			JSON.stringify({
				stdout: "Success output",
				stderr: "",
				exit_code: 0,
				execution_ms: 1234,
			}),
			new Date(Date.now() + 60000).toISOString(),
			now,
			0,
		);

		// Emit event
		eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

		// Wait for result
		const result = await promise;

		// Verify result content
		expect(result).toContain("Success output");

		// Verify marked processed
		const marked = db.prepare("SELECT processed FROM relay_inbox WHERE id = ?").get("result-1") as {
			processed: number;
		};
		expect(marked.processed).toBe(1);
	});

	it("AC2.2: Records relay metrics when turnId provided", async () => {
		const { hosts, params, outboxEntryId } = createHostsAndParams();
		const turnId = "turn-123";
		const modifiedParams: RelayWaitParams = { ...params, currentTurnId: turnId };

		// Create turns entry directly
		const turnCreatedAt = new Date().toISOString();
		db.prepare(`
			INSERT INTO turns (id, thread_id, model_id, tokens_in, tokens_out, cost_usd, created_at, relay_target, relay_latency_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(turnId, threadId, "test-model", 1000, 500, 0.01, turnCreatedAt, null, null);

		const aborted$ = new Subject<void>();

		const promise = firstValueFrom(
			createRelayWait$(
				{
					db,
					eventBus,
					siteId,
					logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
				},
				modifiedParams,
				aborted$,
			),
			{ defaultValue: "cancelled" },
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Insert result
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, payload, expires_at, received_at, processed)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			"result-2",
			hosts[0].site_id,
			"result",
			outboxEntryId,
			JSON.stringify({
				stdout: "ok",
				stderr: "",
				exit_code: 0,
				execution_ms: 100,
			}),
			new Date(Date.now() + 60000).toISOString(),
			now,
			0,
		);

		eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

		await promise;

		// Verify metrics recorded
		const turn = db
			.prepare("SELECT relay_target, relay_latency_ms FROM turns WHERE id = ?")
			.get(turnId) as {
			relay_target: string | null;
			relay_latency_ms: number | null;
		};
		expect(turn.relay_target).toBe("host-0.test");
		expect(turn.relay_latency_ms).toBeGreaterThanOrEqual(0);
	});

	it("AC2.3: Handles error response correctly", async () => {
		const { hosts, params, outboxEntryId } = createHostsAndParams();
		const aborted$ = new Subject<void>();

		const promise = firstValueFrom(
			createRelayWait$(
				{
					db,
					eventBus,
					siteId,
					logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
				},
				params,
				aborted$,
			),
			{ defaultValue: "cancelled" },
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Insert error response
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, payload, expires_at, received_at, processed)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			"error-1",
			hosts[0].site_id,
			"error",
			outboxEntryId,
			JSON.stringify({
				error: "model overloaded",
				retriable: true,
			}),
			new Date(Date.now() + 60000).toISOString(),
			now,
			0,
		);

		eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

		const result = await promise;

		// Should contain error message
		expect(result).toContain("Remote error");
		expect(result).toContain("model overloaded");
	});

	it("AC2.4: Handles timeout and failover to next host", async () => {
		const { params: baseParams } = createHostsAndParams(2);
		const aborted$ = new Subject<void>();

		// Run with short timeout for testing
		const promise = firstValueFrom(
			createRelayWait$(
				{
					db,
					eventBus,
					siteId,
					logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
				},
				baseParams,
				aborted$,
				{ timeoutMs: 50 },
			),
			{ defaultValue: "cancelled" },
		);

		// Let first host timeout
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Now send result for second host
		// Query the new outbox entry created for second host
		const outboxEntries = db
			.prepare("SELECT id, target_site_id FROM relay_outbox WHERE kind = 'tool_call'")
			.all() as Array<{
			id: string;
			target_site_id: string;
		}>;
		const secondHostOutboxId = outboxEntries.find((e) => e.target_site_id === "host-1")?.id;
		expect(secondHostOutboxId).toBeDefined();

		if (secondHostOutboxId) {
			const now = new Date().toISOString();
			db.prepare(`
				INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, payload, expires_at, received_at, processed)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				"result-failover",
				"host-1",
				"result",
				secondHostOutboxId,
				JSON.stringify({
					stdout: "failover success",
					stderr: "",
					exit_code: 0,
					execution_ms: 100,
				}),
				new Date(Date.now() + 60000).toISOString(),
				now,
				0,
			);

			eventBus.emit("relay:inbox", { ref_id: secondHostOutboxId });
		}

		const result = await promise;
		expect(result).toContain("failover success");
	});

	it("AC2.5: Cancellation via aborted$ writes cancel entry", async () => {
		const { params, outboxEntryId } = createHostsAndParams();
		const aborted$ = new Subject<void>();

		const promise = firstValueFrom(
			createRelayWait$(
				{
					db,
					eventBus,
					siteId,
					logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
				},
				params,
				aborted$,
			),
			{ defaultValue: "default-cancel" },
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Emit abort
		aborted$.next();
		aborted$.complete();

		const result = await promise;

		// Should get the cancelled message
		expect(result).toContain("Cancelled");

		// Verify cancel outbox entry was written
		const cancelEntry = db
			.prepare("SELECT kind, ref_id FROM relay_outbox WHERE kind = 'cancel' AND ref_id = ?")
			.get(outboxEntryId) as { kind: string; ref_id: string } | undefined;
		expect(cancelEntry).toBeDefined();
		expect(cancelEntry?.kind).toBe("cancel");
	});

	it("Race condition: Response already in DB before subscribe", async () => {
		const { hosts, params, outboxEntryId } = createHostsAndParams();
		const aborted$ = new Subject<void>();

		// Insert response BEFORE subscribing
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, payload, expires_at, received_at, processed)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			"result-pre",
			hosts[0].site_id,
			"result",
			outboxEntryId,
			JSON.stringify({
				stdout: "pre-response",
				stderr: "",
				exit_code: 0,
				execution_ms: 50,
			}),
			new Date(Date.now() + 60000).toISOString(),
			now,
			0,
		);

		// Now subscribe
		const promise = firstValueFrom(
			createRelayWait$(
				{
					db,
					eventBus,
					siteId,
					logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
				},
				params,
				aborted$,
			),
			{ defaultValue: "cancelled" },
		);

		// Should get result immediately
		const result = await promise;
		expect(result).toContain("pre-response");
	});

	it("All hosts exhausted returns timeout message", async () => {
		const { params: baseParams } = createHostsAndParams(2);
		const aborted$ = new Subject<void>();

		const promise = firstValueFrom(
			createRelayWait$(
				{
					db,
					eventBus,
					siteId,
					logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
				},
				baseParams,
				aborted$,
				{ timeoutMs: 50 },
			),
			{ defaultValue: "not-timed-out" },
		);

		// Wait for all hosts to timeout
		await new Promise((resolve) => setTimeout(resolve, 150));

		const result = await promise;

		// Should get timeout message, not "not-timed-out" default
		expect(result).toContain("Timeout");
		expect(result).toContain("2 eligible host(s)");
	});
});
