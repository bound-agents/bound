import { describe, expect, it } from "bun:test";
import { RELAY_PASSIVE_KINDS } from "@bound/shared";
import { PASSIVE_INTAKE_KINDS, PASSIVE_INTAKE_REGISTRY } from "../intake-kind-registry";

describe("passive intake registry", () => {
	it("registers every passive relay kind emitted by an intake producer", () => {
		// RELAY_PASSIVE_KINDS is the shared, grep-able producer contract: every
		// producer writes one of these kinds into relay_inbox. A new passive kind
		// must register here or this test fails before it can strand rows.
		expect(PASSIVE_INTAKE_KINDS).toEqual([...RELAY_PASSIVE_KINDS]);
		expect(new Set(PASSIVE_INTAKE_REGISTRY.map((intake) => intake.kind)).size).toBe(
			PASSIVE_INTAKE_REGISTRY.length,
		);
	});
});
