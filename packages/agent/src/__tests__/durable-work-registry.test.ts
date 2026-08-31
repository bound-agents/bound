import { describe, expect, it } from "bun:test";
import { RELAY_KINDS } from "@bound/shared";
import { DURABLE_WORK_KINDS, DURABLE_WORK_REGISTRY } from "../durable-work-registry";

describe("durable work registry", () => {
	it("declares every legacy relay work kind exactly once with lifecycle metadata", () => {
		for (const kind of RELAY_KINDS) expect(DURABLE_WORK_KINDS).toContain(kind);
		expect(new Set(DURABLE_WORK_KINDS).size).toBe(DURABLE_WORK_REGISTRY.length);
		for (const entry of DURABLE_WORK_REGISTRY) {
			if (entry.kind !== "dispatch_message") {
				expect(entry.idempotencyKey({ id: "test", idempotency_key: "stable" })).toBeTruthy();
			}
			expect(entry.deadLetterPolicy).toBe("retain-7d");
		}
	});

	it("uses the same idempotency-key formats as durable dispatch enqueue paths", () => {
		const dispatch = DURABLE_WORK_REGISTRY.find((entry) => entry.kind === "dispatch_message");
		expect(dispatch).toBeDefined();
		expect(dispatch?.subtypes).toEqual([
			{
				type: "user_message",
				idempotencyKey: expect.any(Function),
			},
			{
				type: "notification",
				idempotencyKey: expect.any(Function),
			},
			{
				type: "tool_result",
				idempotencyKey: expect.any(Function),
			},
		]);

		const constructors = new Map(
			dispatch?.subtypes?.map((subtype) => [subtype.type, subtype.idempotencyKey]),
		);
		expect(constructors.get("user_message")?.({ message_id: "message-123" })).toBe("message-123");
		expect(constructors.get("notification")?.({ notification_id: "notification-456" })).toBe(
			"notify:notification-456",
		);
		expect(
			constructors.get("tool_result")?.({ thread_id: "thread-789", call_id: "call-abc" }),
		).toBe("tool-result:thread-789:call-abc");
	});
});

describe("passive intake durable work registrations", () => {
	it("uses scheduler-owned seven-day local-exclusive lifecycle metadata", () => {
		for (const kind of ["webhook_intake", "rss_intake", "connector_intake"]) {
			const entry = DURABLE_WORK_REGISTRY.find((candidate) => candidate.kind === kind);
			expect(entry).toMatchObject({
				ttlMs: 7 * 24 * 60 * 60 * 1000,
				consumer: "scheduler",
				claimDiscipline: "local-exclusive",
				retirementRule: "single-ack",
				backing: "local",
			});
		}
	});
});

describe("RPC relay request durable work TTL (4D-C)", () => {
	it("gives active RPC request kinds an RPC-class TTL, not the 7-day intake TTL", () => {
		// A durable RPC request must expire on the relay-timeout class so the sweep
		// dead-letters a stale request before the 4D-A lane dispatches it.
		for (const kind of [
			"tool_call",
			"client_tool",
			"notify_wakeup",
			"inference",
			"platform_request",
			"intake",
			"resource_read",
			"prompt_invoke",
			"cache_warm",
		]) {
			const entry = DURABLE_WORK_REGISTRY.find((candidate) => candidate.kind === kind);
			expect(entry?.ttlMs).toBe(5 * 60 * 1000);
		}
	});

	it("keeps the 5-minute window on stream response kinds", () => {
		for (const kind of ["stream_chunk", "stream_end"]) {
			const entry = DURABLE_WORK_REGISTRY.find((candidate) => candidate.kind === kind);
			expect(entry?.ttlMs).toBe(5 * 60 * 1000);
		}
	});

	it("keeps the 7-day window on passive intake kinds", () => {
		for (const kind of ["webhook_intake", "rss_intake", "connector_intake"]) {
			const entry = DURABLE_WORK_REGISTRY.find((candidate) => candidate.kind === kind);
			expect(entry?.ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
		}
	});
});
