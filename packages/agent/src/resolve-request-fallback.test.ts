import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { insertRow } from "@bound/core";
import { ROUTING_DEFAULT_FALLBACK_MODELS_KEY } from "@bound/shared";
import { resolveRequestFallback } from "./resolve-request-fallback";

/**
 * Tests for the loop-host request-fallback resolver (slice 5, R-RT18 step 1).
 * The loop host reads the logical model's `model_routing_rules.fallback_policy`
 * (absent row → auto) and the cluster `routing.default_fallback_models`, then
 * produces the `{ fallback_policy, fallback_models }` fields shipped on the
 * inference request. It does NOT execute anything.
 */

function seedRule(db: Database, logicalModel: string, policyJson: string) {
	insertRow(
		db,
		"model_routing_rules",
		{
			logical_model: logicalModel,
			route_order: null,
			fallback_policy: policyJson,
			modified_at: new Date().toISOString(),
		},
		"site-test",
	);
}

function seedDefaults(db: Database, models: string[]) {
	insertRow(
		db,
		"cluster_config",
		{
			key: ROUTING_DEFAULT_FALLBACK_MODELS_KEY,
			value: JSON.stringify(models),
			modified_at: new Date().toISOString(),
		},
		"site-test",
	);
}

describe("resolveRequestFallback", () => {
	let db: Database;
	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	it("defaults to auto with the cluster default list when no per-model row exists", () => {
		seedDefaults(db, ["sonnet", "haiku"]);
		const r = resolveRequestFallback(db, "opus");
		expect(r.fallback_policy).toEqual({ mode: "auto" });
		expect(r.fallback_models).toEqual(["sonnet", "haiku"]);
	});

	it("reads a per-model never policy and ships an empty candidate list", () => {
		seedDefaults(db, ["sonnet"]);
		seedRule(db, "opus", JSON.stringify({ mode: "never" }));
		const r = resolveRequestFallback(db, "opus");
		expect(r.fallback_policy).toEqual({ mode: "never" });
		expect(r.fallback_models).toEqual([]);
	});

	it("reads a per-model custom policy and ships its ordered list (minus the refused model)", () => {
		seedRule(db, "opus", JSON.stringify({ mode: "custom", models: ["opus", "sonnet", "haiku"] }));
		const r = resolveRequestFallback(db, "opus");
		expect(r.fallback_policy).toEqual({ mode: "custom" });
		expect(r.fallback_models).toEqual(["sonnet", "haiku"]);
	});

	it("auto with no cluster default list ships an empty candidate list", () => {
		const r = resolveRequestFallback(db, "opus");
		expect(r.fallback_policy).toEqual({ mode: "auto" });
		expect(r.fallback_models).toEqual([]);
	});

	it("tolerates a malformed fallback_policy JSON by falling back to auto", () => {
		seedDefaults(db, ["haiku"]);
		seedRule(db, "opus", "{not json");
		const r = resolveRequestFallback(db, "opus");
		expect(r.fallback_policy).toEqual({ mode: "auto" });
		expect(r.fallback_models).toEqual(["haiku"]);
	});

	it("tolerates a malformed default_fallback_models JSON by shipping an empty list", () => {
		seedRule(db, "opus", JSON.stringify({ mode: "auto" }));
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_DEFAULT_FALLBACK_MODELS_KEY,
				value: "{not json",
				modified_at: new Date().toISOString(),
			},
			"site-test",
		);
		const r = resolveRequestFallback(db, "opus");
		expect(r.fallback_models).toEqual([]);
	});
});
