import type { Database } from "bun:sqlite";
import { applyAdvisory, approveAdvisory, deferAdvisory, dismissAdvisory } from "@bound/agent";
import {
	countProposedAdvisories,
	findActiveAdvisoryById,
	findAdvisoryById,
	getHostMetaSiteId,
	listActiveAdvisories,
	listAdvisoriesByStatus,
} from "@bound/core";
import { Hono } from "hono";

export function createAdvisoriesRoutes(db: Database, operatorUserId: string): Hono {
	const app = new Hono();

	function getSiteId(): string {
		return getHostMetaSiteId(db);
	}

	/**
	 * Pull the required #192 resolution note from a POST body. Returns the
	 * trimmed note or null when it's missing/blank, so each handler can reject
	 * a state change with no rationale before touching the row.
	 */
	async function readNote(c: import("hono").Context): Promise<string | null> {
		const body = (await c.req.json().catch(() => ({}))) as { note?: unknown };
		const note = typeof body.note === "string" ? body.note.trim() : "";
		return note.length > 0 ? note : null;
	}

	app.get("/", (c) => {
		try {
			const status = c.req.query("status");

			const advisories = status ? listAdvisoriesByStatus(db, status) : listActiveAdvisories(db);

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
			const count = countProposedAdvisories(db);
			return c.json({ count });
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

	app.post("/:id/approve", async (c) => {
		try {
			const { id } = c.req.param();
			const advisory = findActiveAdvisoryById(db, id);

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

			const note = await readNote(c);
			if (!note) {
				return c.json({ error: "A 'note' is required to approve an advisory" }, 400);
			}

			const result = approveAdvisory(db, id, { note, by: operatorUserId }, getSiteId());

			if (!result.ok) {
				return c.json(
					{
						error: "Failed to approve advisory",
						details: result.error.message,
					},
					500,
				);
			}

			const updated = findAdvisoryById(db, id);
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

	app.post("/:id/dismiss", async (c) => {
		try {
			const { id } = c.req.param();
			const advisory = findActiveAdvisoryById(db, id);

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

			const note = await readNote(c);
			if (!note) {
				return c.json({ error: "A 'note' is required to dismiss an advisory" }, 400);
			}

			const result = dismissAdvisory(db, id, { note, by: operatorUserId }, getSiteId());

			if (!result.ok) {
				return c.json(
					{
						error: "Failed to dismiss advisory",
						details: result.error.message,
					},
					500,
				);
			}

			const updated = findAdvisoryById(db, id);
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

	app.post("/:id/defer", async (c) => {
		try {
			const { id } = c.req.param();
			const advisory = findActiveAdvisoryById(db, id);

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

			const note = await readNote(c);
			if (!note) {
				return c.json({ error: "A 'note' is required to defer an advisory" }, 400);
			}

			// Default defer by 24 hours
			const deferUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
			const result = deferAdvisory(db, id, deferUntil, { note, by: operatorUserId }, getSiteId());

			if (!result.ok) {
				return c.json(
					{
						error: "Failed to defer advisory",
						details: result.error.message,
					},
					500,
				);
			}

			const updated = findAdvisoryById(db, id);
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

	app.post("/:id/apply", async (c) => {
		try {
			const { id } = c.req.param();
			const advisory = findActiveAdvisoryById(db, id);

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

			const note = await readNote(c);
			if (!note) {
				return c.json({ error: "A 'note' is required to apply an advisory" }, 400);
			}

			const result = applyAdvisory(db, id, { note, by: operatorUserId }, getSiteId());

			if (!result.ok) {
				return c.json(
					{
						error: "Failed to apply advisory",
						details: result.error.message,
					},
					500,
				);
			}

			const updated = findAdvisoryById(db, id);
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
