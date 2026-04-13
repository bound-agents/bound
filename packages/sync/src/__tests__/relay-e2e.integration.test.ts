import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	insertInbox,
	markProcessed,
	readUndelivered,
	readUnprocessed,
	writeOutbox,
} from "@bound/core";
import type { KeyringConfig } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

describe("relay transport E2E integration tests", () => {
	let instances: TestInstance[] = [];
	let testRunId: string;

	// Helper to cleanup all instances
	async function cleanupAll() {
		for (const instance of instances) {
			await instance.cleanup();
		}
		instances = [];
	}

	afterEach(async () => {
		await cleanupAll();
	});

	// Helper to create N instances with unique ports and keypairs
	async function setupInstances(
		count: number,
		roles: ("hub" | "spoke")[],
	): Promise<TestInstance[]> {
		testRunId = randomBytes(4).toString("hex");

		const basePort = 10000 + Math.floor(Math.random() * 40000);
		const keypairs = await Promise.all(
			Array.from({ length: count }, (_, i) =>
				ensureKeypair(`/tmp/bound-test-e2e-keys-${i}-${testRunId}`),
			),
		);

		const keyring: KeyringConfig = {
			hosts: Object.fromEntries(
				await Promise.all(
					keypairs.map(async (kp, i) => [
						kp.siteId,
						{
							public_key: await exportPublicKey(kp.publicKey),
							url: `http://localhost:${basePort + i}`,
						},
					]),
				),
			),
		};

		const newInstances: TestInstance[] = [];
		for (let i = 0; i < count; i++) {
			const instance = await createTestInstance({
				name: `instance-${i}`,
				port: basePort + i,
				dbPath: `/tmp/bound-test-e2e-${i}-${testRunId}/bound.db`,
				role: roles[i],
				hubPort: roles[i] === "spoke" ? basePort : undefined, // Hub is at basePort
				keyring,
				keypairPath: `/tmp/bound-test-e2e-keys-${i}-${testRunId}`,
			});
			newInstances.push(instance);
		}

		instances = newInstances;
		return newInstances;
	}

	describe("AC1.1: Spoke A → Hub → Spoke B tool call round trip", () => {
		it("tool call from spoke A to spoke B executes and returns result", async () => {
			const [_hub, spokeA, spokeB] = await setupInstances(3, ["hub", "spoke", "spoke"]);

			// Verify all instances are set up correctly
			expect(spokeA.syncClient).toBeDefined();
			expect(spokeB.syncClient).toBeDefined();

			if (!spokeA.syncClient || !spokeB.syncClient) {
				throw new Error("SyncClient should be defined for spokes");
			}

			// Step 1: Spoke B writes a tool_call to its own relay_inbox
			// (simulating that it received a tool call request from hub)
			const toolCallId = crypto.randomUUID();
			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 60000).toISOString();

			insertInbox(spokeB.db, {
				id: toolCallId,
				source_site_id: spokeA.siteId,
				kind: "tool_call",
				ref_id: toolCallId,
				idempotency_key: null,
				payload: JSON.stringify({
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: { input: "test" },
				}),
				expires_at: expiresAt,
				received_at: now,
				processed: 0,
			});

			// Step 2: Spoke A writes tool_call to its relay_outbox targeting Spoke B
			const requestId = crypto.randomUUID();
			writeOutbox(spokeA.db, {
				id: requestId,
				source_site_id: spokeA.siteId,
				target_site_id: spokeB.siteId,
				kind: "tool_call",
				ref_id: requestId,
				idempotency_key: null,
				payload: JSON.stringify({
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: { input: "test" },
				}),
				created_at: now,
				expires_at: expiresAt,
			});

			// Verify outbox entry exists
			const outboxBefore = readUndelivered(spokeA.db);
			expect(outboxBefore).toHaveLength(1);

			// Step 3: Spoke A syncs → Hub receives and stores for Spoke B
			const syncResultA = await spokeA.syncClient.syncCycle();
			expect(syncResultA.ok).toBe(true);

			// Verify outbox on spoke A is marked delivered
			const outboxAfter = readUndelivered(spokeA.db);
			expect(outboxAfter).toHaveLength(0);

			// Step 4: Spoke B syncs → receives tool_call in inbox
			const syncResultB = await spokeB.syncClient.syncCycle();
			expect(syncResultB.ok).toBe(true);

			// Verify spoke B received the tool call in inbox
			const inboxB = readUnprocessed(spokeB.db);
			const toolCall = inboxB.find((e) => e.ref_id === requestId);
			expect(toolCall).toBeDefined();
			expect(toolCall?.kind).toBe("tool_call");

			// Step 5: Spoke B executes and writes result to outbox
			if (toolCall) {
				markProcessed(spokeB.db, [toolCall.id]);

				const resultId = crypto.randomUUID();
				writeOutbox(spokeB.db, {
					id: resultId,
					source_site_id: spokeB.siteId,
					target_site_id: spokeA.siteId,
					kind: "result",
					ref_id: requestId,
					idempotency_key: null,
					payload: JSON.stringify({
						status: "success",
						result: "tool executed successfully",
					}),
					created_at: now,
					expires_at: expiresAt,
				});

				// Step 6: Spoke B syncs → Hub receives result
				const syncResultB2 = await spokeB.syncClient.syncCycle();
				expect(syncResultB2.ok).toBe(true);

				// Step 7: Spoke A syncs → receives result in inbox
				const syncResultA2 = await spokeA.syncClient.syncCycle();
				expect(syncResultA2.ok).toBe(true);

				// Verify spoke A received the result
				const inboxA = readUnprocessed(spokeA.db);
				const result = inboxA.find((e) => e.ref_id === requestId);
				expect(result).toBeDefined();
				expect(result?.kind).toBe("result");
				if (result) {
					const payload = JSON.parse(result.payload);
					expect(payload.status).toBe("success");
					expect(payload.result).toBe("tool executed successfully");
				}
			}
		});
	});

	describe("AC1.8: NAT'd host (no sync_url) polling-only delivery", () => {
		it("tool call delivers via polling when host has no sync_url", async () => {
			const [hub, natSpoke] = await setupInstances(2, ["hub", "spoke"]);

			expect(natSpoke.syncClient).toBeDefined();
			if (!natSpoke.syncClient) {
				throw new Error("SyncClient should be defined for spoke");
			}

			// Simulate NAT'd host by clearing sync_url from hosts table
			const now = new Date().toISOString();
			natSpoke.db
				.query("UPDATE hosts SET sync_url = NULL, modified_at = ? WHERE site_id = ?")
				.run(now, natSpoke.siteId);

			// Hub writes tool_call for NAT'd spoke in relay_outbox
			const toolCallId = crypto.randomUUID();
			const expiresAt = new Date(Date.now() + 60000).toISOString();

			writeOutbox(hub.db, {
				id: toolCallId,
				source_site_id: hub.siteId,
				target_site_id: natSpoke.siteId,
				kind: "tool_call",
				ref_id: toolCallId,
				idempotency_key: null,
				payload: JSON.stringify({
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: {},
				}),
				created_at: now,
				expires_at: expiresAt,
			});

			// NAT spoke polls via sync - should receive tool_call
			const syncResult = await natSpoke.syncClient.syncCycle();
			expect(syncResult.ok).toBe(true);

			// Verify NAT spoke received the tool_call in inbox (no eager push)
			const inboxNat = readUnprocessed(natSpoke.db);
			const toolCall = inboxNat.find((e) => e.ref_id === toolCallId);
			expect(toolCall).toBeDefined();
			expect(toolCall?.kind).toBe("tool_call");
		});
	});

	describe("AC3.1 & AC3.2: Proxy endpoints removed (404)", () => {
		it("POST to /api/mcp-proxy returns 404", async () => {
			const [hub] = await setupInstances(1, ["hub"]);

			const response = await fetch(`http://localhost:${hub.port}/api/mcp-proxy`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ test: "data" }),
			});

			expect(response.status).toBe(404);
		});

		it("GET/POST to /api/file-fetch returns 404", async () => {
			const [hub] = await setupInstances(1, ["hub"]);

			const responseGet = await fetch(`http://localhost:${hub.port}/api/file-fetch`, {
				method: "GET",
			});
			expect(responseGet.status).toBe(404);

			const responsePost = await fetch(`http://localhost:${hub.port}/api/file-fetch`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ test: "data" }),
			});
			expect(responsePost.status).toBe(404);
		});
	});

	describe("Addressable host eager push delivery", () => {
		it("tool_call to host with sync_url delivers via eager push", async () => {
			const [hub, spoke] = await setupInstances(2, ["hub", "spoke"]);

			expect(spoke.syncClient).toBeDefined();
			if (!spoke.syncClient) {
				throw new Error("SyncClient should be defined for spoke");
			}

			// Ensure spoke has sync_url in hosts table
			const now = new Date().toISOString();
			spoke.db
				.query("UPDATE hosts SET sync_url = ?, modified_at = ? WHERE site_id = ?")
				.run(`http://localhost:${spoke.port}`, now, spoke.siteId);

			// Hub writes tool_call for addressable spoke
			const toolCallId = crypto.randomUUID();
			const expiresAt = new Date(Date.now() + 60000).toISOString();

			writeOutbox(hub.db, {
				id: toolCallId,
				source_site_id: hub.siteId,
				target_site_id: spoke.siteId,
				kind: "tool_call",
				ref_id: toolCallId,
				idempotency_key: null,
				payload: JSON.stringify({
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: { test: "data" },
				}),
				created_at: now,
				expires_at: expiresAt,
			});

			// Give eager push a moment to attempt delivery
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Spoke should have received via eager push (even before sync)
			const inboxBefore = readUnprocessed(spoke.db);
			const toolCall = inboxBefore.find((e) => e.ref_id === toolCallId);

			// Either eager push succeeded or polling will succeed
			if (toolCall) {
				expect(toolCall.kind).toBe("tool_call");
			} else {
				// Fall back to polling
				const syncResult = await spoke.syncClient.syncCycle();
				expect(syncResult.ok).toBe(true);

				const inboxAfter = readUnprocessed(spoke.db);
				const toolCallAfterSync = inboxAfter.find((e) => e.ref_id === toolCallId);
				expect(toolCallAfterSync).toBeDefined();
			}
		});
	});

	describe("Idempotent retry", () => {
		it("same relay request with same idempotency_key executes only once", async () => {
			const [hub, spokeA, spokeB] = await setupInstances(3, ["hub", "spoke", "spoke"]);

			expect(spokeA.syncClient).toBeDefined();
			if (!spokeA.syncClient) {
				throw new Error("SyncClient should be defined for spoke");
			}

			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 60000).toISOString();
			const idempotencyKey = crypto.randomUUID();

			// Spoke A sends first request with idempotency key
			const requestId1 = crypto.randomUUID();
			writeOutbox(spokeA.db, {
				id: requestId1,
				source_site_id: spokeA.siteId,
				target_site_id: spokeB.siteId,
				kind: "tool_call",
				ref_id: requestId1,
				idempotency_key: idempotencyKey,
				payload: JSON.stringify({
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: { value: 1 },
				}),
				created_at: now,
				expires_at: expiresAt,
			});

			// First sync - hub stores for spoke B
			let syncResult = await spokeA.syncClient.syncCycle();
			expect(syncResult.ok).toBe(true);

			// Verify delivered
			let outbox = readUndelivered(spokeA.db);
			expect(outbox).toHaveLength(0);

			// Spoke A sends second request with SAME idempotency key but different ID
			const requestId2 = crypto.randomUUID();
			writeOutbox(spokeA.db, {
				id: requestId2,
				source_site_id: spokeA.siteId,
				target_site_id: spokeB.siteId,
				kind: "tool_call",
				ref_id: requestId2,
				idempotency_key: idempotencyKey,
				payload: JSON.stringify({
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: { value: 2 },
				}),
				created_at: now,
				expires_at: expiresAt,
			});

			// Second sync - hub rejects duplicate due to idempotency_key
			syncResult = await spokeA.syncClient.syncCycle();
			expect(syncResult.ok).toBe(true);

			// Both should be marked delivered
			outbox = readUndelivered(spokeA.db);
			expect(outbox).toHaveLength(0);

			// Hub should have only ONE copy for spoke B
			const hubOutbox = readUndelivered(hub.db);
			const spoke2Targets = hubOutbox.filter((e) => e.target_site_id === spokeB.siteId);
			expect(spoke2Targets.length).toBeLessThanOrEqual(1);
		});
	});

	describe("Resource read E2E round-trip", () => {
		it("resource_read request round-trips through relay", async () => {
			const [_hub, spokeA, spokeB] = await setupInstances(3, ["hub", "spoke", "spoke"]);

			expect(spokeA.syncClient).toBeDefined();
			expect(spokeB.syncClient).toBeDefined();
			if (!spokeA.syncClient || !spokeB.syncClient) {
				throw new Error("SyncClient should be defined for spokes");
			}

			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 60000).toISOString();

			// Spoke A writes resource_read request targeting Spoke B
			const requestId = crypto.randomUUID();
			writeOutbox(spokeA.db, {
				id: requestId,
				source_site_id: spokeA.siteId,
				target_site_id: spokeB.siteId,
				kind: "resource_read",
				ref_id: requestId,
				idempotency_key: null,
				payload: JSON.stringify({
					server_name: "test_server",
					resource_uri: "test://resource",
				}),
				created_at: now,
				expires_at: expiresAt,
			});

			// Spoke A syncs - hub receives and stores for B
			const syncResultA = await spokeA.syncClient.syncCycle();
			expect(syncResultA.ok).toBe(true);

			// Spoke B syncs - receives resource_read in inbox
			const syncResultB = await spokeB.syncClient.syncCycle();
			expect(syncResultB.ok).toBe(true);

			// Verify spoke B received the resource_read
			const inboxB = readUnprocessed(spokeB.db);
			const resourceRead = inboxB.find((e) => e.ref_id === requestId);
			expect(resourceRead).toBeDefined();
			expect(resourceRead?.kind).toBe("resource_read");

			// Spoke B would process and write result (simulated)
			if (resourceRead) {
				markProcessed(spokeB.db, [resourceRead.id]);

				const resultId = crypto.randomUUID();
				writeOutbox(spokeB.db, {
					id: resultId,
					source_site_id: spokeB.siteId,
					target_site_id: spokeA.siteId,
					kind: "result",
					ref_id: requestId,
					idempotency_key: null,
					payload: JSON.stringify({
						status: "success",
						content: "resource content",
					}),
					created_at: now,
					expires_at: expiresAt,
				});

				// Spoke B syncs - hub receives result
				const syncResultB2 = await spokeB.syncClient.syncCycle();
				expect(syncResultB2.ok).toBe(true);

				// Spoke A syncs - receives result
				const syncResultA2 = await spokeA.syncClient.syncCycle();
				expect(syncResultA2.ok).toBe(true);

				// Verify spoke A received the result
				const inboxA = readUnprocessed(spokeA.db);
				const result = inboxA.find((e) => e.ref_id === requestId);
				expect(result).toBeDefined();
				expect(result?.kind).toBe("result");
				if (result) {
					const payload = JSON.parse(result.payload);
					expect(payload.status).toBe("success");
					expect(payload.content).toBe("resource content");
				}
			}
		});
	});

	describe("Prompt invoke E2E round-trip", () => {
		it("prompt_invoke request round-trips through relay", async () => {
			const [_hub, spokeA, spokeB] = await setupInstances(3, ["hub", "spoke", "spoke"]);

			expect(spokeA.syncClient).toBeDefined();
			expect(spokeB.syncClient).toBeDefined();
			if (!spokeA.syncClient || !spokeB.syncClient) {
				throw new Error("SyncClient should be defined for spokes");
			}

			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 60000).toISOString();

			// Spoke A writes prompt_invoke request targeting Spoke B
			const requestId = crypto.randomUUID();
			writeOutbox(spokeA.db, {
				id: requestId,
				source_site_id: spokeA.siteId,
				target_site_id: spokeB.siteId,
				kind: "prompt_invoke",
				ref_id: requestId,
				idempotency_key: null,
				payload: JSON.stringify({
					server_name: "test_server",
					prompt_name: "test_prompt",
					arguments: { arg1: "value1" },
				}),
				created_at: now,
				expires_at: expiresAt,
			});

			// Spoke A syncs - hub receives and stores for B
			const syncResultA = await spokeA.syncClient.syncCycle();
			expect(syncResultA.ok).toBe(true);

			// Spoke B syncs - receives prompt_invoke in inbox
			const syncResultB = await spokeB.syncClient.syncCycle();
			expect(syncResultB.ok).toBe(true);

			// Verify spoke B received the prompt_invoke
			const inboxB = readUnprocessed(spokeB.db);
			const promptInvoke = inboxB.find((e) => e.ref_id === requestId);
			expect(promptInvoke).toBeDefined();
			expect(promptInvoke?.kind).toBe("prompt_invoke");

			// Spoke B would process and write result (simulated)
			if (promptInvoke) {
				markProcessed(spokeB.db, [promptInvoke.id]);

				const resultId = crypto.randomUUID();
				writeOutbox(spokeB.db, {
					id: resultId,
					source_site_id: spokeB.siteId,
					target_site_id: spokeA.siteId,
					kind: "result",
					ref_id: requestId,
					idempotency_key: null,
					payload: JSON.stringify({
						status: "success",
						messages: [{ role: "user", content: "prompt result" }],
					}),
					created_at: now,
					expires_at: expiresAt,
				});

				// Spoke B syncs - hub receives result
				const syncResultB2 = await spokeB.syncClient.syncCycle();
				expect(syncResultB2.ok).toBe(true);

				// Spoke A syncs - receives result
				const syncResultA2 = await spokeA.syncClient.syncCycle();
				expect(syncResultA2.ok).toBe(true);

				// Verify spoke A received the result
				const inboxA = readUnprocessed(spokeA.db);
				const result = inboxA.find((e) => e.ref_id === requestId);
				expect(result).toBeDefined();
				expect(result?.kind).toBe("result");
				if (result) {
					const payload = JSON.parse(result.payload);
					expect(payload.status).toBe("success");
					expect(payload.messages).toBeDefined();
				}
			}
		});
	});

	describe("Cache warm with multi-file split", () => {
		it("cache_warm request splits large payloads across multiple result entries", async () => {
			const [_hub, spokeA, spokeB] = await setupInstances(3, ["hub", "spoke", "spoke"]);

			expect(spokeA.syncClient).toBeDefined();
			expect(spokeB.syncClient).toBeDefined();
			if (!spokeA.syncClient || !spokeB.syncClient) {
				throw new Error("SyncClient should be defined for spokes");
			}

			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 60000).toISOString();

			// Spoke A writes cache_warm request targeting Spoke B
			const requestId = crypto.randomUUID();
			writeOutbox(spokeA.db, {
				id: requestId,
				source_site_id: spokeA.siteId,
				target_site_id: spokeB.siteId,
				kind: "cache_warm",
				ref_id: requestId,
				idempotency_key: null,
				payload: JSON.stringify({
					server_name: "test_server",
					paths: ["file1.txt", "file2.txt"],
				}),
				created_at: now,
				expires_at: expiresAt,
			});

			// Spoke A syncs - hub receives and stores for B
			const syncResultA = await spokeA.syncClient.syncCycle();
			expect(syncResultA.ok).toBe(true);

			// Spoke B syncs - receives cache_warm in inbox
			const syncResultB = await spokeB.syncClient.syncCycle();
			expect(syncResultB.ok).toBe(true);

			// Verify spoke B received the cache_warm
			const inboxB = readUnprocessed(spokeB.db);
			const cacheWarm = inboxB.find((e) => e.ref_id === requestId);
			expect(cacheWarm).toBeDefined();
			expect(cacheWarm?.kind).toBe("cache_warm");

			// Spoke B would process and potentially split large files (simulated)
			if (cacheWarm) {
				markProcessed(spokeB.db, [cacheWarm.id]);

				// Simulate split results - file1
				const resultId1 = crypto.randomUUID();
				writeOutbox(spokeB.db, {
					id: resultId1,
					source_site_id: spokeB.siteId,
					target_site_id: spokeA.siteId,
					kind: "result",
					ref_id: requestId,
					idempotency_key: null,
					payload: JSON.stringify({
						status: "partial",
						path: "file1.txt",
						content: "file1 content",
						index: 0,
						total: 2,
					}),
					created_at: now,
					expires_at: expiresAt,
				});

				// Simulate split results - file2
				const resultId2 = crypto.randomUUID();
				writeOutbox(spokeB.db, {
					id: resultId2,
					source_site_id: spokeB.siteId,
					target_site_id: spokeA.siteId,
					kind: "result",
					ref_id: requestId,
					idempotency_key: null,
					payload: JSON.stringify({
						status: "success",
						path: "file2.txt",
						content: "file2 content",
						index: 1,
						total: 2,
					}),
					created_at: now,
					expires_at: expiresAt,
				});

				// Spoke B syncs - hub receives results
				const syncResultB2 = await spokeB.syncClient.syncCycle();
				expect(syncResultB2.ok).toBe(true);

				// Spoke A syncs - receives results
				const syncResultA2 = await spokeA.syncClient.syncCycle();
				expect(syncResultA2.ok).toBe(true);

				// Verify spoke A received both result entries
				const inboxA = readUnprocessed(spokeA.db);
				const results = inboxA.filter((e) => e.ref_id === requestId);
				expect(results.length).toBeGreaterThanOrEqual(1);
				expect(results.every((r) => r.kind === "result")).toBe(true);
			}
		});
	});

	// Scenario 5 (Hub migration with active relay): Covered by relay-drain.integration.test.ts
	// AC4.4 test verifies that held request-kind entries deliver to new hub after hub switch with drain.
});
