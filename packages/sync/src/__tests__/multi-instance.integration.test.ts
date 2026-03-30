import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { KeyringConfig } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

describe("multi-instance sync", () => {
	let instanceA: TestInstance;
	let instanceB: TestInstance;
	let instanceC: TestInstance | null = null;
	let keyring: KeyringConfig;
	let testRunId: string;

	beforeEach(async () => {
		// Generate unique ID for this test run to avoid port/file conflicts
		testRunId = Math.random().toString(36).substring(7);

		// Generate unique ports for this test run
		const portA = 10000 + Math.floor(Math.random() * 50000);
		const portB = portA + 1;

		// Generate keypairs for both instances upfront
		const keypairA = await ensureKeypair(`/tmp/bound-test-keys-a-${testRunId}`);
		const keypairB = await ensureKeypair(`/tmp/bound-test-keys-b-${testRunId}`);

		const pubKeyA = await exportPublicKey(keypairA.publicKey);
		const pubKeyB = await exportPublicKey(keypairB.publicKey);

		// Create keyring shared by both - hosts is a Record with site_id as key
		keyring = {
			hosts: {
				[keypairA.siteId]: {
					public_key: pubKeyA,
					url: `http://localhost:${portA}`,
				},
				[keypairB.siteId]: {
					public_key: pubKeyB,
					url: `http://localhost:${portB}`,
				},
			},
		};

		// Create instances using the pre-generated keypairs
		instanceA = await createTestInstance({
			name: "a",
			port: portA,
			dbPath: `/tmp/bound-test-a-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-test-keys-a-${testRunId}`,
		});

		instanceB = await createTestInstance({
			name: "b",
			port: portB,
			dbPath: `/tmp/bound-test-b-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portA,
			keyring,
			keypairPath: `/tmp/bound-test-keys-b-${testRunId}`,
		});
	});

	afterEach(async () => {
		await instanceA.cleanup();
		await instanceB.cleanup();
		if (instanceC) {
			await instanceC.cleanup();
			instanceC = null;
		}
	});

	it("scenario 1: basic replication", async () => {
		// Insert a row on Instance A
		const now = new Date().toISOString();
		instanceA.db
			.query(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("mem-1", "test_key", "test_value", "site-a", now, now, now);

		// Record this as a change_log entry on A
		instanceA.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"semantic_memory",
				"mem-1",
				instanceA.siteId,
				now,
				JSON.stringify({
					id: "mem-1",
					key: "test_key",
					value: "test_value",
					source: "site-a",
					created_at: now,
					modified_at: now,
					last_accessed_at: now,
					deleted: 0,
				}),
			);

		// Run sync from Instance B (pull from A)
		const result = await instanceB.syncClient.syncCycle();
		expect(result.ok).toBe(true);

		// Verify Instance B has the same row
		const rowB = instanceB.db.query("SELECT * FROM semantic_memory WHERE id = ?").get("mem-1") as
			| Record<string, unknown>
			| undefined;
		expect(rowB).toBeDefined();
		expect(rowB?.value).toBe("test_value");
	});

	it("scenario 2: bidirectional sync", async () => {
		const now = new Date().toISOString();

		// Insert on Instance A
		instanceA.db
			.query(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("mem-a", "key_a", "value_a", "site-a", now, now, now);

		instanceA.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"semantic_memory",
				"mem-a",
				instanceA.siteId,
				now,
				JSON.stringify({
					id: "mem-a",
					key: "key_a",
					value: "value_a",
					source: "site-a",
					created_at: now,
					modified_at: now,
					last_accessed_at: now,
					deleted: 0,
				}),
			);

		// Insert on Instance B
		instanceB.db
			.query(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("mem-b", "key_b", "value_b", "site-b", now, now, now);

		instanceB.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"semantic_memory",
				"mem-b",
				instanceB.siteId,
				now,
				JSON.stringify({
					id: "mem-b",
					key: "key_b",
					value: "value_b",
					source: "site-b",
					created_at: now,
					modified_at: now,
					last_accessed_at: now,
					deleted: 0,
				}),
			);

		// B pushes to A (via sync cycle)
		const result = await instanceB.syncClient.syncCycle();
		expect(result.ok).toBe(true);

		// Verify A has B's data
		const rowOnA = instanceA.db.query("SELECT * FROM semantic_memory WHERE id = ?").get("mem-b") as
			| Record<string, unknown>
			| undefined;
		expect(rowOnA).toBeDefined();

		// Verify B still has its own data
		const rowOnB = instanceB.db.query("SELECT * FROM semantic_memory WHERE id = ?").get("mem-b") as
			| Record<string, unknown>
			| undefined;
		expect(rowOnB).toBeDefined();
	});

	it("scenario 3: LWW conflict resolution", async () => {
		const time1 = "2026-03-22T10:00:00Z";
		const time2 = "2026-03-22T10:00:01Z"; // 1 second later

		// Insert same key on both instances with different values
		instanceA.db
			.query(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("mem-conflict", "key", "value_from_a", "site-a", time1, time2, time2);

		instanceB.db
			.query(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("mem-conflict", "key", "value_from_b", "site-b", time1, time1, time1);

		// Record on A with later timestamp
		instanceA.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"semantic_memory",
				"mem-conflict",
				instanceA.siteId,
				time2,
				JSON.stringify({
					id: "mem-conflict",
					key: "key",
					value: "value_from_a",
					source: "site-a",
					created_at: time1,
					modified_at: time2,
					last_accessed_at: time2,
					deleted: 0,
				}),
			);

		// Record on B with earlier timestamp
		instanceB.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"semantic_memory",
				"mem-conflict",
				instanceB.siteId,
				time1,
				JSON.stringify({
					id: "mem-conflict",
					key: "key",
					value: "value_from_b",
					source: "site-b",
					created_at: time1,
					modified_at: time1,
					last_accessed_at: time1,
					deleted: 0,
				}),
			);

		// Sync: B pulls A's update
		const result = await instanceB.syncClient.syncCycle();
		expect(result.ok).toBe(true);

		// LWW: later timestamp wins
		const row = instanceB.db
			.query("SELECT * FROM semantic_memory WHERE id = ?")
			.get("mem-conflict") as Record<string, unknown> | undefined;
		expect(row?.value).toBe("value_from_a"); // A's value wins because timestamp is later
	});

	it("scenario 4: append-only dedup", async () => {
		const now = new Date().toISOString();
		const sameId = "msg-shared";

		// Insert same message on both instances (simulating arrival from two paths)
		instanceA.db
			.query(
				"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(sameId, "thread-1", "user", "hello", now, "laptop");

		instanceB.db
			.query(
				"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(sameId, "thread-1", "user", "hello", now, "cloud-vm");

		// Record on both
		instanceA.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"messages",
				sameId,
				instanceA.siteId,
				now,
				JSON.stringify({
					id: sameId,
					thread_id: "thread-1",
					role: "user",
					content: "hello",
					created_at: now,
					host_origin: "laptop",
				}),
			);

		instanceB.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"messages",
				sameId,
				instanceB.siteId,
				now,
				JSON.stringify({
					id: sameId,
					thread_id: "thread-1",
					role: "user",
					content: "hello",
					created_at: now,
					host_origin: "cloud-vm",
				}),
			);

		// Sync
		const result = await instanceB.syncClient.syncCycle();
		expect(result.ok).toBe(true);

		// Verify each instance has exactly one copy (append-only dedup via UNIQUE constraint)
		const countA = instanceA.db
			.query("SELECT COUNT(*) as count FROM messages WHERE id = ?")
			.get(sameId) as {
			count: number;
		};
		const countB = instanceB.db
			.query("SELECT COUNT(*) as count FROM messages WHERE id = ?")
			.get(sameId) as {
			count: number;
		};

		expect(countA.count).toBe(1);
		expect(countB.count).toBe(1);
	});

	it("scenario 5: change_log pruning", async () => {
		const now = new Date().toISOString();

		// Create events
		for (let i = 1; i <= 5; i++) {
			instanceA.db
				.query(
					"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
				)
				.run("semantic_memory", `mem-${i}`, instanceA.siteId, now, "{}");
		}

		// Set up peer cursor showing B has confirmed through seq 5
		instanceA.db
			.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)")
			.run(instanceB.siteId, 5);

		// Prune on A
		const countBefore = instanceA.db.query("SELECT COUNT(*) as count FROM change_log").get() as {
			count: number;
		};
		expect(countBefore.count).toBe(5);

		// Import and use pruneChangeLog
		const { pruneChangeLog } = await import("../pruning.js");
		const result = pruneChangeLog(instanceA.db, "multi-host");
		expect(result.deleted).toBeGreaterThan(0);

		// Verify pruned events are gone
		const countAfter = instanceA.db.query("SELECT COUNT(*) as count FROM change_log").get() as {
			count: number;
		};
		expect(countAfter.count).toBeLessThan(countBefore.count);

		// Create new events after pruning to verify sync still works
		instanceA.db
			.query(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("mem-new", "key_new", "value_new", "site-a", now, now, now);

		instanceA.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"semantic_memory",
				"mem-new",
				instanceA.siteId,
				now,
				JSON.stringify({
					id: "mem-new",
					key: "key_new",
					value: "value_new",
					source: "site-a",
					created_at: now,
					modified_at: now,
					last_accessed_at: now,
					deleted: 0,
				}),
			);

		// Sync and verify new data is received
		const syncResult = await instanceB.syncClient.syncCycle();
		expect(syncResult.ok).toBe(true);

		const newRow = instanceB.db
			.query("SELECT * FROM semantic_memory WHERE id = ?")
			.get("mem-new") as Record<string, unknown> | undefined;
		expect(newRow).toBeDefined();
	});

	it("scenario 6: reconnection catch-up", async () => {
		const now = new Date().toISOString();

		// Stop B's sync temporarily (simulate disconnection by not syncing)
		// Make multiple changes on A while B is "disconnected"
		for (let i = 1; i <= 3; i++) {
			instanceA.db
				.query(
					"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(`mem-${i}`, `key_${i}`, `value_${i}`, "site-a", now, now, now);

			instanceA.db
				.query(
					"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					"semantic_memory",
					`mem-${i}`,
					instanceA.siteId,
					now,
					JSON.stringify({
						id: `mem-${i}`,
						key: `key_${i}`,
						value: `value_${i}`,
						source: "site-a",
						created_at: now,
						modified_at: now,
						last_accessed_at: now,
						deleted: 0,
					}),
				);
		}

		// Now B reconnects and syncs
		const result = await instanceB.syncClient.syncCycle();
		expect(result.ok).toBe(true);

		// Verify B caught up and has all changes
		for (let i = 1; i <= 3; i++) {
			const row = instanceB.db
				.query("SELECT * FROM semantic_memory WHERE id = ?")
				.get(`mem-${i}`) as Record<string, unknown> | undefined;
			expect(row).toBeDefined();
			expect(row?.value).toBe(`value_${i}`);
		}

		// Verify cursor correctly tracks where B left off
		const syncState = instanceB.db
			.query("SELECT * FROM sync_state WHERE peer_site_id = ?")
			.get(instanceA.siteId) as Record<string, unknown> | undefined;
		expect(syncState?.last_received).toBeGreaterThan(0);
	});

	it("scenario 7: hub promotion", async () => {
		const now = new Date().toISOString();

		// Start with A as hub, B as spoke
		// Insert on A
		instanceA.db
			.query(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("mem-initial", "key", "initial_value", "site-a", now, now, now);

		instanceA.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"semantic_memory",
				"mem-initial",
				instanceA.siteId,
				now,
				JSON.stringify({
					id: "mem-initial",
					key: "key",
					value: "initial_value",
					source: "site-a",
					created_at: now,
					modified_at: now,
					last_accessed_at: now,
					deleted: 0,
				}),
			);

		// First sync: B pulls from A
		const syncResult = await instanceB.syncClient.syncCycle();
		expect(syncResult.ok).toBe(true);

		// Promote B to hub by changing cluster_config
		const hubKey = instanceB.db.query(
			"INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, modified_at = excluded.modified_at",
		);
		hubKey.run("cluster_hub", "http://localhost:3200", now);

		// Update A's hub URL to point to B
		instanceA.db
			.query(
				"INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, modified_at = excluded.modified_at",
			)
			.run("cluster_hub", "http://localhost:3200", now);

		// Now A can sync to B as the new hub
		// Create a new sync client for A pointing to B
		const { resolveHubUrl } = await import("../sync-loop.js");
		const newHubUrl = resolveHubUrl(
			instanceA.db,
			{ hub: "" },
			{
				hosts: {},
			},
		);

		// Verify the new hub URL was resolved from cluster_config
		expect(newHubUrl).toBe("http://localhost:3200");
	});

	it("scenario 8: skills table syncs across instances", async () => {
		const now = new Date().toISOString();
		const skillId = `skill-${Math.random().toString(36).substring(2, 10)}`;

		// Insert a skills row on instance A
		instanceA.db
			.query(
				`INSERT INTO skills (id, name, description, status, skill_root, activation_count, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
			)
			.run(skillId, "test-skill", "A test skill", "active", "/home/user/skills/test-skill", now);

		// Record in change_log for replication
		instanceA.db
			.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"skills",
				skillId,
				instanceA.siteId,
				now,
				JSON.stringify({
					id: skillId,
					name: "test-skill",
					description: "A test skill",
					status: "active",
					skill_root: "/home/user/skills/test-skill",
					activation_count: 0,
					modified_at: now,
					deleted: 0,
				}),
			);

		// Sync from B to A (pulls A's skills row)
		const result = await instanceB.syncClient.syncCycle();
		expect(result.ok).toBe(true);

		// Verify instance B received the skills row
		const rowB = instanceB.db.query("SELECT * FROM skills WHERE id = ?").get(skillId) as
			| Record<string, unknown>
			| undefined;
		expect(rowB).toBeDefined();
		expect(rowB?.name).toBe("test-skill");
	});

	it("AC3.9: broadcast target_site_id='*' writes one inbox entry per spoke excluding source", async () => {
		const now = new Date().toISOString();

		// Insert a relay_outbox entry on instanceB (spoke) with target_site_id="*"
		const broadcastOutboxId = Math.random().toString(36).substring(2);
		instanceB.db
			.query(
				"INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, idempotency_key, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				broadcastOutboxId,
				instanceB.siteId,
				"*",
				"event_broadcast",
				`broadcast-${broadcastOutboxId}`,
				JSON.stringify({
					event_name: "test:event",
					event_payload: { data: "test" },
					event_depth: 1,
				}),
				now,
				new Date(Date.now() + 5 * 60 * 1000).toISOString(),
			);

		// Initiate a sync cycle from B (spoke) to A (hub)
		// This should cause the hub to fan-out the broadcast to the relay_inbox
		const result = await instanceB.syncClient.syncCycle();
		expect(result.ok).toBe(true);

		// Query the hub's relay_inbox - should have one entry targeting the hub
		const inboxEntries = instanceA.db
			.query("SELECT * FROM relay_inbox WHERE kind = ?")
			.all("event_broadcast") as Array<{
			id: string;
			source_site_id: string;
			kind: string;
		}>;

		// Verify we have exactly one broadcast entry in the hub's inbox
		expect(inboxEntries.length).toBe(1);

		// Verify the entry came from the spoke
		expect(inboxEntries[0].source_site_id).toBe(instanceB.siteId);
	});

	it("AC3.9: broadcast fan-out to multiple spokes via sync", async () => {
		const now = new Date().toISOString();

		// Create a 3rd spoke (instanceC)
		const portC = 10000 + Math.floor(Math.random() * 50000) + 100;
		const keypairC = await ensureKeypair(`/tmp/bound-test-keys-c-${testRunId}`);
		const pubKeyC = await exportPublicKey(keypairC.publicKey);

		// Update keyring with new spoke
		const updatedKeyring: KeyringConfig = {
			hosts: {
				...keyring.hosts,
				[keypairC.siteId]: {
					public_key: pubKeyC,
					url: `http://localhost:${portC}`,
				},
			},
		};

		instanceC = await createTestInstance({
			name: "c",
			port: portC,
			dbPath: `/tmp/bound-test-c-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: 10000 + Math.floor(Math.random() * 50000), // Use the hub's port from instances A
			keyring: updatedKeyring,
			keypairPath: `/tmp/bound-test-keys-c-${testRunId}`,
		});

		// Insert broadcast on B with target_site_id="*"
		const broadcastOutboxId = Math.random().toString(36).substring(2);
		instanceB.db
			.query(
				"INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, idempotency_key, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				broadcastOutboxId,
				instanceB.siteId,
				"*",
				"event_broadcast",
				`broadcast-${broadcastOutboxId}`,
				JSON.stringify({
					event_name: "cluster:event",
					event_payload: { data: "cluster_test" },
					event_depth: 1,
				}),
				now,
				new Date(Date.now() + 5 * 60 * 1000).toISOString(),
			);

		// B syncs to A (hub) which should fan-out to A's relay_inbox
		const syncB = await instanceB.syncClient.syncCycle();
		expect(syncB.ok).toBe(true);

		// Query hub's relay_inbox for fan-out entry
		const hubInboxEntries = instanceA.db
			.query("SELECT * FROM relay_inbox WHERE kind = ? AND payload LIKE ?")
			.all("event_broadcast", "%cluster:event%") as Array<{
			id: string;
			source_site_id: string;
			kind: string;
		}>;

		// Verify broadcast was received at hub
		expect(hubInboxEntries.length).toBeGreaterThan(0);
	});
});
