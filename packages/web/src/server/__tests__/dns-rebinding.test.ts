import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createApp } from "../index";

/**
 * DNS-rebinding protection: the web UI and /api/* routes carry no auth of their
 * own, so we protect them by rejecting any request whose Host header is not a
 * loopback address.  The sync endpoints (/sync/* and /api/relay-deliver) are
 * protected by Ed25519 signature verification instead — the Host check would
 * prevent remote spokes from reaching a hub, so those paths must be exempt.
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
		eventBus = new TypedEventEmitter();
	});

	// ── UI / API routes — Host check must fire ────────────────────────────────

	it("blocks requests with an external Host header on /api/threads", async () => {
		const app = await createApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/threads", {
			headers: { Host: "hub.example.com" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({ error: "Invalid Host header" });
	});

	it("blocks requests with an external Host header on /api/files", async () => {
		const app = await createApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/files", {
			headers: { Host: "attacker.local" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({ error: "Invalid Host header" });
	});

	// ── Sync routes — Host check must NOT fire ────────────────────────────────

	it("does not block /sync/push with an external Host header", async () => {
		const app = await createApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/sync/push", {
			method: "POST",
			headers: { "Content-Type": "application/json", Host: "hub.example.com" },
			body: "{}",
		});
		const res = await app.fetch(req);

		// Must not be the Host-check rejection — actual status is 401/403/404
		// depending on sync route mount, but the response body must not say "Invalid Host header"
		const text = await res.text();
		expect(text).not.toContain("Invalid Host header");
	});

	it("does not block /sync/pull with an external Host header", async () => {
		const app = await createApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/sync/pull", {
			method: "POST",
			headers: { "Content-Type": "application/json", Host: "hub.example.com" },
			body: "{}",
		});
		const res = await app.fetch(req);

		const text = await res.text();
		expect(text).not.toContain("Invalid Host header");
	});

	it("does not block /api/relay-deliver with an external Host header", async () => {
		const app = await createApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/relay-deliver", {
			method: "POST",
			headers: { "Content-Type": "application/json", Host: "hub.example.com" },
			body: JSON.stringify({ entries: [] }),
		});
		const res = await app.fetch(req);

		const text = await res.text();
		expect(text).not.toContain("Invalid Host header");
	});

	// ── Localhost — UI routes must remain accessible ──────────────────────────

	it("allows requests with Host: localhost on UI API routes", async () => {
		const app = await createApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/threads", {
			headers: { Host: "localhost" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
	});

	it("allows requests with Host: 127.0.0.1 on UI API routes", async () => {
		const app = await createApp(db, eventBus, { operatorUserId: "test-operator" });
		const req = new Request("http://localhost:3000/api/threads", {
			headers: { Host: "127.0.0.1" },
		});
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
	});
});
