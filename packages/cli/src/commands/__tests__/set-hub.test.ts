import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, findClusterConfigValueByKey } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runSetHub } from "../set-hub.js";

/**
 * runSetHub opens bound.db in a `data` directory that is a SIBLING of the
 * config directory (dirname(resolve(configDir))/data) and reads sync config
 * from configDir. So the fixture lays out <root>/config and <root>/data.
 *
 * The drain loop polls countPendingPeerTargetedDurableWork; with no durable
 * work rows it drains immediately (one pass), keeping these tests fast.
 */

const SITE = "set-hub-site";

describe("runSetHub", () => {
	let root: string;
	let configDir: string;
	let dataDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bound-sethub-"));
		configDir = join(root, "config");
		dataDir = join(root, "data");
		mkdirSync(configDir, { recursive: true });
		mkdirSync(dataDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTmpDir(root);
	});

	function setupDb(withSiteId = true) {
		const db = createDatabase(join(dataDir, "bound.db"));
		applySchema(db);
		if (withSiteId) {
			db.exec("INSERT OR REPLACE INTO host_meta (key, value) VALUES ('site_id', ?)", [SITE]);
		}
		db.close();
	}

	function silenceConsole() {
		const origLog = console.log;
		const origWarn = console.warn;
		const lines: string[] = [];
		console.log = (msg?: unknown) => lines.push(String(msg ?? ""));
		console.warn = (msg?: unknown) => lines.push(String(msg ?? ""));
		return {
			lines,
			restore: () => {
				console.log = origLog;
				console.warn = origWarn;
			},
		};
	}

	it("sets the cluster_hub key and clears the drain flag when spool is empty", async () => {
		setupDb();
		const cap = silenceConsole();
		try {
			await runSetHub({ hostName: "new-hub", configDir });
		} finally {
			cap.restore();
		}

		const db = createDatabase(join(dataDir, "bound.db"));
		const hub = findClusterConfigValueByKey(db, "cluster_hub");
		expect(hub?.value).toBe("new-hub");

		// Drain flag set then cleared → no relay_draining row remains.
		const draining = db.query("SELECT value FROM host_meta WHERE key = 'relay_draining'").get() as {
			value: string;
		} | null;
		expect(draining).toBeNull();
		db.close();

		const joined = cap.lines.join("\n");
		expect(joined).toContain("Setting cluster hub to: new-hub");
		expect(joined).toContain("Relay drain mode enabled.");
		expect(joined).toContain("Durable peer spool drained successfully.");
		expect(joined).toContain("Cluster hub set successfully.");
		expect(joined).toContain("Relay drain mode disabled.");
	});

	it("un-tombstones a previously soft-deleted cluster_hub key via UPDATE", async () => {
		// Seed an existing (live) cluster_hub, then re-set to confirm UPDATE path.
		setupDb();
		const cap = silenceConsole();
		try {
			await runSetHub({ hostName: "hub-one", configDir });
			await runSetHub({ hostName: "hub-two", configDir });
		} finally {
			cap.restore();
		}

		const db = createDatabase(join(dataDir, "bound.db"));
		const hub = findClusterConfigValueByKey(db, "cluster_hub");
		expect(hub?.value).toBe("hub-two");
		// Exactly one row for cluster_hub (UPDATE, not a second INSERT).
		const count = db
			.query("SELECT COUNT(*) AS n FROM cluster_config WHERE key = 'cluster_hub'")
			.get() as { n: number };
		expect(count.n).toBe(1);
		db.close();
	});

	it("throws when site_id is unreadable", async () => {
		setupDb(false);
		const cap = silenceConsole();
		let threw = false;
		try {
			await runSetHub({ hostName: "hub", configDir });
		} catch (error) {
			threw = true;
			expect(error instanceof Error ? error.message : "").toContain("Failed to read site_id");
		} finally {
			cap.restore();
		}
		expect(threw).toBe(true);
	});

	it("reads relay.drain_timeout_seconds from sync config", async () => {
		setupDb();
		// A sync.json with a custom drain timeout — surfaces in the drain log line.
		writeFileSync(
			join(configDir, "sync.json"),
			JSON.stringify({ relay: { drain_timeout_seconds: 7 } }),
		);
		const cap = silenceConsole();
		try {
			await runSetHub({ hostName: "hub", configDir });
		} finally {
			cap.restore();
		}
		expect(cap.lines.join("\n")).toContain("timeout: 7s");
	});

	it("with --wait and no peers, reports nothing to wait for", async () => {
		setupDb();
		const cap = silenceConsole();
		try {
			await runSetHub({ hostName: "hub", wait: true, timeout: 5, configDir });
		} finally {
			cap.restore();
		}
		const joined = cap.lines.join("\n");
		expect(joined).toContain("Waiting for all peers to confirm...");
		expect(joined).toContain("No peers found in sync_state. Nothing to wait for.");
		expect(joined).toContain("All peers confirmed the hub change.");
	});

	it("with --wait and an already-confirmed peer, confirms immediately", async () => {
		setupDb();
		// Seed a sync_state peer whose last_sync_at is in the future, so it is
		// counted as confirmed on the first poll (last_sync_at > hubChangeTimestamp).
		const db = createDatabase(join(dataDir, "bound.db"));
		const future = new Date(Date.now() + 3600_000).toISOString();
		db.exec(
			`INSERT INTO sync_state (peer_site_id, last_sync_at)
			 VALUES ('peer-a', ?)`,
			[future],
		);
		db.close();

		const cap = silenceConsole();
		try {
			await runSetHub({ hostName: "hub", wait: true, timeout: 5, configDir });
		} finally {
			cap.restore();
		}
		const joined = cap.lines.join("\n");
		expect(joined).toContain("confirmed)");
		expect(joined).toContain("All peers confirmed the hub change.");
	});

	it("warns and proceeds when the drain timeout elapses with pending peer spool entries", async () => {
		setupDb();
		// A sub-second drain timeout + a peer-targeted durable_work row that never
		// clears forces the drain loop to iterate and then time out.
		writeFileSync(
			join(configDir, "sync.json"),
			JSON.stringify({ relay: { drain_timeout_seconds: 1 } }),
		);
		const now = new Date().toISOString();
		const seed = createDatabase(join(dataDir, "bound.db"));
		seed.exec(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at)
			 VALUES ('dw-1', 'peer-x', 'inference', '{}', 'idem-1', 'pending', 0, ?)`,
			[now],
		);
		seed.close();

		const cap = silenceConsole();
		try {
			await runSetHub({ hostName: "hub", configDir });
		} finally {
			cap.restore();
		}
		const joined = cap.lines.join("\n");
		expect(joined).toContain("entries remaining");
		expect(joined).toContain("Drain timeout reached");
		// The hub is still set despite the undrained spool.
		const db = createDatabase(join(dataDir, "bound.db"));
		expect(findClusterConfigValueByKey(db, "cluster_hub")?.value).toBe("hub");
		db.close();
	});

	it("with --wait, warns on timeout when a peer never confirms the hub change", async () => {
		setupDb();
		// A peer whose last_sync_at is in the PAST (before the hub change) never
		// counts as confirmed; the short --wait timeout then elapses.
		const past = new Date(Date.now() - 3600_000).toISOString();
		const seed = createDatabase(join(dataDir, "bound.db"));
		seed.exec(`INSERT INTO sync_state (peer_site_id, last_sync_at) VALUES ('stale-peer', ?)`, [
			past,
		]);
		seed.close();

		const cap = silenceConsole();
		try {
			// timeout:0 → the while-loop condition is immediately false after one check.
			await runSetHub({ hostName: "hub", wait: true, timeout: 0, configDir });
		} finally {
			cap.restore();
		}
		expect(cap.lines.join("\n")).toContain("Timeout: not all peers confirmed. The hub IS set");
	});
});
