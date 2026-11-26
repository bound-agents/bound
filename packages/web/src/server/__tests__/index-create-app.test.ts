import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { applyMetricsSchema, applySchema } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createWebApp } from "../index";
import * as responsesRoutes from "../routes/responses";

// Covers the createWebApp wiring branches the integration test does not:
// the required-operatorUserId guard and the Host-header DNS-rebinding
// middleware (accept loopback, reject anything else).

describe("createWebApp wiring", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		eventBus = new TypedEventEmitter();
	});

	afterEach(() => {
		db.close();
	});

	it("throws when operatorUserId is missing", async () => {
		await expect(createWebApp(db, eventBus, { operatorUserId: "" } as never)).rejects.toThrow(
			"operatorUserId is required",
		);
	});

	it("accepts a request with a localhost Host header", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "op" });
		const res = await app.fetch(
			new Request("http://localhost:3001/api/status", {
				headers: { host: "localhost:3001" },
			}),
		);
		expect(res.status).toBe(200);
	});

	it("accepts 127.0.0.1 and [::1] loopback Host headers", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "op" });
		for (const host of ["127.0.0.1:3001", "[::1]:3001"]) {
			const res = await app.fetch(
				new Request("http://localhost:3001/api/status", { headers: { host } }),
			);
			expect(res.status).toBe(200);
		}
	});

	it("rejects a non-loopback Host header (DNS-rebinding protection)", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "op" });
		const res = await app.fetch(
			new Request("http://localhost:3001/api/status", {
				headers: { host: "evil.example.com" },
			}),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid Host header");
	});

	it("falls back to static serving when no embedded assets are present (SPA fallback 404)", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "op" });
		// With no embedded assets and no ./dist/client, an unknown path falls
		// through serveStatic and 404s rather than matching an API route.
		const res = await app.fetch(
			new Request("http://localhost:3001/not-an-api-route", {
				headers: { host: "localhost" },
			}),
		);
		expect(res.status).toBe(404);
	});

	it("forwards topologyRole to the responses route", async () => {
		const spy = spyOn(responsesRoutes, "createResponsesRoutes");
		try {
			await createWebApp(db, eventBus, { operatorUserId: "op", topologyRole: "spoke" });
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0][5]).toBe("spoke");
		} finally {
			spy.mockRestore();
		}
	});

	it("runs onRequest before the routes it registers", async () => {
		const seen: string[] = [];
		const app = await createWebApp(db, eventBus, {
			operatorUserId: "op",
			onRequest: (method, path) => seen.push(`${method} ${path}`),
		});
		const res = await app.fetch(
			new Request("http://localhost:3001/api/status", { headers: { host: "localhost" } }),
		);
		expect(res.status).toBe(200);
		expect(seen).toEqual(["GET /api/status"]);
	});
});
