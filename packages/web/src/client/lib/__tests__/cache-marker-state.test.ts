import { describe, expect, it } from "bun:test";
import { type CacheMarkerStateInput, deriveCacheMarkerStates } from "../cache-marker-state";

const system: CacheMarkerStateInput = { kind: "system", capabilityEnabled: true };
const message: CacheMarkerStateInput = { kind: "message", capabilityEnabled: true };

describe("deriveCacheMarkerStates", () => {
	it("returns an empty array when there are no markers", () => {
		expect(deriveCacheMarkerStates([], 5000, 1200)).toEqual([]);
	});

	it("paints every marker disabled when any breakpoint capability is off", () => {
		// Capability is per-backend, so in practice both flip together — but if
		// either is off the whole bar reads disabled.
		expect(
			deriveCacheMarkerStates(
				[
					{ kind: "system", capabilityEnabled: false },
					{ kind: "message", capabilityEnabled: false },
				],
				0,
				0,
			),
		).toEqual(["disabled", "disabled"]);
		expect(
			deriveCacheMarkerStates([system, { kind: "message", capabilityEnabled: false }], 5000, 0),
		).toEqual(["disabled", "disabled"]);
	});

	it("paints every marker idle when caching is on but nothing was read or written", () => {
		expect(deriveCacheMarkerStates([system, message], 0, 0)).toEqual(["idle", "idle"]);
	});

	it("paints BOTH markers hit on a pure-read (warm) turn", () => {
		expect(deriveCacheMarkerStates([system, message], 8000, 0)).toEqual(["hit", "hit"]);
	});

	it("paints BOTH markers write on a pure-write (cold seed) turn", () => {
		// Regression guard for the original rationale: a cold turn that only wrote
		// (e.g. 162k seeded) must NOT paint one tick idle — both breakpoints
		// participated in the write, so both read "write".
		expect(deriveCacheMarkerStates([system, message], 0, 162000)).toEqual(["write", "write"]);
	});

	it("splits a mixed turn: system reads hit, message reads write (#98)", () => {
		// Both a read and a write occurred this turn. We can't attribute bytes to a
		// specific breakpoint, but the presence of both lets us infer at least one
		// served a read and at least one a write. Assign by cache topology.
		expect(deriveCacheMarkerStates([system, message], 8000, 1200)).toEqual(["hit", "write"]);
	});

	it("splits a mixed turn the same way regardless of which total is larger", () => {
		// Old heuristic chose by read-vs-write magnitude (both hit when read>write,
		// both write otherwise). The split must not depend on magnitude.
		expect(deriveCacheMarkerStates([system, message], 1200, 8000)).toEqual(["hit", "write"]);
	});

	it("assigns the split by marker kind, not input position", () => {
		expect(deriveCacheMarkerStates([message, system], 8000, 1200)).toEqual(["write", "hit"]);
	});

	it("falls back to the first marker for the read when no system marker exists in a split", () => {
		expect(deriveCacheMarkerStates([message, message], 8000, 1200)).toEqual(["hit", "write"]);
	});

	it("clamps negative token counts to zero", () => {
		expect(deriveCacheMarkerStates([system, message], -5, -5)).toEqual(["idle", "idle"]);
	});
});
