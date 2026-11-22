/**
 * Provider-discovery hook contract (slice 6, R-MC3, 2026-11-21-model-catalog.md
 * §4.1). The only runtime export is the `supportsModelDiscovery` type guard that
 * decides whether a backend implements the optional `discoverModels()` hook; the
 * rest of the module is interface shape. These cases pin every branch of the
 * guard so a driver that forgets the hook, or a non-object masquerading as a
 * backend, is classified correctly before the catalog resolver calls it.
 */

import { describe, expect, it } from "bun:test";
import type { DiscoveredModel } from "./discovery";
import { supportsModelDiscovery } from "./discovery";

describe("supportsModelDiscovery", () => {
	it("accepts a value whose discoverModels is a function", () => {
		const backend = {
			async discoverModels(): Promise<DiscoveredModel[]> {
				return [{ providerModelId: "claude-opus-4-20250101" }];
			},
		};
		expect(supportsModelDiscovery(backend)).toBe(true);
	});

	it("narrows the type so the hook is callable", async () => {
		const backend: unknown = {
			async discoverModels(): Promise<DiscoveredModel[]> {
				return [{ providerModelId: "gpt-5.6-sol", vendor: "openai" }];
			},
		};
		expect(supportsModelDiscovery(backend)).toBe(true);
		if (supportsModelDiscovery(backend)) {
			const models = await backend.discoverModels();
			expect(models).toEqual([{ providerModelId: "gpt-5.6-sol", vendor: "openai" }]);
		}
	});

	it("rejects an object without discoverModels", () => {
		expect(supportsModelDiscovery({ chat() {} })).toBe(false);
	});

	it("rejects an object whose discoverModels is not a function", () => {
		expect(supportsModelDiscovery({ discoverModels: "yes" })).toBe(false);
		expect(supportsModelDiscovery({ discoverModels: 42 })).toBe(false);
	});

	it("rejects null", () => {
		expect(supportsModelDiscovery(null)).toBe(false);
	});

	it("rejects undefined", () => {
		expect(supportsModelDiscovery(undefined)).toBe(false);
	});

	it("rejects non-object primitives", () => {
		expect(supportsModelDiscovery("backend")).toBe(false);
		expect(supportsModelDiscovery(0)).toBe(false);
		expect(supportsModelDiscovery(true)).toBe(false);
	});
});
