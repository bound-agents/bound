/**
 * Hub-spoke E2E integration test: new-hub replication flow.
 *
 * Validates the complete scenario of adding a second host as a hub to an existing
 * single-host cluster:
 *   1. Spoke has pre-existing data (users, threads, messages, skills, memory, files).
 *   2. Hub starts with empty state (no local inference backends in config).
 *   3. Spoke syncs to hub — all data replicates successfully.
 *   4. Hub correctly routes relay outbox entries destined for spoke to spoke's inbox.
 *   5. Hub routes inference relay requests to spoke (not executed hub-side in sync phase).
 *
 * The test harness spins up real HTTP servers with full SQLite schemas, real Ed25519
 * keypair auth, and actual SyncClient sync cycles — this is not mocked at any layer.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { writeOutbox } from "@bound/core";
import type { KeyringConfig } from "@bound/shared";
import { generateHlc } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

/**
 * Helper to insert a change_log entry with proper HLC generation.
 * Accepts either an object or a JSON string for rowData.
 */
function insertChangeLog(
	db: Database,
	tableName: string,
	rowId: string,
	siteId: string,
	timestamp: string,
	rowData: Record<string, unknown> | string,
): void {
	const lastHlcRow = db.query("SELECT hlc FROM change_log ORDER BY hlc DESC LIMIT 1").get() as { hlc: string } | null;
	const hlc = generateHlc(timestamp, lastHlcRow?.hlc ?? null, siteId);

	const rowDataStr = typeof rowData === "string" ? rowData : JSON.stringify(rowData);
	db.query(
		"INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?, ?)",
	).run(hlc, tableName, rowId, siteId, timestamp, rowDataStr);
}

describe("hub-spoke E2E: new-hub replication flow", () => {
	let hub: TestInstance;
	let spoke: TestInstance;
	let testRunId: string;
	let keyring: KeyringConfig;

	beforeEach(async () => {
		testRunId = randomBytes(4).toString("hex");

		const hubPort = 10000 + Math.floor(Math.random() * 40000);
		const spokePort = hubPort + 1;

		const hubKeypair = await ensureKeypair(`/tmp/bound-hub-e2e-keys-hub-${testRunId}`);
		const spokeKeypair = await ensureKeypair(`/tmp/bound-hub-e2e-keys-spoke-${testRunId}`);

		keyring = {
			hosts: {
				[hubKeypair.siteId]: {
					public_key: await exportPublicKey(hubKeypair.publicKey),
					url: `http://localhost:${hubPort}`,
				},
				[spokeKeypair.siteId]: {
					public_key: await exportPublicKey(spokeKeypair.publicKey),
					url: `http://localhost:${spokePort}`,
				},
			},
		};

		// Hub: no local inference (hub-only deployment)
		hub = await createTestInstance({
			name: "hub",
			port: hubPort,
			dbPath: `/tmp/bound-hub-e2e-hub-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-hub-e2e-keys-hub-${testRunId}`,
		});

		// Spoke: existing cluster member with data (becomes spoke after new hub joins)
		spoke = await createTestInstance({
			name: "spoke",
			port: spokePort,
			dbPath: `/tmp/bound-hub-e2e-spoke-${testRunId}/bound.db`,
			role: "spoke",
			hubPort,
			keyring,
			keypairPath: `/tmp/bound-hub-e2e-keys-spoke-${testRunId}`,
		});
	});

	afterEach(async () => {
		await hub.cleanup();
		await spoke.cleanup();
	});

	it("replicates pre-existing spoke data to hub on first sync", async () => {
		const now = new Date().toISOString();

		// --- Pre-seed all major synced tables on the spoke ---

		// 1. User
		const userId = `user-${randomBytes(4).toString("hex")}`;
		spoke.db
			.query(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
			)
			.run(userId, "Alice", now, now);
		insertChangeLog(
			spoke.db,
				"users",
				userId,
				spoke.siteId,
				now,
				JSON.stringify({
					id: userId,
					display_name: "Alice",
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				}),
			);

		// 2. Thread
		const threadId = `thread-${randomBytes(4).toString("hex")}`;
		spoke.db
			.query(
				`INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, modified_at, last_message_at, deleted)
				 VALUES (?, ?, 'web', 'spoke-host', 0, 'Test Thread', ?, ?, ?, 0)`,
			)
			.run(threadId, userId, now, now, now);
		insertChangeLog(
			spoke.db,
				"threads",
				threadId,
				spoke.siteId,
				now,
				JSON.stringify({
					id: threadId,
					user_id: userId,
					interface: "web",
					host_origin: "spoke-host",
					color: 0,
					title: "Test Thread",
					created_at: now,
					modified_at: now,
					last_message_at: now,
					deleted: 0,
				}),
			);

		// 3. Message
		const messageId = `msg-${randomBytes(4).toString("hex")}`;
		spoke.db
			.query(
				`INSERT INTO messages (id, thread_id, role, content, created_at, host_origin)
				 VALUES (?, ?, 'user', 'Hello from spoke', ?, 'spoke-host')`,
			)
			.run(messageId, threadId, now);
		insertChangeLog(
			spoke.db,
				"messages",
				messageId,
				spoke.siteId,
				now,
				JSON.stringify({
					id: messageId,
					thread_id: threadId,
					role: "user",
					content: "Hello from spoke",
					created_at: now,
					host_origin: "spoke-host",
				}),
			);

		// 4. Semantic memory
		const memId = `mem-${randomBytes(4).toString("hex")}`;
		spoke.db
			.query(
				`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
			)
			.run(memId, "cluster-setup", "Hub+spoke topology configured", "test", now, now, now);
		insertChangeLog(
			spoke.db,
				"semantic_memory",
				memId,
				spoke.siteId,
				now,
				JSON.stringify({
					id: memId,
					key: "cluster-setup",
					value: "Hub+spoke topology configured",
					source: "test",
					created_at: now,
					modified_at: now,
					last_accessed_at: now,
					deleted: 0,
				}),
			);

		// 5. Skill
		const skillId = `skill-${randomBytes(4).toString("hex")}`;
		spoke.db
			.query(
				`INSERT INTO skills (id, name, description, status, skill_root, activation_count, modified_at, deleted)
				 VALUES (?, ?, ?, 'active', '/home/user/skills/test', 0, ?, 0)`,
			)
			.run(skillId, "hub-spoke-skill", "A skill for testing hub-spoke sync", now);
		insertChangeLog(
			spoke.db,
				"skills",
				skillId,
				spoke.siteId,
				now,
				JSON.stringify({
					id: skillId,
					name: "hub-spoke-skill",
					description: "A skill for testing hub-spoke sync",
					status: "active",
					skill_root: "/home/user/skills/test",
					activation_count: 0,
					modified_at: now,
					deleted: 0,
				}),
			);

		// 6. Host advertisement (spoke advertises its model capabilities)
		spoke.db
			.query(
				`INSERT INTO hosts (site_id, host_name, version, sync_url, models, online_at, modified_at, deleted)
				 VALUES (?, 'spoke-host', '1.0.0', ?, ?, ?, ?, 0)`,
			)
			.run(
				spoke.siteId,
				`http://localhost:${spoke.port}`,
				JSON.stringify([{ id: "claude", tier: 2 }]),
				now,
				now,
			);
		insertChangeLog(
			spoke.db,
				"hosts",
				spoke.siteId,
				spoke.siteId,
				now,
				JSON.stringify({
					site_id: spoke.siteId,
					host_name: "spoke-host",
					version: "1.0.0",
					sync_url: `http://localhost:${spoke.port}`,
					models: JSON.stringify([{ id: "claude", tier: 2 }]),
					online_at: now,
					modified_at: now,
					deleted: 0,
				}),
			);

		// --- First sync: spoke pushes all pre-existing data to hub ---
		const syncResult =
			(await spoke.syncClient?.syncCycle()) ??
			Promise.resolve({ ok: false as const, error: "No syncClient" });
		expect(syncResult.ok).toBe(true);

		// --- Verify all data appeared on hub ---

		const hubUser = hub.db.query("SELECT * FROM users WHERE id = ?").get(userId) as
			| Record<string, unknown>
			| undefined;
		expect(hubUser).toBeDefined();
		expect(hubUser?.display_name).toBe("Alice");

		const hubThread = hub.db.query("SELECT * FROM threads WHERE id = ?").get(threadId) as
			| Record<string, unknown>
			| undefined;
		expect(hubThread).toBeDefined();
		expect(hubThread?.title).toBe("Test Thread");

		const hubMessage = hub.db.query("SELECT * FROM messages WHERE id = ?").get(messageId) as
			| Record<string, unknown>
			| undefined;
		expect(hubMessage).toBeDefined();
		expect(hubMessage?.content).toBe("Hello from spoke");

		const hubMem = hub.db.query("SELECT * FROM semantic_memory WHERE id = ?").get(memId) as
			| Record<string, unknown>
			| undefined;
		expect(hubMem).toBeDefined();
		expect(hubMem?.key).toBe("cluster-setup");

		const hubSkill = hub.db.query("SELECT * FROM skills WHERE id = ?").get(skillId) as
			| Record<string, unknown>
			| undefined;
		expect(hubSkill).toBeDefined();
		expect(hubSkill?.name).toBe("hub-spoke-skill");

		const hubHost = hub.db.query("SELECT * FROM hosts WHERE site_id = ?").get(spoke.siteId) as
			| Record<string, unknown>
			| undefined;
		expect(hubHost).toBeDefined();
		expect(hubHost?.host_name).toBe("spoke-host");
	});

	it("hub routes relay outbox entries targeting spoke to spoke's inbox", async () => {
		const now = new Date().toISOString();

		// Write a relay_outbox entry on the hub targeting the spoke
		// (simulating a tool_call relay from hub → spoke)
		const outboxId = randomBytes(8).toString("hex");
		writeOutbox(hub.db, {
			id: outboxId,
			source_site_id: hub.siteId,
			target_site_id: spoke.siteId,
			kind: "tool_call",
			ref_id: null,
			idempotency_key: `test-key-${outboxId}`,
			stream_id: null,
			payload: JSON.stringify({ tool: "bash", args: { command: "echo hello" } }),
			created_at: now,
			expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
		});

		// Spoke syncs to hub — hub delivers the outbox entry to spoke's inbox
		const syncResult =
			(await spoke.syncClient?.syncCycle()) ??
			Promise.resolve({ ok: false as const, error: "No syncClient" });
		expect(syncResult.ok).toBe(true);

		// Spoke should now have the tool_call in its relay_inbox
		const spokeInbox = spoke.db
			.query("SELECT * FROM relay_inbox WHERE kind = 'tool_call'")
			.all() as Array<{ id: string; kind: string; source_site_id: string; payload: string }>;

		expect(spokeInbox.length).toBeGreaterThan(0);
		const entry = spokeInbox.find((e) => {
			try {
				return (JSON.parse(e.payload) as { tool?: string }).tool === "bash";
			} catch {
				return false;
			}
		});
		expect(entry).toBeDefined();
		expect(entry?.source_site_id).toBe(hub.siteId);
	});

	it("hub does not execute inference relay entries locally (routes to spoke via outbox)", async () => {
		const now = new Date().toISOString();
		const streamId = randomBytes(8).toString("hex");

		// Write an inference relay_outbox entry on the hub targeting the spoke
		const outboxId = randomBytes(8).toString("hex");
		writeOutbox(hub.db, {
			id: outboxId,
			source_site_id: hub.siteId,
			target_site_id: spoke.siteId,
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				model: "claude",
				messages: [{ role: "user", content: "Hello" }],
				tools: [],
				system: null,
			}),
			created_at: now,
			expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
		});

		// Hub's relay route should NOT execute inference locally (it skips inference in executeImmediate)
		// It should be stored in hub's outbox and delivered to spoke's inbox on sync
		const syncResult =
			(await spoke.syncClient?.syncCycle()) ??
			Promise.resolve({ ok: false as const, error: "No syncClient" });
		expect(syncResult.ok).toBe(true);

		// Spoke should have the inference request in its inbox (hub routed it there)
		const spokeInferenceInbox = spoke.db
			.query("SELECT * FROM relay_inbox WHERE kind = 'inference' AND stream_id = ?")
			.all(streamId) as Array<{ id: string; kind: string; stream_id: string }>;

		expect(spokeInferenceInbox.length).toBeGreaterThan(0);
		expect(spokeInferenceInbox[0].kind).toBe("inference");
		expect(spokeInferenceInbox[0].stream_id).toBe(streamId);
	});

	it("bidirectional replication: hub data syncs back to spoke", async () => {
		const now = new Date().toISOString();

		// Write data on hub (e.g., a cluster config update from the hub operator)
		const configKey = `hub-config-${randomBytes(4).toString("hex")}`;
		hub.db
			.query(
				"INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, modified_at = excluded.modified_at",
			)
			.run(configKey, "hub-managed", now);
		insertChangeLog(
			hub.db,
				"cluster_config",
				configKey,
				hub.siteId,
				now,
				JSON.stringify({ key: configKey, value: "hub-managed", modified_at: now }),
			);

		// First sync: spoke pushes (nothing new) and pulls hub's cluster_config
		const syncResult =
			(await spoke.syncClient?.syncCycle()) ??
			Promise.resolve({ ok: false as const, error: "No syncClient" });
		expect(syncResult.ok).toBe(true);

		// Spoke should now have hub's cluster_config entry
		const spokeConfig = spoke.db
			.query("SELECT * FROM cluster_config WHERE key = ?")
			.get(configKey) as Record<string, unknown> | undefined;
		expect(spokeConfig).toBeDefined();
		expect(spokeConfig?.value).toBe("hub-managed");
	});

	it("hub model advertisement syncs to spoke — spoke can discover hub as inference provider", async () => {
		const now = new Date().toISOString();

		// Hub advertises its inference models (simulates what start.ts does at bootstrap)
		hub.db
			.query(
				`INSERT INTO hosts (site_id, host_name, version, models, online_at, modified_at, deleted)
				 VALUES (?, 'hub-node', '1.0.0', ?, ?, ?, 0)`,
			)
			.run(hub.siteId, JSON.stringify([{ id: "claude-opus", tier: 1 }]), now, now);
		insertChangeLog(
			hub.db,
				"hosts",
				hub.siteId,
				hub.siteId,
				now,
				JSON.stringify({
					site_id: hub.siteId,
					host_name: "hub-node",
					version: "1.0.0",
					models: JSON.stringify([{ id: "claude-opus", tier: 1 }]),
					online_at: now,
					modified_at: now,
					deleted: 0,
				}),
			);

		// Spoke syncs — push phase sends spoke data, pull phase fetches hub's hosts row
		const syncResult =
			(await spoke.syncClient?.syncCycle()) ??
			Promise.resolve({ ok: false as const, error: "No syncClient" });
		expect(syncResult.ok).toBe(true);

		// Spoke should now have hub's hosts row with models
		const hubHostOnSpoke = spoke.db
			.query("SELECT * FROM hosts WHERE site_id = ?")
			.get(hub.siteId) as Record<string, unknown> | undefined;
		expect(hubHostOnSpoke).toBeDefined();
		expect(hubHostOnSpoke?.host_name).toBe("hub-node");

		const models = JSON.parse(hubHostOnSpoke?.models as string) as Array<{ id: string }>;
		expect(models.some((m) => m.id === "claude-opus")).toBe(true);
	});

	it("hub advertises platform names in hosts.platforms so spoke can route platform_deliver back", async () => {
		const now = new Date().toISOString();

		// Hub has Discord configured — advertises ["discord"] in hosts.platforms
		hub.db
			.query(
				`INSERT INTO hosts (site_id, host_name, version, platforms, online_at, modified_at, deleted)
				 VALUES (?, 'hub-node', '1.0.0', ?, ?, ?, 0)`,
			)
			.run(hub.siteId, JSON.stringify(["discord"]), now, now);
		insertChangeLog(
			hub.db,
				"hosts",
				hub.siteId,
				hub.siteId,
				now,
				JSON.stringify({
					site_id: hub.siteId,
					host_name: "hub-node",
					version: "1.0.0",
					platforms: JSON.stringify(["discord"]),
					online_at: now,
					modified_at: now,
					deleted: 0,
				}),
			);

		// Spoke syncs — pull phase fetches hub's hosts row including platforms column
		const syncResult =
			(await spoke.syncClient?.syncCycle()) ??
			Promise.resolve({ ok: false as const, error: "No syncClient" });
		expect(syncResult.ok).toBe(true);

		// Spoke should now know hub has Discord
		const hubHostOnSpoke = spoke.db
			.query("SELECT * FROM hosts WHERE site_id = ?")
			.get(hub.siteId) as Record<string, unknown> | undefined;
		expect(hubHostOnSpoke).toBeDefined();
		const platformsOnHub = JSON.parse(hubHostOnSpoke?.platforms as string) as string[];
		expect(platformsOnHub).toContain("discord");
	});
});
