import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase } from "@bound/core";
import { MAX_PERSONA_BYTES, PERSONA_CLUSTER_CONFIG_KEY } from "@bound/shared";
import { Hono } from "hono";
import { createPersonaRoutes } from "../routes/persona";

describe("persona routes — GET/POST /api/persona", () => {
	let db: Database;
	let app: Hono;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		// insertRow/updateRow write change_log entries tagged with site_id.
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", randomUUID()]);
		app = new Hono();
		app.route("/", createPersonaRoutes(db));
	});

	it("GET returns empty persona and the byte cap when unset", async () => {
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			persona: string;
			modified_at: string | null;
			max_bytes: number;
		};
		expect(json.persona).toBe("");
		expect(json.modified_at).toBeNull();
		expect(json.max_bytes).toBe(MAX_PERSONA_BYTES);
	});

	it("POST sets the persona and a change_log entry is written (outbox path)", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ persona: "You are a careful systems engineer." }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; bytes: number };
		expect(json.ok).toBe(true);

		// Persisted into cluster_config under the canonical key.
		const row = db
			.query("SELECT value FROM cluster_config WHERE key = ?")
			.get(PERSONA_CLUSTER_CONFIG_KEY) as { value: string } | null;
		expect(row?.value).toBe("You are a careful systems engineer.");

		// Outbox: the write produced a change_log entry (so peers learn about it).
		const changeCount = db
			.query("SELECT COUNT(*) AS c FROM change_log WHERE table_name = 'cluster_config'")
			.get() as { c: number };
		expect(changeCount.c).toBeGreaterThan(0);
	});

	it("POST then GET round-trips the value and a modified_at", async () => {
		await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ persona: "First voice." }),
		});

		const res = await app.request("/");
		const json = (await res.json()) as { persona: string; modified_at: string | null };
		expect(json.persona).toBe("First voice.");
		expect(json.modified_at).not.toBeNull();
	});

	it("POST overwrites an existing persona (LWW row, single global value)", async () => {
		await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ persona: "Original." }),
		});
		await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ persona: "Replacement." }),
		});

		const row = db
			.query("SELECT value FROM cluster_config WHERE key = ?")
			.get(PERSONA_CLUSTER_CONFIG_KEY) as { value: string };
		expect(row.value).toBe("Replacement.");

		// Still exactly one persona row — it's a single global key, not append.
		const count = db
			.query("SELECT COUNT(*) AS c FROM cluster_config WHERE key = ?")
			.get(PERSONA_CLUSTER_CONFIG_KEY) as { c: number };
		expect(count.c).toBe(1);
	});

	it("POST rejects a non-string persona with 400", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ persona: 42 }),
		});
		expect(res.status).toBe(400);
	});

	it("POST rejects an empty persona with 400", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ persona: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST rejects a persona over the byte cap with 413", async () => {
		const oversized = "x".repeat(MAX_PERSONA_BYTES + 1);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ persona: oversized }),
		});
		expect(res.status).toBe(413);

		// Nothing persisted.
		const row = db
			.query("SELECT value FROM cluster_config WHERE key = ?")
			.get(PERSONA_CLUSTER_CONFIG_KEY);
		expect(row).toBeNull();
	});

	it("POST rejects invalid JSON with 400", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});
});
