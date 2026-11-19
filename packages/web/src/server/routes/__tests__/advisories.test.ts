import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as agent from "@bound/agent";
import { createAdvisory } from "@bound/agent";
import { applySchema } from "@bound/core";
import { createAdvisoriesRoutes } from "../advisories";

// The advisories routes expose the operator approve/dismiss/defer/apply
// lifecycle over #192's required-note contract. These tests seed advisories
// directly and drive every handler across the not-found / wrong-status /
// missing-note / success branches so each transition is exercised end to end.

const SITE = "test-site";
const OPERATOR = "operator-1";

function seed(db: Database, overrides: Partial<Parameters<typeof createAdvisory>[1]> = {}): string {
	return createAdvisory(
		db,
		{
			type: "operational",
			title: "disk filling",
			detail: "root volume at 92%",
			action: "prune logs",
			impact: "high",
			evidence: "df -h",
			...overrides,
		},
		SITE,
	);
}

function post(app: ReturnType<typeof createAdvisoriesRoutes>, path: string, note?: string) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(note === undefined ? {} : { note }),
	});
}

describe("advisories routes", () => {
	let db: Database;
	let app: ReturnType<typeof createAdvisoriesRoutes>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", SITE);
		app = createAdvisoriesRoutes(db, OPERATOR);
	});

	afterEach(() => {
		db.close();
	});

	describe("GET /", () => {
		it("lists active advisories by default", async () => {
			seed(db);
			seed(db, { title: "second" });
			const res = await app.request("/");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { title: string }[];
			expect(body).toHaveLength(2);
			expect(body.map((a) => a.title).sort()).toEqual(["disk filling", "second"]);
		});

		it("filters by the status query param", async () => {
			const id = seed(db);
			// Approve one so there is a non-proposed row to filter for.
			await post(app, `/${id}/approve`, "ack");
			seed(db, { title: "still proposed" });

			const approved = (await (await app.request("/?status=approved")).json()) as {
				title: string;
			}[];
			expect(approved.map((a) => a.title)).toEqual(["disk filling"]);

			const proposed = (await (await app.request("/?status=proposed")).json()) as {
				title: string;
			}[];
			expect(proposed.map((a) => a.title)).toEqual(["still proposed"]);
		});
	});

	describe("GET /count", () => {
		it("counts only proposed advisories", async () => {
			seed(db);
			const approvedId = seed(db, { title: "will approve" });
			await post(app, `/${approvedId}/approve`, "ack");
			const res = await app.request("/count");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ count: 1 });
		});
	});

	describe("POST /:id/approve", () => {
		it("approves a proposed advisory with a note", async () => {
			const id = seed(db);
			const res = await post(app, `/${id}/approve`, "looks right");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; resolution_note: string };
			expect(body.status).toBe("approved");
			expect(body.resolution_note).toBe("looks right");
		});

		it("approves a deferred advisory too", async () => {
			const id = seed(db);
			await post(app, `/${id}/defer`, "later");
			const res = await post(app, `/${id}/approve`, "now ready");
			expect(res.status).toBe(200);
			expect((await res.json()).status).toBe("approved");
		});

		it("404s an unknown id", async () => {
			const res = await post(app, "/nope/approve", "x");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("Advisory not found");
		});

		it("400s when the advisory is already applied", async () => {
			const id = seed(db);
			await post(app, `/${id}/approve`, "ack");
			await post(app, `/${id}/apply`, "done");
			const res = await post(app, `/${id}/approve`, "again");
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("Cannot approve advisory in 'applied' status");
		});

		it("400s when no note is supplied", async () => {
			const id = seed(db);
			const res = await post(app, `/${id}/approve`);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("'note' is required");
		});

		it("400s when the note is blank whitespace", async () => {
			const id = seed(db);
			const res = await post(app, `/${id}/approve`, "   ");
			expect(res.status).toBe(400);
		});
	});

	describe("POST /:id/dismiss", () => {
		it("dismisses a proposed advisory with a note", async () => {
			const id = seed(db);
			const res = await post(app, `/${id}/dismiss`, "not worth it");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; resolution_note: string };
			expect(body.status).toBe("dismissed");
			expect(body.resolution_note).toBe("not worth it");
		});

		it("404s an unknown id", async () => {
			expect((await post(app, "/nope/dismiss", "x")).status).toBe(404);
		});

		it("400s a non-proposed/non-deferred advisory", async () => {
			const id = seed(db);
			await post(app, `/${id}/approve`, "ack");
			const res = await post(app, `/${id}/dismiss`, "x");
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("Cannot dismiss advisory in 'approved' status");
		});

		it("400s when no note is supplied", async () => {
			const id = seed(db);
			expect((await post(app, `/${id}/dismiss`)).status).toBe(400);
		});
	});

	describe("POST /:id/defer", () => {
		it("defers a proposed advisory and sets defer_until ~24h out", async () => {
			const id = seed(db);
			const before = Date.now();
			const res = await post(app, `/${id}/defer`, "revisit tomorrow");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; defer_until: string };
			expect(body.status).toBe("deferred");
			const deferMs = Date.parse(body.defer_until);
			expect(deferMs).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
			expect(deferMs).toBeLessThan(before + 25 * 60 * 60 * 1000);
		});

		it("404s an unknown id", async () => {
			expect((await post(app, "/nope/defer", "x")).status).toBe(404);
		});

		it("400s a non-proposed advisory (defer only applies to proposed)", async () => {
			const id = seed(db);
			await post(app, `/${id}/defer`, "first");
			// Now it is deferred — a second defer is rejected.
			const res = await post(app, `/${id}/defer`, "again");
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("Cannot defer advisory in 'deferred' status");
		});

		it("400s when no note is supplied", async () => {
			const id = seed(db);
			expect((await post(app, `/${id}/defer`)).status).toBe(400);
		});
	});

	describe("POST /:id/apply", () => {
		it("applies an approved advisory", async () => {
			const id = seed(db);
			await post(app, `/${id}/approve`, "ack");
			const res = await post(app, `/${id}/apply`, "applied the fix");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; resolution_note: string };
			expect(body.status).toBe("applied");
			expect(body.resolution_note).toBe("applied the fix");
		});

		it("404s an unknown id", async () => {
			expect((await post(app, "/nope/apply", "x")).status).toBe(404);
		});

		it("400s when the advisory is still proposed (must be approved first)", async () => {
			const id = seed(db);
			const res = await post(app, `/${id}/apply`, "x");
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("Cannot apply advisory in 'proposed' status");
		});

		it("400s when no note is supplied", async () => {
			const id = seed(db);
			await post(app, `/${id}/approve`, "ack");
			expect((await post(app, `/${id}/apply`)).status).toBe(400);
		});
	});

	describe("error paths (500) when the datastore throws", () => {
		// Closing the underlying DB makes every repository query throw, which
		// drives each handler's catch block and the 500 responses.
		it("GET / returns 500 when the list query throws", async () => {
			db.close();
			const res = await app.request("/");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to list advisories");
		});

		it("GET /count returns 500 when the count query throws", async () => {
			db.close();
			const res = await app.request("/count");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to count advisories");
		});

		it("POST approve returns 500 when the lookup throws", async () => {
			db.close();
			const res = await post(app, "/any/approve", "note");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to approve advisory");
		});

		it("POST dismiss returns 500 when the lookup throws", async () => {
			db.close();
			const res = await post(app, "/any/dismiss", "note");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to dismiss advisory");
		});

		it("POST defer returns 500 when the lookup throws", async () => {
			db.close();
			const res = await post(app, "/any/defer", "note");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to defer advisory");
		});

		it("POST apply returns 500 when the lookup throws", async () => {
			db.close();
			const res = await post(app, "/any/apply", "note");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to apply advisory");
		});
	});

	describe("repository result errors (500) when the transition update fails", () => {
		// The lookup succeeds, but the lifecycle helper returns {ok:false}. Driving
		// the if(!result.ok) branch in each handler with spyOn.
		it("approve surfaces a failed result as 500", async () => {
			const id = seed(db);
			const spy = spyOn(agent, "approveAdvisory").mockReturnValue({
				ok: false,
				error: new Error("update blew up"),
			});
			try {
				const res = await post(app, `/${id}/approve`, "note");
				expect(res.status).toBe(500);
				const body = await res.json();
				expect(body.error).toBe("Failed to approve advisory");
				expect(body.details).toBe("update blew up");
			} finally {
				spy.mockRestore();
			}
		});

		it("dismiss surfaces a failed result as 500", async () => {
			const id = seed(db);
			const spy = spyOn(agent, "dismissAdvisory").mockReturnValue({
				ok: false,
				error: new Error("update blew up"),
			});
			try {
				const res = await post(app, `/${id}/dismiss`, "note");
				expect(res.status).toBe(500);
				expect((await res.json()).error).toBe("Failed to dismiss advisory");
			} finally {
				spy.mockRestore();
			}
		});

		it("defer surfaces a failed result as 500", async () => {
			const id = seed(db);
			const spy = spyOn(agent, "deferAdvisory").mockReturnValue({
				ok: false,
				error: new Error("update blew up"),
			});
			try {
				const res = await post(app, `/${id}/defer`, "note");
				expect(res.status).toBe(500);
				expect((await res.json()).error).toBe("Failed to defer advisory");
			} finally {
				spy.mockRestore();
			}
		});

		it("apply surfaces a failed result as 500", async () => {
			const id = seed(db);
			await post(app, `/${id}/approve`, "ack");
			const spy = spyOn(agent, "applyAdvisory").mockReturnValue({
				ok: false,
				error: new Error("update blew up"),
			});
			try {
				const res = await post(app, `/${id}/apply`, "note");
				expect(res.status).toBe(500);
				expect((await res.json()).error).toBe("Failed to apply advisory");
			} finally {
				spy.mockRestore();
			}
		});
	});
});
