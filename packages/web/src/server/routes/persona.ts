import type { Database } from "bun:sqlite";
import { getSiteId, insertRow, updateRow } from "@bound/core";
import { MAX_PERSONA_BYTES, PERSONA_CLUSTER_CONFIG_KEY } from "@bound/shared";
import { Hono } from "hono";

/**
 * Persona routes — read and set the cluster-wide operator persona.
 *
 * The persona is a single synced `cluster_config` LWW row, read live at
 * context-assembly time (no cache). A write here propagates to every host via
 * the change-log outbox and takes effect on the next turn cluster-wide, which
 * is the whole point of moving it off per-host `config/persona.md` files.
 */
export function createPersonaRoutes(db: Database): Hono {
	const app = new Hono();

	// GET /api/persona — current persona text (empty string when unset).
	app.get("/", (c) => {
		try {
			const row = db
				.query("SELECT value, modified_at FROM cluster_config WHERE key = ?")
				.get(PERSONA_CLUSTER_CONFIG_KEY) as { value: string; modified_at: string } | null;
			return c.json({
				persona: row?.value ?? "",
				modified_at: row?.modified_at ?? null,
				max_bytes: MAX_PERSONA_BYTES,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to read persona", details: message }, 500);
		}
	});

	// POST /api/persona — set the persona. Body: { persona: string }.
	app.post("/", async (c) => {
		let body: { persona?: unknown };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const persona = body.persona;
		if (typeof persona !== "string") {
			return c.json({ error: "Field 'persona' must be a string" }, 400);
		}
		if (persona.length === 0) {
			return c.json({ error: "Persona must not be empty" }, 400);
		}

		const byteLength = Buffer.byteLength(persona, "utf-8");
		if (byteLength > MAX_PERSONA_BYTES) {
			return c.json(
				{
					error: `Persona is ${byteLength} bytes, over the ${MAX_PERSONA_BYTES}-byte cap.`,
				},
				413,
			);
		}

		try {
			const siteId = getSiteId(db);
			const existing = db
				.query("SELECT key FROM cluster_config WHERE key = ?")
				.get(PERSONA_CLUSTER_CONFIG_KEY);

			if (existing) {
				updateRow(db, "cluster_config", PERSONA_CLUSTER_CONFIG_KEY, { value: persona }, siteId);
			} else {
				insertRow(
					db,
					"cluster_config",
					{
						key: PERSONA_CLUSTER_CONFIG_KEY,
						value: persona,
						modified_at: new Date().toISOString(),
					},
					siteId,
				);
			}

			return c.json({ ok: true, bytes: byteLength });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to set persona", details: message }, 500);
		}
	});

	return app;
}
