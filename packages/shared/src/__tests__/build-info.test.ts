import { describe, expect, it } from "bun:test";
import { getBuildInfo, loadBuildInfo } from "../build-info";

// The generated module (build-info-generated.ts) may or may not be present
// depending on whether a build ran in this tree. These tests pin the contract
// that holds in BOTH cases: getBuildInfo() returns well-formed string fields,
// loadBuildInfo() never throws, and after a load getBuildInfo() reflects
// whatever the module resolved to (generated values when present, the
// "dev"/"unknown" fallback when absent).

describe("build-info", () => {
	it("getBuildInfo returns well-formed string fields", () => {
		const info = getBuildInfo();
		expect(typeof info.commitHash).toBe("string");
		expect(typeof info.buildTime).toBe("string");
		expect(info.commitHash.length).toBeGreaterThan(0);
		expect(info.buildTime.length).toBeGreaterThan(0);
	});

	it("loadBuildInfo resolves without throwing", async () => {
		await expect(loadBuildInfo()).resolves.toBeUndefined();
	});

	it("loadBuildInfo is idempotent — the cached value is stable across repeated calls", async () => {
		await loadBuildInfo();
		const first = getBuildInfo();
		await loadBuildInfo();
		await Promise.all([loadBuildInfo(), loadBuildInfo()]);
		const second = getBuildInfo();
		// Same resolved snapshot before and after redundant loads.
		expect(second).toEqual(first);
	});

	it("after a successful load, fields are not empty", async () => {
		await loadBuildInfo();
		const info = getBuildInfo();
		// When the generated file is absent these equal the fallback; when
		// present they equal the generated constants. Either way, non-empty.
		expect(info.commitHash).not.toBe("");
		expect(info.buildTime).not.toBe("");
	});
});
