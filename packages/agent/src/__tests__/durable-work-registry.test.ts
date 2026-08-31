import { describe, expect, it } from "bun:test";
import { RELAY_KINDS } from "@bound/shared";
import { DURABLE_WORK_KINDS, DURABLE_WORK_REGISTRY } from "../durable-work-registry";

describe("durable work registry", () => {
	it("declares every legacy relay work kind exactly once with lifecycle metadata", () => {
		for (const kind of RELAY_KINDS) expect(DURABLE_WORK_KINDS).toContain(kind);
		expect(new Set(DURABLE_WORK_KINDS).size).toBe(DURABLE_WORK_REGISTRY.length);
		for (const entry of DURABLE_WORK_REGISTRY) {
			expect(entry.idempotencyKey({ id: "test", idempotency_key: "stable" })).toBeTruthy();
			expect(entry.deadLetterPolicy).toBe("retain-7d");
		}
	});
});
