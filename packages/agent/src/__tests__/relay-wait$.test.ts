import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acknowledgeDurableWork,
	applyMetricsSchema,
	applySchema,
	claimDurableWorkByIds,
	createDatabase,
	resetProcessingDurableWork,
} from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { Subject, firstValueFrom } from "rxjs";
import type { EligibleHost } from "../relay-router";
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

	beforeEach(() => {
		db.exec("DELETE FROM durable_work");
	});

	// Post-N+1 the relay path is durable-only. A tool_call request rides a
	// durable_work row; the awaiter (createRelayWait$ → readUnionResponseEntry)
	// resolves from a durable response row keyed by the request's ref_id and
	// consumes it exactly-once via the token-fenced claim/ack lifecycle.
	function insertDurableRequest(opts: {
		id: string;
		kind: string;
		targetSiteId: string;
	}): void {
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO durable_work
			(id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, source_site)
			VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
		`).run(
			opts.id,
			opts.targetSiteId,
			opts.kind,
			JSON.stringify({ kind: opts.kind, toolName: "test_tool", args: {} }),
			opts.id,
			now,
			new Date(Date.now() + 30_000).toISOString(),
			siteId,
		);
	}

	function insertDurableResponse(opts: {
		id: string;
		kind: string;
		refId: string;
		payload: unknown;
	}): void {
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO durable_work
			(id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, ref_id, source_site)
			VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
		`).run(
			opts.id,
			siteId,
			opts.kind,
			JSON.stringify(opts.payload),
			`response:${opts.refId}`,
			now,
			opts.refId,
			"host-0",
		);
	}

	const createHostsAndParams = (hostCount = 1) => {
		const hosts: EligibleHost[] = Array.from({ length: hostCount }, (_, i) => ({
			site_id: `host-${i}`,
			host_name: `host-${i}.test`,
			models: [],
			mcp_tools: [],
		}));

		// The failover/cancel paths route through routeRelayRequest, which requires
		// the target host to advertise work_spool_capable in the hosts table.
		const now = new Date().toISOString();
		for (const host of hosts) {
			db.prepare(
				"INSERT OR IGNORE INTO hosts (site_id, host_name, online_at, modified_at, deleted, work_spool_capable) VALUES (?, ?, ?, ?, 0, 1)",
			).run(host.site_id, host.host_name, now, now);
		}

		const outboxEntryId = `req-${Math.random().toString(36).slice(2)}`;
		insertDurableRequest({ id: outboxEntryId, kind: "tool_call", targetSiteId: hosts[0].site_id });

		const params: RelayWaitParams = {
			outboxEntryId,
			toolName: "test_tool",
			toolInput: {},
			eligibleHosts: hosts,
			currentHostIndex: 0,
			currentTurnId: null,
			threadId,
		};

		return { hosts, params, outboxEntryId };
	};

	it("AC2.1: Parses result response and marks processed", async () => {
		const { params, outboxEntryId } = createHostsAndParams();
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
			{ defaultValue: { content: "cancelled", retriable: false } },
		);

		// Wait a tick for subscription
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Insert a result response as a durable_work row keyed by the request ref_id
		insertDurableResponse({
			id: "result-1",
			kind: "result",
			refId: outboxEntryId,
			payload: {
				stdout: "Success output",
				stderr: "",
				exit_code: 0,
				execution_ms: 1234,
			},
		});

		// Emit event
		eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

		// Wait for result
		const result = await promise;

		// Verify result content
		expect(result.content).toContain("Success output");

		// Verify the durable response row was consumed exactly-once
		const marked = db
			.prepare("SELECT claim_state FROM durable_work WHERE id = ?")
			.get("result-1") as {
			claim_state: string;
		};
		expect(marked.claim_state).toBe("consumed");
	});

	it("AC2.2: Records relay metrics when turnId provided", async () => {
		const { params, outboxEntryId } = createHostsAndParams();
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
			{ defaultValue: { content: "cancelled", retriable: false } },
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Insert result as a durable_work response row
		insertDurableResponse({
			id: "result-2",
			kind: "result",
			refId: outboxEntryId,
			payload: {
				stdout: "ok",
				stderr: "",
				exit_code: 0,
				execution_ms: 100,
			},
		});

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
			{ defaultValue: { content: "cancelled", retriable: false } },
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Insert error response as a durable_work response row
		insertDurableResponse({
			id: "error-1",
			kind: "error",
			refId: outboxEntryId,
			payload: {
				error: "model overloaded",
				retriable: true,
			},
		});

		eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

		const result = await promise;

		// Should contain error message
		expect(result.content).toContain("Remote error");
		expect(result.content).toContain("model overloaded");
		// retriable signal should propagate from ErrorPayload through to the consumer
		expect(result.retriable).toBe(true);
	});

	it("propagates retriable=false for non-retriable error responses", async () => {
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
			{ defaultValue: { content: "cancelled", retriable: false } },
		);

		insertDurableResponse({
			id: "error-2",
			kind: "error",
			refId: outboxEntryId,
			payload: {
				error: "tool not found",
				retriable: false,
			},
		});

		eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

		const result = await promise;
		expect(result.content).toContain("tool not found");
		expect(result.retriable).toBe(false);
	});

	it("propagates definitely_not_executed=true from hub fast-fail errors", async () => {
		// Hub fast-fail synthesizes a kind=error response when the target spoke
		// is offline. The hub sets definitely_not_executed=true so the agent
		// loop knows the target tool never ran and can retry safely regardless
		// of the tool's idempotency.
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
			{ defaultValue: { content: "cancelled", retriable: false } },
		);

		insertDurableResponse({
			id: "error-fast-fail",
			kind: "error",
			refId: outboxEntryId,
			payload: {
				error: "Target host site-target is not currently connected",
				retriable: true,
				definitely_not_executed: true,
			},
		});

		eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

		const result = await promise;
		expect(result.content).toContain("not currently connected");
		expect(result.retriable).toBe(true);
		expect(result.definitely_not_executed).toBe(true);
	});

	it("leaves definitely_not_executed undefined for ambiguous errors and timeouts", async () => {
		// Target-side errors and full-timeout errors don't carry the attestation
		// — the target may have started executing before the failure surfaced.
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
			{ defaultValue: { content: "cancelled", retriable: false } },
		);

		insertDurableResponse({
			id: "error-ambiguous",
			kind: "error",
			refId: outboxEntryId,
			payload: {
				error: "model overloaded mid-execution",
				retriable: true,
				// definitely_not_executed intentionally omitted
			},
		});

		eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

		const result = await promise;
		expect(result.retriable).toBe(true);
		expect(result.definitely_not_executed).toBeUndefined();
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
			{ defaultValue: { content: "cancelled", retriable: false } },
		);

		// Let first host timeout
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Now send result for second host
		// Query the new durable request row created for the second host
		const outboxEntries = db
			.prepare("SELECT id, target_site_id FROM durable_work WHERE kind = 'tool_call'")
			.all() as Array<{
			id: string;
			target_site_id: string;
		}>;
		const secondHostOutboxId = outboxEntries.find((e) => e.target_site_id === "host-1")?.id;
		expect(secondHostOutboxId).toBeDefined();

		if (secondHostOutboxId) {
			insertDurableResponse({
				id: "result-failover",
				kind: "result",
				refId: secondHostOutboxId,
				payload: {
					stdout: "failover success",
					stderr: "",
					exit_code: 0,
					execution_ms: 100,
				},
			});

			eventBus.emit("relay:inbox", { ref_id: secondHostOutboxId });
		}

		const result = await promise;
		expect(result.content).toContain("failover success");
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
			{ defaultValue: { content: "default-cancel", retriable: false } },
		);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Emit abort
		aborted$.next();
		aborted$.complete();

		const result = await promise;

		// Should get the cancelled message
		expect(result.content).toContain("Cancelled");

		// Verify a durable cancel row was written for the request
		const cancelEntry = db
			.prepare("SELECT kind, ref_id FROM durable_work WHERE kind = 'cancel' AND ref_id = ?")
			.get(outboxEntryId) as { kind: string; ref_id: string } | undefined;
		expect(cancelEntry).toBeDefined();
		expect(cancelEntry?.kind).toBe("cancel");
	});

	it("Race condition: Response already in DB before subscribe", async () => {
		const { params, outboxEntryId } = createHostsAndParams();
		const aborted$ = new Subject<void>();

		// Insert response BEFORE subscribing, as a durable_work response row
		insertDurableResponse({
			id: "result-pre",
			kind: "result",
			refId: outboxEntryId,
			payload: {
				stdout: "pre-response",
				stderr: "",
				exit_code: 0,
				execution_ms: 50,
			},
		});

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
			{ defaultValue: { content: "cancelled", retriable: false } },
		);

		// Should get result immediately
		const result = await promise;
		expect(result.content).toContain("pre-response");
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
			{ defaultValue: { content: "not-timed-out", retriable: false } },
		);

		// Wait for all hosts to timeout
		await new Promise((resolve) => setTimeout(resolve, 150));

		const result = await promise;

		// Should get timeout message, not "not-timed-out" default
		expect(result.content).toContain("Timeout");
		expect(result.content).toContain("2 eligible host(s)");
	});

	describe("4D-D union-await (durable response rows)", () => {
		// The awaiter reads the UNION of legacy inbox response rows and pending
		// durable response rows targeted at self, consuming durable rows exactly-once
		// via the token-fenced claim/ack lifecycle.
		function insertDurableResponse(opts: {
			id: string;
			kind: string;
			refId: string;
			payload: unknown;
		}): void {
			const now = new Date().toISOString();
			db.prepare(`
				INSERT INTO durable_work
				(id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, ref_id, source_site)
				VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
			`).run(
				opts.id,
				siteId,
				opts.kind,
				JSON.stringify(opts.payload),
				`response:${opts.refId}`,
				now,
				opts.refId,
				"host-0",
			);
		}

		function durableRowState(id: string): string | undefined {
			return (
				db.prepare("SELECT claim_state FROM durable_work WHERE id = ?").get(id) as {
					claim_state: string;
				} | null
			)?.claim_state;
		}

		it("resolves the awaiter from a durable result row and consumes it", async () => {
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
				{ defaultValue: { content: "cancelled", retriable: false } },
			);
			await new Promise((resolve) => setTimeout(resolve, 10));

			insertDurableResponse({
				id: "dur-result-1",
				kind: "result",
				refId: outboxEntryId,
				payload: { stdout: "Durable output", stderr: "", exit_code: 0, execution_ms: 1 },
			});
			eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

			const result = await promise;
			expect(result.content).toContain("Durable output");
			expect(durableRowState("dur-result-1")).toBe("consumed");
		});

		it("does not double-resolve when a duplicate durable row is present (exactly-once consume)", async () => {
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
				{ defaultValue: { content: "cancelled", retriable: false } },
			);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// One logical response, one row (a redelivered transfer is fenced upstream to
			// the SAME row). The awaiter must resolve once and consume it.
			insertDurableResponse({
				id: "dur-result-2",
				kind: "result",
				refId: outboxEntryId,
				payload: { stdout: "Once", stderr: "", exit_code: 0, execution_ms: 1 },
			});
			eventBus.emit("relay:inbox", { ref_id: outboxEntryId });

			const result = await promise;
			expect(result.content).toContain("Once");
			expect(durableRowState("dur-result-2")).toBe("consumed");
		});

		it("acks a durable response only AFTER delivery, and a crash before ack boot-resets it (no silent loss)", async () => {
			// OBJECTION 1 crash-window: the required order is claim → deliver → ack.
			// readUnionResponse claims the durable row, but the ack is deferred until the
			// awaiter has RECEIVED the value. This test proves the ordering two ways.
			const { params, outboxEntryId } = createHostsAndParams();
			const aborted$ = new Subject<void>();

			// (a) Happy path: on resolution the row is consumed (settle ran post-delivery).
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
				{ defaultValue: { content: "cancelled", retriable: false } },
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			insertDurableResponse({
				id: "dur-crash-1",
				kind: "result",
				refId: outboxEntryId,
				payload: { stdout: "Delivered", stderr: "", exit_code: 0, execution_ms: 1 },
			});
			eventBus.emit("relay:inbox", { ref_id: outboxEntryId });
			const result = await promise;
			// The value reached the awaiter...
			expect(result.content).toContain("Delivered");
			// ...and only THEN was the row acked to consumed.
			expect(durableRowState("dur-crash-1")).toBe("consumed");

			// (b) Crash window: simulate a crash between delivery and ack. A durable row
			// left in 'processing' (claimed, delivery underway, ack lost) is recovered by
			// boot reset back to 'pending' — it is NOT silently consumed, so a later
			// consumer (or the awaiter's own take(1)-completed re-read that finds no
			// subscriber) can still see it. This proves the row survives a mid-delivery
			// crash rather than being retired before the awaiter received the value.
			insertDurableResponse({
				id: "dur-crash-2",
				kind: "result",
				refId: "ref-unattended",
				payload: { stdout: "Unattended", stderr: "", exit_code: 0, execution_ms: 1 },
			});
			// Claim it (delivery would happen now) but DO NOT ack — the crash point.
			const claimed = claimDurableWorkByIds(db, ["dur-crash-2"], siteId);
			expect(claimed[0]?.claim_state).toBe("processing");
			// Boot recovery resets processing → pending on this host.
			resetProcessingDurableWork(db, siteId);
			expect(durableRowState("dur-crash-2")).toBe("pending");
			// A stale ack under the now-invalid token is rejected (token fence): the row
			// stays pending/recoverable, never silently consumed by a lost-race claimant.
			const staleToken = claimed[0]?.claim_token ?? "";
			expect(acknowledgeDurableWork(db, "dur-crash-2", staleToken)).toBe(false);
			expect(durableRowState("dur-crash-2")).toBe("pending");
		});
	});
});
