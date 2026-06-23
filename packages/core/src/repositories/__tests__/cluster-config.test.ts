import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClusterConfigEntry } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../index";
import {
	findClusterConfigKeyByKey,
	findClusterConfigKeyByKeyIncludingDeleted,
	findClusterConfigValueByKey,
	findClusterConfigValueWithModifiedAtByKey,
} from "../cluster-config";

const SITE_ID = "site-aaaa";

let db: Database;

function seedConfig(entry: Omit<ClusterConfigEntry, "deleted"> & { deleted?: number }): void {
	insertRow(db, "cluster_config", { deleted: 0, ...entry }, SITE_ID);
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

describe("soft-delete semantics", () => {
	it("live-read finders exclude a soft-deleted row", () => {
		seedConfig({ key: "emergency_stop", value: "1", modified_at: "2026-01-01T00:00:00.000Z" });
		softDelete(db, "cluster_config", "emergency_stop", SITE_ID);

		// All three live-read finders must treat a tombstone as absent.
		expect(findClusterConfigValueByKey(db, "emergency_stop")).toBeNull();
		expect(findClusterConfigValueWithModifiedAtByKey(db, "emergency_stop")).toBeNull();
		expect(findClusterConfigKeyByKey(db, "emergency_stop")).toBeNull();
	});

	it("the include-deleted probe still sees a soft-deleted row", () => {
		seedConfig({ key: "emergency_stop", value: "1", modified_at: "2026-01-01T00:00:00.000Z" });
		softDelete(db, "cluster_config", "emergency_stop", SITE_ID);

		// The write path relies on this to detect the tombstone and UPDATE rather
		// than INSERT (which would collide on the `key` PK).
		expect(findClusterConfigKeyByKeyIncludingDeleted(db, "emergency_stop")).toEqual({
			key: "emergency_stop",
		});
	});

	it("re-setting a soft-deleted key via UPDATE+deleted=0 un-tombstones it without a UNIQUE collision", () => {
		seedConfig({ key: "emergency_stop", value: "first", modified_at: "2026-01-01T00:00:00.000Z" });
		softDelete(db, "cluster_config", "emergency_stop", SITE_ID);

		// Simulate the writer's upsert path: probe ignoring deleted -> row exists ->
		// UPDATE with deleted: 0. This must NOT throw a UNIQUE constraint error and
		// must bring the row back live with the new value.
		expect(findClusterConfigKeyByKeyIncludingDeleted(db, "emergency_stop")).not.toBeNull();
		expect(() => {
			updateRow(db, "cluster_config", "emergency_stop", { value: "second", deleted: 0 }, SITE_ID);
		}).not.toThrow();

		expect(findClusterConfigValueByKey(db, "emergency_stop")).toEqual({ value: "second" });
	});
});
