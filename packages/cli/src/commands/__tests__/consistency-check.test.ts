import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runConsistencyCheck } from "../consistency-check";

/**
 * A fake spoke web router over Bun.serve on an ephemeral port, serving the
 * single endpoint the command hits: POST /api/status/consistency.
 */
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

/** JSON Response helper for the fake spoke. */
function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("runConsistencyCheck", () => {
	let logs: string[];
	let origLog: typeof console.log;

	beforeEach(() => {
		logs = [];
		origLog = console.log;
		console.log = (m?: unknown) => logs.push(m === undefined ? "" : String(m));
	});

	afterEach(() => {
		console.log = origLog;
	});

	it("reports all-consistent when no table drifts", async () => {
		const spoke = fakeSpoke(() =>
			json({
				localSiteId: "site-local",
				tables: [
					{
						table: "messages",
						localCount: 10,
						remoteCount: 10,
						localOnly: [],
						remoteOnly: [],
						matching: 10,
					},
				],
			}),
		);
		try {
			await runConsistencyCheck({ spokeUrl: spoke.url });
		} finally {
			spoke.stop();
		}
		const out = logs.join("\n");
		expect(out).toContain("Local site: site-local");
		expect(out).toContain("messages");
		expect(out).toContain("OK");
		expect(out).toContain("All tables are consistent.");
	});

	it("reports drift with local-only and remote-only counts", async () => {
		const spoke = fakeSpoke(() =>
			json({
				localSiteId: "site-local",
				tables: [
					{
						table: "tasks",
						localCount: 5,
						remoteCount: 4,
						localOnly: ["a", "b"],
						remoteOnly: ["c"],
						matching: 3,
					},
				],
			}),
		);
		try {
			await runConsistencyCheck({ spokeUrl: spoke.url });
		} finally {
			spoke.stop();
		}
		const out = logs.join("\n");
		expect(out).toContain("DRIFT");
		expect(out).toContain("1 table(s) with discrepancies");
		expect(out).toContain("2 local-only");
		expect(out).toContain("1 remote-only");
	});

	it("verbose mode lists the drifting primary keys and a '... more' tail", async () => {
		const localOnly = Array.from({ length: 12 }, (_, i) => `pk-${i}`);
		const spoke = fakeSpoke(() =>
			json({
				localSiteId: "site-local",
				tables: [
					{
						table: "threads",
						localCount: 12,
						remoteCount: 0,
						localOnly,
						remoteOnly: ["r1"],
						matching: 0,
					},
				],
			}),
		);
		try {
			await runConsistencyCheck({ spokeUrl: spoke.url, verbose: true });
		} finally {
			spoke.stop();
		}
		const out = logs.join("\n");
		expect(out).toContain("+ pk-0");
		expect(out).toContain("... and 2 more"); // 12 local-only, 10 shown
		expect(out).toContain("- r1");
	});

	it("subtracts unsyncable rows from the drift accounting", async () => {
		const spoke = fakeSpoke(() =>
			json({
				localSiteId: "site-local",
				tables: [
					{
						table: "turns",
						localCount: 3,
						remoteCount: 0,
						localOnly: ["x", "y", "z"],
						remoteOnly: [],
						matching: 0,
					},
				],
				unsyncable: [{ table: "turns", count: 3, reason: "local-only telemetry" }],
			}),
		);
		try {
			await runConsistencyCheck({ spokeUrl: spoke.url });
		} finally {
			spoke.stop();
		}
		const out = logs.join("\n");
		// All 3 local-only rows are unsyncable, so the table reads OK, not DRIFT.
		expect(out).toContain("OK");
		expect(out).toContain("All tables are consistent.");
		expect(out).toContain("Unsyncable rows (excluded from comparison):");
		expect(out).toContain("turns: 3 rows — local-only telemetry");
	});

	it("passes a --tables filter through to the request body", async () => {
		let receivedBody: { tables: string[] } = { tables: [] };
		const spoke = fakeSpoke(async (req) => {
			receivedBody = (await req.json()) as { tables: string[] };
			return json({ localSiteId: "s", tables: [] });
		});
		try {
			await runConsistencyCheck({ spokeUrl: spoke.url, tables: "messages, tasks" });
		} finally {
			spoke.stop();
		}
		expect(receivedBody.tables).toEqual(["messages", "tasks"]);
	});

	it("throws an actionable error when the spoke is unreachable", async () => {
		const spoke = fakeSpoke(() => json({}));
		const url = spoke.url;
		spoke.stop();
		await expect(runConsistencyCheck({ spokeUrl: url })).rejects.toThrow(/Cannot reach spoke/);
	});

	it("surfaces a non-ok response's error detail", async () => {
		const spoke = fakeSpoke(() => json({ error: "boom", details: "table locked" }, 500));
		try {
			await expect(runConsistencyCheck({ spokeUrl: spoke.url })).rejects.toThrow(
				/Consistency check failed: table locked/,
			);
		} finally {
			spoke.stop();
		}
	});
});
