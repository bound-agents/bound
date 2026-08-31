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
