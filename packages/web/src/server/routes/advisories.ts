import type { Database } from "bun:sqlite";
import { updateRow } from "@bound/core";
import type { Advisory } from "@bound/shared";
import { Hono } from "hono";

export function createAdvisoriesRoutes(db: Database): Hono {
	const app = new Hono();

	function getSiteId(): string {
		const row = db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get() as
			| { value: string }
			| undefined;
		return row?.value ?? "unknown";
	}

	app.get("/", (c) => {
		try {
			const status = c.req.query("status");

			let query = "SELECT * FROM advisories WHERE deleted = 0";
			const params: unknown[] = [];

			if (status) {
				query += " AND status = ?";
				params.push(status);
			}

			query += " ORDER BY proposed_at DESC";

			const advisories = db.query(query).all(...params) as Advisory[];

			return c.json(advisories);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to list advisories",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/count", (c) => {
		try {
			const row = db
				.query("SELECT COUNT(*) as count FROM advisories WHERE deleted = 0 AND status = 'proposed'")
				.get() as { count: number };
			return c.json({ count: row.count });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to count advisories",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/:id/approve", (c) => {
		try {
			const { id } = c.req.param();
			const advisory = db
				.query("SELECT * FROM advisories WHERE id = ? AND deleted = 0")
				.get(id) as Advisory | null;

			if (!advisory) {
				return c.json({ error: "Advisory not found" }, 404);
			}

			if (advisory.status !== "proposed" && advisory.status !== "deferred") {
				return c.json(
					{
						error: `Cannot approve advisory in '${advisory.status}' status`,
					},
					400,
				);
			}

			const siteId = getSiteId();
			updateRow(db, "advisories", id, { status: "approved" }, siteId);

			const updated = db.query("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory;
			return c.json(updated);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to approve advisory",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/:id/dismiss", (c) => {
		try {
			const { id } = c.req.param();
			const advisory = db
				.query("SELECT * FROM advisories WHERE id = ? AND deleted = 0")
				.get(id) as Advisory | null;

			if (!advisory) {
				return c.json({ error: "Advisory not found" }, 404);
			}

			if (advisory.status !== "proposed" && advisory.status !== "deferred") {
				return c.json(
					{
						error: `Cannot dismiss advisory in '${advisory.status}' status`,
					},
					400,
				);
			}

			const siteId = getSiteId();
			const now = new Date().toISOString();
			updateRow(db, "advisories", id, { status: "dismissed", resolved_at: now }, siteId);

			const updated = db.query("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory;
			return c.json(updated);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to dismiss advisory",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/:id/defer", (c) => {
		try {
			const { id } = c.req.param();
			const advisory = db
				.query("SELECT * FROM advisories WHERE id = ? AND deleted = 0")
				.get(id) as Advisory | null;

			if (!advisory) {
				return c.json({ error: "Advisory not found" }, 404);
			}

			if (advisory.status !== "proposed") {
				return c.json(
					{
						error: `Cannot defer advisory in '${advisory.status}' status`,
					},
					400,
				);
			}

			const siteId = getSiteId();
			// Default defer by 24 hours
			const deferUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
			updateRow(db, "advisories", id, { status: "deferred", defer_until: deferUntil }, siteId);

			const updated = db.query("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory;
			return c.json(updated);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to defer advisory",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/:id/apply", (c) => {
		try {
			const { id } = c.req.param();
			const advisory = db
				.query("SELECT * FROM advisories WHERE id = ? AND deleted = 0")
				.get(id) as Advisory | null;

			if (!advisory) {
				return c.json({ error: "Advisory not found" }, 404);
			}

			if (advisory.status !== "approved") {
				return c.json(
					{
						error: `Cannot apply advisory in '${advisory.status}' status`,
					},
					400,
				);
			}

			const siteId = getSiteId();
			const now = new Date().toISOString();
			updateRow(db, "advisories", id, { status: "applied", resolved_at: now }, siteId);

			const updated = db.query("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory;
			return c.json(updated);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to apply advisory",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
