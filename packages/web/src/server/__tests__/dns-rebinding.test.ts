import { beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createWebApp } from "../index";

/**
 * DNS-rebinding protection: the web app rejects any request whose Host header
 * is not a loopback address. Sync endpoints live on a separate listener and
 * are NOT part of the web app — they have their own Ed25519 auth.
 *
 * Note: Hono's app.fetch() does not derive the Host header from the request URL;
 * we must set it explicitly to exercise the middleware.
 */
describe("DNS-rebinding protection", () => {
	let db: ReturnType<typeof createDatabase>;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		eventBus = new TypedEventEmitter();
	});

	// ── API routes — Host check must fire ─────────────────────────────────────

	it("blocks requests with an external Host header on /api/threads", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/threads", {
			headers: { Host: "hub.example.com" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({ error: "Invalid Host header" });
	});

	it("blocks requests with an external Host header on /api/files", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/files", {
			headers: { Host: "attacker.local" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({ error: "Invalid Host header" });
	});

	// ── Localhost — API routes must remain accessible ─────────────────────────

	it("allows requests with Host: localhost on API routes", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/threads", {
			headers: { Host: "localhost" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
	});

	it("allows requests with Host: 127.0.0.1 on API routes", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/threads", {
			headers: { Host: "127.0.0.1" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
	});

	// ── IPv6 loopback — bracket-aware Host parsing ────────────────────────────
	// `[::1]` must be accepted both bare and with a port. The naive
	// `host.split(":")[0]` would yield "[" and reject these, so these cases
	// guard the bracket-handling branch against regression.

	it("allows requests with Host: [::1] on API routes", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/threads", {
			headers: { Host: "[::1]" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
	});

	it("allows requests with Host: [::1]:3000 (IPv6 loopback with port) on API routes", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/threads", {
			headers: { Host: "[::1]:3000" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
	});

	it("blocks requests with a non-loopback IPv6 Host on API routes", async () => {
		const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/threads", {
			headers: { Host: "[2001:db8::1]" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(400);
	});
});
