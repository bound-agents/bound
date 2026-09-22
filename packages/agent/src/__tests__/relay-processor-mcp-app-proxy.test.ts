import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, readDurableResponseByRefId } from "@bound/core";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import type { MCPClient } from "../mcp-client";
import { RelayProcessor } from "../relay-processor";

const OWNER_SITE = "owner-site";

const createMockEventBus = (): TypedEventEmitter =>
	new (require("@bound/shared").TypedEventEmitter)();

const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

let db: Database;

beforeEach(() => {
	db = new (require("bun:sqlite").Database)(":memory:");
	applySchema(db);
	db.run(
		`INSERT INTO hosts (site_id, host_name, version, modified_at, deleted)
		 VALUES (?, ?, ?, ?, ?)`,
		[OWNER_SITE, "owner", "1.0.0", new Date().toISOString(), 0],
	);
});

/** Insert a self-loopback mcp_app_proxy request so the response rides the local lane. */
function insertProxyRequest(
	database: Database,
	id: string,
	payload: Record<string, unknown>,
): void {
	const now = new Date();
	database.run(
		`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, ref_id, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
		[
			id,
			OWNER_SITE,
			"mcp_app_proxy",
			JSON.stringify(payload),
			id,
			id,
			now.toISOString(),
			new Date(now.getTime() + 60000).toISOString(),
			OWNER_SITE,
			now.toISOString(),
		],
	);
}

function makeProcessor(): RelayProcessor {
	return new RelayProcessor(
		db,
		OWNER_SITE,
		new Map<string, MCPClient>(),
		null,
		createMockLogger(),
		createMockEventBus(),
	);
}

describe("RelayProcessor mcp_app_proxy (R-MO27b LEG B owner side)", () => {
	it("resolves config, attaches the owner token, never forwards a browser credential", async () => {
		let fetchedUrl: string | null = null;
		let sentHeaders: Headers | null = null;
		const consumer = async (payload: {
			server_name: string;
			method: string;
			headers: Record<string, string>;
			body_base64: string;
		}) => {
			// Simulate the owner-side handler: resolve URL from config, attach a
			// token, fetch. Assert the relayed payload never carried a browser cred.
			expect(payload.server_name).toBe("gh");
			expect(payload.headers.authorization).toBeUndefined();
			expect(payload.headers.cookie).toBeUndefined();
			expect(payload.headers["content-type"]).toBe("application/json");
			const headers = new Headers(payload.headers);
			headers.set("authorization", "Bearer owner-token");
			fetchedUrl = "https://gh.example/mcp";
			sentHeaders = headers;
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body_base64: Buffer.from('{"ok":true}').toString("base64"),
			};
		};

		const processor = makeProcessor();
		processor.setMcpAppProxyConsumer(consumer);

		insertProxyRequest(db, "proxy-1", {
			server_name: "gh",
			method: "POST",
			headers: { "content-type": "application/json" },
			body_base64: Buffer.from('{"jsonrpc":"2.0"}').toString("base64"),
		});

		const handle = processor.start(10);
		await Bun.sleep(150);
		handle.stop();

		expect(fetchedUrl).toBe("https://gh.example/mcp");
		expect((sentHeaders as unknown as Headers)?.get("authorization")).toBe("Bearer owner-token");

		// The owner relayed a `result` response over the response:<requestId> lane.
		const response = readDurableResponseByRefId(db, "proxy-1", OWNER_SITE);
		expect(response).not.toBeNull();
		expect(response?.kind).toBe("result");
		const parsed = JSON.parse(response?.payload ?? "{}") as {
			status: number;
			body_base64: string;
		};
		expect(parsed.status).toBe(200);
		expect(Buffer.from(parsed.body_base64, "base64").toString()).toBe('{"ok":true}');
	});

	it("with no consumer wired: relays back an error, does not silently drop", async () => {
		const processor = makeProcessor();
		// No setMcpAppProxyConsumer call.
		insertProxyRequest(db, "proxy-2", {
			server_name: "gh",
			method: "POST",
			headers: {},
			body_base64: "",
		});

		const handle = processor.start(10);
		await Bun.sleep(150);
		handle.stop();

		const response = readDurableResponseByRefId(db, "proxy-2", OWNER_SITE);
		expect(response).not.toBeNull();
		expect(response?.kind).toBe("error");
		const parsed = JSON.parse(response?.payload ?? "{}") as { error: string };
		expect(parsed.error).toContain("no MCP-App proxy consumer wired");
	});

	it("consumer throw relays a retriable error", async () => {
		const processor = makeProcessor();
		processor.setMcpAppProxyConsumer(async () => {
			throw new Error("upstream refused connection");
		});
		insertProxyRequest(db, "proxy-3", {
			server_name: "gh",
			method: "POST",
			headers: {},
			body_base64: "",
		});

		const handle = processor.start(10);
		await Bun.sleep(150);
		handle.stop();

		const response = readDurableResponseByRefId(db, "proxy-3", OWNER_SITE);
		expect(response?.kind).toBe("error");
		const parsed = JSON.parse(response?.payload ?? "{}") as {
			error: string;
			retriable: boolean;
		};
		expect(parsed.error).toContain("upstream fetch failed");
		expect(parsed.retriable).toBe(true);
	});
});
