import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema } from "@bound/core";
import { type CliIO, main } from "../boundctl-main";

/**
 * HTTP-backed boundctl dispatch bodies: `consistency-check` POSTs to a spoke web
 * router, and `drain` delegates to the hub-switch path. Both success bodies are
 * driven here against a fake spoke served over Bun.serve on an ephemeral port,
 * so the instrumented dispatch + success/failure arms execute.
 */

function captureIO(): { io: CliIO; logs: string[]; errors: string[] } {
	const logs: string[] = [];
	const errors: string[] = [];
	return {
		io: { log: (m) => logs.push(m), error: (m) => errors.push(m) },
		logs,
		errors,
	};
}

/** Fake spoke web router: serves POST /api/status/consistency with `handler`. */
function fakeSpoke(handler: (req: Request) => Response | Promise<Response>): {
	url: string;
	stop: () => void;
} {
	const server = Bun.serve({
		port: 0,
		hostname: "localhost",
		async fetch(req) {
			const url = new URL(req.url);
			if (req.method === "POST" && url.pathname === "/api/status/consistency") {
				return handler(req);
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("boundctl main() — consistency-check dispatch body", () => {
	it("routes consistency-check through main() against a fake spoke (exit 0)", async () => {
		const spoke = fakeSpoke(() =>
			json({
				localSiteId: "site-local",
				tables: [
					{
						table: "users",
						localCount: 3,
						remoteCount: 3,
						localOnly: [],
						remoteOnly: [],
						matching: 3,
					},
				],
			}),
		);
		try {
			const { io, errors } = captureIO();
			const code = await main(["consistency-check", "--spoke-url", spoke.url], io);
			expect(code).toBe(0);
			expect(errors).toEqual([]);
		} finally {
			spoke.stop();
		}
	});

	it("passes --tables and --verbose through to the dispatched command (exit 0)", async () => {
		let receivedBody: unknown = null;
		const spoke = fakeSpoke(async (req) => {
			receivedBody = await req.json();
			return json({
				localSiteId: "site-local",
				tables: [
					{
						table: "tasks",
						localCount: 2,
						remoteCount: 1,
						localOnly: ["task-a"],
						remoteOnly: [],
						matching: 1,
					},
				],
			});
		});
		try {
			const { io } = captureIO();
			const code = await main(
				["consistency-check", "--spoke-url", spoke.url, "--tables", "tasks,users", "--verbose"],
				io,
			);
			expect(code).toBe(0);
			expect(receivedBody).toEqual({ tables: ["tasks", "users"] });
		} finally {
			spoke.stop();
		}
	});

	it("maps an unreachable spoke to exit 1 with a dispatch error", async () => {
		const { io, errors } = captureIO();
		// Port 0 is never a live listener; the fetch rejects and the catch arm fires.
		const code = await main(["consistency-check", "--spoke-url", "http://localhost:1"], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("consistency-check failed");
	});

	it("maps a non-ok spoke response to exit 1", async () => {
		const spoke = fakeSpoke(() => json({ error: "boom" }, 500));
		try {
			const { io, errors } = captureIO();
			const code = await main(["consistency-check", "--spoke-url", spoke.url], io);
			expect(code).toBe(1);
			expect(errors.join("\n")).toContain("consistency-check failed");
		} finally {
			spoke.stop();
		}
	});
});

describe("boundctl main() — drain dispatch body", () => {
	let tmp: string;
	let configDir: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), `boundctl-drain-${randomBytes(4).toString("hex")}-`));
		configDir = join(tmp, "config");
		const dataDir = join(tmp, "data");
		mkdirSync(configDir);
		mkdirSync(dataDir);
		const db = new Database(join(dataDir, "bound.db"));
		applySchema(db);
		applyMetricsSchema(db);
		db.query("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", "site-drain-1");
		db.close();
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("routes drain with a short timeout through main() and returns 0", async () => {
		// With no peers and an empty durable-peer spool, drain completes promptly.
		const { io, errors } = captureIO();
		const code = await main(["drain", "new-hub", "--timeout", "1", "--config-dir", configDir], io);
		expect(code).toBe(0);
		expect(errors).toEqual([]);
	});
});
