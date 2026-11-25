/**
 * `loadClusterModels` keys the cluster model list by LOGICAL model so the
 * agent copies a routable logical id (failover + pooling) into aux / infer()
 * model choices instead of a backend id that pins one route.
 */

import Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { ROUTING_MODEL_ROLES_KEY } from "@bound/shared";
import { loadClusterModels } from "../collect";

const LOCAL = "site-local";
const REMOTE = "site-remote";
const TS = "2026-11-25T00:00:00Z";

function freshDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

function addHost(db: Database, siteId: string, hostName: string, models: unknown[]): void {
	insertRow(
		db,
		"hosts",
		{
			site_id: siteId,
			host_name: hostName,
			models: JSON.stringify(models),
			online_at: TS,
			modified_at: TS,
			deleted: 0,
			work_spool_capable: 0,
		},
		LOCAL,
	);
}

describe("loadClusterModels logical-model collapse", () => {
	it("collapses different backend ids sharing a logical_model into one merged entry", () => {
		const db = freshDb();
		addHost(db, REMOTE, "host-b", [
			{
				id: "bedrock-main-openai.gpt-6-astra",
				logical_model: "gpt-6-astra",
				max_output_tokens: 128000,
				capabilities: { max_context: 1050000, vision: true, extended_thinking: false },
			},
		]);
		addHost(db, LOCAL, "host-a", [
			{
				id: "copilot-gpt-6-astra",
				logical_model: "gpt-6-astra",
				max_output_tokens: 64000,
				capabilities: { max_context: 272000, vision: true, extended_thinking: true },
			},
		]);

		const models = loadClusterModels(db, LOCAL);
		expect(models).toHaveLength(1);
		const [m] = models;
		expect(m.name).toBe("gpt-6-astra");
		expect(m.hosts).toEqual(["host-a", "host-b"]);
		expect(m.local).toBe(true);
		expect(m.contextWindow).toBe(272000);
		expect(m.maxOutput).toBe(64000);
		expect(m.vision).toBe(true);
		expect(m.thinking).toBe(false);
		expect(
			models.some((x) => x.name.includes("bedrock-main") || x.name.startsWith("copilot-")),
		).toBe(false);
	});

	it("is local=false when no serving host is the local site", () => {
		const db = freshDb();
		addHost(db, REMOTE, "host-b", [{ id: "zai-glm-5.4", logical_model: "glm-5.4" }]);
		expect(loadClusterModels(db, LOCAL)[0]).toMatchObject({ name: "glm-5.4", local: false });
	});

	it("keeps the backend id when an entry has no (or empty) logical_model", () => {
		const db = freshDb();
		addHost(db, LOCAL, "host-a", [
			{ id: "zai-glm-5.3-flashx", max_output_tokens: 131072 },
			{ id: "zai-glm-4.5-air", logical_model: "" },
		]);
		const names = loadClusterModels(db, LOCAL).map((m) => m.name);
		expect(names).toEqual(["zai-glm-4.5-air", "zai-glm-5.3-flashx"]);
	});

	it("keeps legacy string entries as their string", () => {
		const db = freshDb();
		addHost(db, LOCAL, "host-a", ["legacy-alias"]);
		addHost(db, REMOTE, "host-b", ["legacy-alias"]);
		const models = loadClusterModels(db, LOCAL);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			name: "legacy-alias",
			hosts: ["host-a", "host-b"],
			local: true,
		});
	});

	it("annotates the logical entry named by the routing.model_roles default role", () => {
		const db = freshDb();
		addHost(db, LOCAL, "host-a", [
			{ id: "copilot-gpt-6-astra", logical_model: "gpt-6-astra" },
			{ id: "copilot-claude-haiku-5.5", logical_model: "claude-haiku-5.5" },
		]);
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_MODEL_ROLES_KEY,
				value: JSON.stringify({ default: "gpt-6-astra" }),
				modified_at: TS,
				deleted: 0,
			},
			LOCAL,
		);
		const byName = new Map(loadClusterModels(db, LOCAL).map((m) => [m.name, m]));
		expect(byName.get("gpt-6-astra")?.role).toBe("default");
		expect(byName.get("claude-haiku-5.5")?.role).toBeUndefined();
	});
});
