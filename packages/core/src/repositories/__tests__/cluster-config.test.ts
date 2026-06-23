import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClusterConfigEntry } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, updateRow } from "../../index";
import {
	findClusterConfigKeyByKey,
	findClusterConfigValueByKey,
	findClusterConfigValueWithModifiedAtByKey,
} from "../cluster-config";

const SITE_ID = "site-aaaa";

let db: Database;

function seedConfig(entry: ClusterConfigEntry): void {
	insertRow(db, "cluster_config", entry, SITE_ID);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	db.close();
});

describe("findClusterConfigValueByKey", () => {
	it("returns the value for an existing key", () => {
		seedConfig({
			key: "operator_persona",
			value: "You are a terse operator.",
			modified_at: "2026-01-01T00:00:00.000Z",
		});

		const row = findClusterConfigValueByKey(db, "operator_persona");

		expect(row).toEqual({ value: "You are a terse operator." });
	});

	it("returns null for an absent key", () => {
		seedConfig({
			key: "operator_persona",
			value: "present",
			modified_at: "2026-01-01T00:00:00.000Z",
		});

		const row = findClusterConfigValueByKey(db, "nonexistent");

		expect(row).toBeNull();
	});

	it("reflects the latest value after an LWW update", () => {
		seedConfig({
			key: "leader",
			value: "host-a",
			modified_at: "2026-01-01T00:00:00.000Z",
		});

		updateRow(db, "cluster_config", "leader", { value: "host-b" }, SITE_ID);

		const row = findClusterConfigValueByKey(db, "leader");

		expect(row).toEqual({ value: "host-b" });
	});

	it("selects only the requested key when multiple rows exist", () => {
		seedConfig({ key: "alpha", value: "A", modified_at: "2026-01-01T00:00:00.000Z" });
		seedConfig({ key: "beta", value: "B", modified_at: "2026-01-01T00:00:00.000Z" });
		seedConfig({ key: "gamma", value: "C", modified_at: "2026-01-01T00:00:00.000Z" });

		expect(findClusterConfigValueByKey(db, "beta")).toEqual({ value: "B" });
		expect(findClusterConfigValueByKey(db, "gamma")).toEqual({ value: "C" });
	});
});

describe("findClusterConfigValueWithModifiedAtByKey", () => {
	it("returns value and modified_at for an existing key", () => {
		seedConfig({
			key: "operator_persona",
			value: "persona body",
			modified_at: "2026-01-01T00:00:00.000Z",
		});

		const row = findClusterConfigValueWithModifiedAtByKey(db, "operator_persona");

		expect(row).toEqual({
			value: "persona body",
			modified_at: "2026-01-01T00:00:00.000Z",
		});
	});

	it("returns null for an absent key", () => {
		const row = findClusterConfigValueWithModifiedAtByKey(db, "missing");

		expect(row).toBeNull();
	});

	it("surfaces the bumped modified_at after an update", () => {
		seedConfig({
			key: "operator_persona",
			value: "v1",
			modified_at: "2026-01-01T00:00:00.000Z",
		});

		// updateRow overwrites modified_at with a fresh ISO timestamp.
		updateRow(db, "cluster_config", "operator_persona", { value: "v2" }, SITE_ID);

		const row = findClusterConfigValueWithModifiedAtByKey(db, "operator_persona");

		expect(row).not.toBeNull();
		expect(row?.value).toBe("v2");
		// The seeded sentinel timestamp must have been replaced by the update.
		expect(row?.modified_at).not.toBe("2026-01-01T00:00:00.000Z");
	});
});

describe("findClusterConfigKeyByKey", () => {
	it("returns the key for an existing row (existence probe hit)", () => {
		seedConfig({
			key: "emergency_stop",
			value: "1",
			modified_at: "2026-01-01T00:00:00.000Z",
		});

		const row = findClusterConfigKeyByKey(db, "emergency_stop");

		expect(row).toEqual({ key: "emergency_stop" });
	});

	it("returns null for an absent row (existence probe miss)", () => {
		const row = findClusterConfigKeyByKey(db, "emergency_stop");

		expect(row).toBeNull();
	});
});
