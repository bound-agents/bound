import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema } from "@bound/core";
import { ModelRouter } from "@bound/llm";
import { type ModelResolution, resolveModel, resolveTargetCapabilities } from "../model-resolution";
import { findAnyRemoteModel } from "../relay-router";
// Test database setup
let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = join(tmpdir(), `test-model-resolution-${testId}.db`);
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// Already closed
	}
	try {
		require("node:fs").unlinkSync(testDbPath);
	} catch {
		// Already deleted
	}
});

describe("Model Resolution", () => {
	describe("resolveModel", () => {
		it("resolves local model to backend (AC2.1)", () => {
			// Create a mock LLMBackend for testing
			const mockBackend = {
				id: "claude-3-opus",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			// Create ModelRouter with mock backend
			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("claude-opus", modelRouter, db, "local-site");

			expect(resolution.kind).toBe("local");
			if (resolution.kind === "local") {
				expect(resolution.backend).toBe(mockBackend);
				expect(resolution.modelId).toBe("claude-opus");
			}
		});

		it("resolves to default backend when modelId undefined (AC2.1)", () => {
			const mockBackend = {
				id: "claude-3-opus",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel(undefined, modelRouter, db, "local-site");

			expect(resolution.kind).toBe("local");
			if (resolution.kind === "local") {
				expect(resolution.backend).toBe(mockBackend);
				expect(resolution.modelId).toBe("claude-opus");
			}
		});

		it("resolves remote model to eligible hosts (AC2.2)", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"remote-1",
					"Remote Host",
					JSON.stringify([
						{
							id: "claude-haiku",
							max_output_tokens: 64_000,
							capabilities: { max_context: 200000 },
						},
					]),
					0,
					now,
					now,
				],
			);

			const mockBackend = {
				id: "claude-3-opus",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("claude-haiku", modelRouter, db, "local-site");

			expect(resolution.kind).toBe("remote");
			if (resolution.kind === "remote") {
				expect(resolution.hosts.length).toBe(1);
				expect(resolution.hosts[0].site_id).toBe("remote-1");
				expect(resolution.modelId).toBe("claude-haiku");
				expect(resolution.maxOutputTokens).toBe(64_000);
			}
		});

		it("completes on the remote route when the local route for the same model is rate-limited (R-RT7, Done-when #1)", () => {
			// A local subscription route and a remote API route serve the SAME logical
			// model "gpt-5.6-sol". The local route no longer wins just by existing: once
			// it is rate-limited, resolution falls through to the remote route for the
			// same model rather than stranding the turn or substituting a different one.
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"remote-api",
					"Remote API Host",
					JSON.stringify([
						{
							id: "gpt-5.6-sol",
							route_id: "remote-api:bedrock-mantle:gpt-5.6-sol",
							logical_model: "gpt-5.6-sol",
							capabilities: { max_context: 200000 },
						},
					]),
					0,
					now,
					now,
				],
			);

			const localBackend = {
				id: "gpt-5.6-sol",
				chat: async function* () {
					yield { type: "text", text: "local" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					extended_thinking: false,
					max_context: 200000,
				}),
			};
			const backends = new Map([["gpt-5.6-sol", localBackend]]);
			const modelRouter = new ModelRouter(backends, "gpt-5.6-sol");

			// While the local route is healthy it wins (local-first ranking).
			const healthy = resolveModel("gpt-5.6-sol", modelRouter, db, "local-site");
			expect(healthy.kind).toBe("local");

			// Rate-limit the local route; resolution must complete on the remote route
			// serving the same model.
			modelRouter.markRateLimited("gpt-5.6-sol", 60_000);
			const resolution = resolveModel("gpt-5.6-sol", modelRouter, db, "local-site");
			expect(resolution.kind).toBe("remote");
			if (resolution.kind === "remote") {
				expect(resolution.modelId).toBe("gpt-5.6-sol");
				expect(resolution.hosts[0].site_id).toBe("remote-api");
			}
		});

		it("routes to a remote host whose advertisement has no tier (older-peer compat, Done-when #4)", () => {
			// An older peer's advertisement (or a legacy entry) carries no `tier` and
			// no `route_id`. The reader must tolerate the missing tier and keep routing
			// to that host; ranking no longer consults tier at all.
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"legacy-peer",
					"Legacy Peer",
					// No tier, no route_id — the pre-slice-2 object shape.
					JSON.stringify([{ id: "claude-haiku", capabilities: { max_context: 200000 } }]),
					0,
					now,
					now,
				],
			);

			const backends = new Map([
				[
					"claude-opus",
					{
						id: "claude-opus",
						chat: async function* () {
							yield { type: "text", text: "local" } as const;
						},
						capabilities: () => ({
							streaming: true,
							tool_use: true,
							system_prompt: true,
							prompt_caching: false,
							vision: false,
							extended_thinking: false,
							max_context: 200000,
						}),
					},
				],
			]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("claude-haiku", modelRouter, db, "local-site");
			expect(resolution.kind).toBe("remote");
			if (resolution.kind === "remote") {
				expect(resolution.hosts[0].site_id).toBe("legacy-peer");
				expect(resolution.modelId).toBe("claude-haiku");
			}
		});
		it("returns error for unknown model (AC2.4)", () => {
			const mockBackend = {
				id: "claude-3-opus",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("unknown-model-xyz", modelRouter, db, "local-site");

			expect(resolution.kind).toBe("error");
			if (resolution.kind === "error") {
				expect(resolution.error).toContain("unknown-model-xyz");
				expect(resolution.error).toContain("claude-opus");
				// A model that resolves nowhere (local or remote) is permanently unresolvable,
				// not transiently unavailable. The scheduler uses this reason to park the task
				// instead of rescheduling it forever (poison-pill parking).
				expect(resolution.reason).toBe("unknown-model");
			}
		});

		it("classifies a model on a stale host as transient, NOT unknown-model (parking guard)", () => {
			// A host advertises the model but is STALE (older than the 5-minute liveness
			// threshold), so findEligibleHostsByModel excludes it and resolution fails.
			// The model IS real, though — it must be classified transient-unavailable, not
			// unknown-model, so the scheduler RETRIES instead of parking it. Parking a real
			// model's task is strictly worse than an extra retry; this is the guardrail.
			const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"remote-stale",
					"Stale Host",
					JSON.stringify([
						{
							id: "real-but-offline-model",
							tier: 2,
							capabilities: {
								streaming: true,
								tool_use: true,
								system_prompt: true,
								prompt_caching: false,
								vision: false,
								extended_thinking: false,
								max_context: 200000,
							},
						},
					]),
					0,
					stale,
					stale,
				],
			);

			const mockBackend = {
				id: "claude-3-opus",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};
			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("real-but-offline-model", modelRouter, db, "local-site");

			expect(resolution.kind).toBe("error");
			if (resolution.kind === "error") {
				expect(resolution.reason).toBe("transient-unavailable");
				expect(resolution.reason).not.toBe("unknown-model");
			}
		});

		it("includes local backend info in error message when model not found", () => {
			const mockBackend1 = {
				id: "claude-3-opus",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const mockBackend2 = {
				id: "claude-3-sonnet",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([
				["claude-opus", mockBackend1],
				["claude-sonnet", mockBackend2],
			]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("unknown-model", modelRouter, db, "local-site");

			expect(resolution.kind).toBe("error");
			if (resolution.kind === "error") {
				expect(resolution.error).toContain("Local backends:");
				expect(resolution.error).toContain("claude-opus");
				expect(resolution.error).toContain("claude-sonnet");
			}
		});

		it("prefers local backend over remote when model available in both", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["remote-1", "Remote Host", JSON.stringify(["claude-opus"]), 0, now, now],
			);

			const mockBackend = {
				id: "claude-3-opus",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("claude-opus", modelRouter, db, "local-site");

			expect(resolution.kind).toBe("local");
			if (resolution.kind === "local") {
				expect(resolution.backend).toBe(mockBackend);
			}
		});

		it("sorts remote hosts by stable RouteId, never heartbeat freshness (R-RT8, AC2.2)", () => {
			// Ranking is deterministic and independent of heartbeat timestamps: the
			// fresher host must NOT win on freshness. With advertised route_ids, the
			// lexically-smaller route_id ranks first regardless of which host synced
			// more recently.
			const now = new Date();
			const recentTime = new Date(now.getTime() - 1 * 60 * 1000).toISOString();
			const olderTime = new Date(now.getTime() - 3 * 60 * 1000).toISOString();

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"zzz-host",
					"Fresher Host",
					JSON.stringify([
						{
							id: "claude-haiku",
							route_id: "zzz-host:bedrock:claude-haiku",
							capabilities: { max_context: 200000 },
						},
					]),
					0,
					recentTime,
					recentTime,
				],
			);

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"aaa-host",
					"Staler Host",
					JSON.stringify([
						{
							id: "claude-haiku",
							route_id: "aaa-host:bedrock:claude-haiku",
							capabilities: { max_context: 200000 },
						},
					]),
					0,
					olderTime,
					olderTime,
				],
			);

			const mockBackend = {
				id: "claude-3-opus",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("claude-haiku", modelRouter, db, "local-site");

			expect(resolution.kind).toBe("remote");
			if (resolution.kind === "remote") {
				// aaa-host:... sorts before zzz-host:... even though zzz-host is fresher.
				expect(resolution.hosts[0].site_id).toBe("aaa-host");
				expect(resolution.hosts[1].site_id).toBe("zzz-host");
			}
		});
	});

	describe("three-phase model resolution", () => {
		// AC2.5 — text-only requests pass unchanged
		it("text-only request with no requirements passes qualification unchanged (AC2.5)", () => {
			const mockBackend = {
				id: "claude-3-opus",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["local-backend", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "local-backend");

			const resolution = resolveModel("local-backend", modelRouter, db, "site-1");
			expect(resolution.kind).toBe("local");
			const localRes = resolution as Extract<ModelResolution, { kind: "local" }>;
			expect(localRes.reResolved).toBeUndefined();
		});

		// AC2.1 — vision requirement routes to vision-capable backend
		it("routes to vision-capable backend when requirements.vision is set (AC2.1)", () => {
			const primaryBackend = {
				id: "primary",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const visionBackend = {
				id: "vision-backend",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: true,
					max_context: 200000,
				}),
			};

			const backends = new Map([
				["primary", primaryBackend],
				["vision-backend", visionBackend],
			]);
			const modelRouter = new ModelRouter(backends, "primary");

			const resolution = resolveModel("primary", modelRouter, db, "site-1", { vision: true });
			expect(resolution.kind).toBe("local");
			const localRes = resolution as Extract<ModelResolution, { kind: "local" }>;
			expect(localRes.modelId).toBe("vision-backend");
			expect(localRes.reResolved).toBe(true);
		});

		// AC2.2 — re-resolution sets reResolved flag
		it("sets reResolved: true when alternative backend is used (AC2.2)", () => {
			const primaryBackend = {
				id: "primary",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const altBackend = {
				id: "alt",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([
				["primary", primaryBackend],
				["alt", altBackend],
			]);
			const modelRouter = new ModelRouter(backends, "primary");

			const resolution = resolveModel("primary", modelRouter, db, "site-1", {
				prompt_caching: true,
			});
			const localRes = resolution as Extract<ModelResolution, { kind: "local" }>;
			expect(localRes.reResolved).toBe(true);
		});

		// AC2.3 — capability-mismatch when no backend has the capability
		it("returns capability-mismatch when no backend supports required capability (AC2.3)", () => {
			const backend1 = {
				id: "backend-1",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const backend2 = {
				id: "backend-2",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([
				["backend-1", backend1],
				["backend-2", backend2],
			]);
			const modelRouter = new ModelRouter(backends, "backend-1");

			const resolution = resolveModel("backend-1", modelRouter, db, "site-1", { vision: true });
			expect(resolution.kind).toBe("error");
			const errorRes = resolution as Extract<ModelResolution, { kind: "error" }>;
			expect(errorRes.reason).toBe("capability-mismatch");
			expect(errorRes.unmetCapabilities).toContain("vision");
		});

		// AC2.4 — transient-unavailable when capable backends are all rate-limited
		it("returns transient-unavailable with earliestRecovery when all capable backends are rate-limited (AC2.4)", () => {
			const primaryBackend = {
				id: "primary",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const visionBackend = {
				id: "vision-backend",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: true,
					max_context: 200000,
				}),
			};

			const backends = new Map([
				["primary", primaryBackend],
				["vision-backend", visionBackend],
			]);
			const modelRouter = new ModelRouter(backends, "primary");

			// Mark the vision backend as rate-limited
			modelRouter.markRateLimited("vision-backend", 60_000);

			const resolution = resolveModel("primary", modelRouter, db, "site-1", { vision: true });
			expect(resolution.kind).toBe("error");
			const errorRes = resolution as Extract<ModelResolution, { kind: "error" }>;
			expect(errorRes.reason).toBe("transient-unavailable");
			expect(errorRes.earliestRecovery).toBeGreaterThan(Date.now());
		});

		// AC2.1 alternative — tool_use requirement
		it("routes to tool-use-capable backend when requirements.tool_use is set", () => {
			const noToolBackend = {
				id: "no-tools",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: false,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const toolBackend = {
				id: "with-tools",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([
				["no-tools", noToolBackend],
				["with-tools", toolBackend],
			]);
			const modelRouter = new ModelRouter(backends, "no-tools");

			const resolution = resolveModel("no-tools", modelRouter, db, "site-1", { tool_use: true });
			expect(resolution.kind).toBe("local");
			const localRes = resolution as Extract<ModelResolution, { kind: "local" }>;
			expect(localRes.modelId).toBe("with-tools");
			expect(localRes.reResolved).toBe(true);
		});

		// AC2.3 alternative — multiple unmet capabilities
		it("includes all unmet capabilities in error message", () => {
			const limitedBackend = {
				id: "limited",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: false,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["limited", limitedBackend]]);
			const modelRouter = new ModelRouter(backends, "limited");

			const resolution = resolveModel("limited", modelRouter, db, "site-1", {
				vision: true,
				tool_use: true,
				prompt_caching: true,
			});
			expect(resolution.kind).toBe("error");
			const errorRes = resolution as Extract<ModelResolution, { kind: "error" }>;
			expect(errorRes.reason).toBe("capability-mismatch");
			expect(errorRes.unmetCapabilities).toContain("vision");
			expect(errorRes.unmetCapabilities).toContain("tool_use");
			expect(errorRes.unmetCapabilities).toContain("prompt_caching");
		});

		// Backward compatibility — requirements undefined
		it("resolves text-only request without requirements to first available backend", () => {
			const backend1 = {
				id: "backend-1",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["backend-1", backend1]]);
			const modelRouter = new ModelRouter(backends, "backend-1");

			// No requirements passed
			const resolution = resolveModel("backend-1", modelRouter, db, "site-1");
			expect(resolution.kind).toBe("local");
			const localRes = resolution as Extract<ModelResolution, { kind: "local" }>;
			expect(localRes.reResolved).toBeUndefined();
		});

		// Edge case: primary backend has no capabilities metadata
		it("handles backends with missing capability metadata gracefully", () => {
			const mockBackend = {
				id: "unknown-caps",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 200000,
				}),
			};

			const altBackend = {
				id: "alt",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: true,
					max_context: 200000,
				}),
			};

			const backends = new Map([
				["unknown-caps", mockBackend],
				["alt", altBackend],
			]);
			// Create router without explicit effectiveCaps to test fallback
			const modelRouter = new ModelRouter(backends, "unknown-caps");

			// Even though primary has no vision, should still route to alt
			const resolution = resolveModel("unknown-caps", modelRouter, db, "site-1", {
				vision: true,
			});
			expect(resolution.kind).toBe("local");
			const localRes = resolution as Extract<ModelResolution, { kind: "local" }>;
			expect(localRes.modelId).toBe("alt");
		});

		it("resolveModel with vision requirement excludes remote hosts without vision capability (AC7.2 end-to-end)", () => {
			const now = new Date().toISOString();

			// Insert a remote host with vision-model that lacks vision capability
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"remote-no-vision",
					"Remote No Vision",
					JSON.stringify([
						{
							id: "vision-model",
							tier: 1,
							capabilities: { vision: false, tool_use: true },
						},
					]),
					0,
					now,
					now,
				],
			);

			const mockBackend = {
				id: "local-model",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["local-model", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "local-model");

			// Request vision-model with vision requirement
			const resolution = resolveModel("vision-model", modelRouter, db, "local-site", {
				vision: true,
			});

			// Should be error since remote host doesn't have vision
			expect(resolution.kind).toBe("error");
		});

		it("routes a remote host with no capability metadata (legacy string format) to kind:error — no guessed window (AC7.3 end-to-end)", () => {
			const now = new Date().toISOString();

			// Insert a remote host with legacy string format (no capabilities)
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["legacy-remote", "Legacy Remote", JSON.stringify(["vision-model"]), 0, now, now],
			);

			const mockBackend = {
				id: "local-model",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["local-model", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "local-model");

			// Request vision-model WITHOUT requirements (no capability filtering)
			const resolution = resolveModel("vision-model", modelRouter, db, "local-site");

			// A legacy string-format host advertises no context window, so the loop
			// can't budget against it. Resolution surfaces a retryable error rather
			// than dispatching on a guessed default — the host must advertise caps.
			expect(resolution.kind).toBe("error");
			if (resolution.kind === "error") {
				expect(resolution.error).toMatch(/no context window/i);
				expect(resolution.reason).toBe("transient-unavailable");
			}
		});

		it("resolveModel with vision requirement falls back to unverified when no verified match (AC7.3)", () => {
			const now = new Date().toISOString();

			// Insert a remote host with verified entry that lacks vision
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"remote-verified-no-vision",
					"Remote Verified No Vision",
					JSON.stringify([
						{
							id: "vision-model",
							tier: 1,
							capabilities: { vision: false, tool_use: true },
						},
					]),
					0,
					now,
					now,
				],
			);

			// Insert a legacy unverified host for the same model
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"legacy-remote-fallback",
					"Legacy Remote Fallback",
					JSON.stringify(["vision-model"]),
					0,
					now,
					now,
				],
			);

			const mockBackend = {
				id: "local-model",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tools: true,
					vision: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([["local-model", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "local-model");

			// Request with vision requirement
			const resolution = resolveModel("vision-model", modelRouter, db, "local-site", {
				vision: true,
			});

			// The verified host fails the vision requirement and the only fallback
			// is a legacy unverified host with no advertised window. Neither can be
			// budgeted, so resolution surfaces a retryable error instead of
			// dispatching the unverified host on a guessed default.
			expect(resolution.kind).toBe("error");
			if (resolution.kind === "error") {
				expect(resolution.error).toMatch(/no context window/i);
				expect(resolution.reason).toBe("transient-unavailable");
			}
		});

		// AC5.3 — primary backend is rate-limited, alternative exists with matching capability
		it("does NOT re-route a rate-limited, capability-mismatched model to a different model (R-RT7/R-RT8, AC5.3)", () => {
			// Under the routing redesign, resolution never substitutes a different
			// logical model to satisfy a capability or a rate limit: a route failure
			// only fails over to other routes for the SAME model, and cross-model
			// switching is a refusal-only path (slice 5). A rate-limited primary that
			// lacks the requested capability, with no same-model route elsewhere, is a
			// transient error — not a silent jump onto an unrelated vision-capable model.
			const primaryBackend = {
				id: "primary",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					extended_thinking: false,
					max_context: 200000,
				}),
			};

			const alternativeBackend = {
				id: "alternative",
				chat: async function* () {
					yield { type: "text", text: "test" } as const;
				},
				capabilities: () => ({
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: true,
					extended_thinking: false,
					max_context: 200000,
				}),
			};

			const backends = new Map([
				["primary", primaryBackend],
				["alternative", alternativeBackend],
			]);
			const modelRouter = new ModelRouter(backends, "primary");

			// Mark the primary backend as rate-limited and request vision (which
			// primary lacks). There is no same-model route elsewhere.
			modelRouter.markRateLimited("primary", 60_000);
			const resolution = resolveModel("primary", modelRouter, db, "site-1", { vision: true });

			// No substitution onto the unrelated vision-capable model.
			expect(resolution.kind).toBe("error");
			if (resolution.kind === "error") {
				expect(resolution.reason).toBe("transient-unavailable");
			}
		});
	});
});

describe("route health half-open trial gating (#285, R-RT12)", () => {
	function makeLocalRouter(modelId: string, clock?: () => number): ModelRouter {
		const backend = {
			id: modelId,
			chat: async function* () {
				yield { type: "text" as const, text: "ok" };
			},
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				extended_thinking: false,
				max_context: 200000,
			}),
		};
		const routeId = `local-site:test:${modelId}` as const;
		return new ModelRouter(
			new Map([[modelId, backend]]),
			modelId,
			undefined,
			undefined,
			undefined,
			clock,
			new Map([[modelId, { routeId, reasoningOrigin: "local-site:test" }]]),
		);
	}

	function insertPriorOkTurn(threadId: string, modelId: string, routeId: string): void {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO turns (id, thread_id, model_id, route_id, tokens_in, tokens_out, cost_usd, created_at, status, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			[
				`turn-${Math.random().toString(16).slice(2)}`,
				threadId,
				modelId,
				routeId,
				100,
				5,
				0.01,
				now,
				"ok",
				now,
			],
		);
	}

	it("a WARM sticky thread is NEVER stuck to a backing-off/half_open route; it falls through to ranked [Done-when #4]", () => {
		const modelId = "gpt-5.6-sol";
		const router = makeLocalRouter(modelId);
		const routeId = router.getRouteId(modelId);
		expect(routeId).not.toBeNull();

		// A warm sticky thread with a prior ok turn on the local route.
		const threadId = "warm-thread";
		insertPriorOkTurn(threadId, modelId, routeId as string);

		// Trip the route into backoff. A non-healthy route is excluded from the
		// sticky pool (isHealthyForSticky === false), so a warm thread never trials
		// it.
		router.recordRouteFailure(modelId, { errorKind: "server" });
		expect(router.isHealthyForSticky(modelId)).toBe(false);

		// With no other route for the model, resolution surfaces a transient-
		// unavailable error rather than quietly reusing the recovering route under a
		// warm thread.
		const resolution = resolveModel(modelId, router, db, "local-site", undefined, {
			threadId,
			nowMs: Date.now(),
		});
		expect(resolution.kind).toBe("error");
		if (resolution.kind === "error") {
			expect(resolution.reason).toBe("transient-unavailable");
		}
	});

	it("a NEW/cold thread (no prior turn) trials a half_open route via the ranked path [Done-when #2]", () => {
		const modelId = "gpt-5.6-sol";
		let nowMs = 1_000_000;
		const router = makeLocalRouter(modelId, () => nowMs);

		router.recordRouteFailure(modelId, { errorKind: "server" }); // 30s backoff
		expect(router.isRateLimited(modelId)).toBe(true); // backoff → unavailable
		nowMs += 30_000; // expire the window → half_open on next read
		expect(router.isRateLimited(modelId)).toBe(false); // half_open → selectable

		// A new/cold thread (no prior ok turn) resolves onto the half_open route —
		// this IS the real-traffic trial. No stickiness because there is no prior turn.
		const resolution = resolveModel(modelId, router, db, "local-site", undefined, {
			threadId: "cold-new-thread",
			nowMs,
		});
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.modelId).toBe(modelId);
		}
	});

	it("claims the single per-host trial slot: a SECOND concurrent cold thread does not also trial a half_open route [R-RT12]", () => {
		const modelId = "gpt-5.6-sol";
		let nowMs = 1_000_000;
		const router = makeLocalRouter(modelId, () => nowMs);

		router.recordRouteFailure(modelId, { errorKind: "server" }); // 30s backoff
		nowMs += 30_000; // expire the window → half_open
		expect(router.getRouteHealthState(modelId).status).toBe("half_open");

		// First cold thread resolves onto the half_open route and claims the single
		// per-host trial slot.
		const first = resolveModel(modelId, router, db, "local-site", undefined, {
			threadId: "cold-thread-A",
			nowMs,
		});
		expect(first.kind).toBe("local");
		expect(router.getRouteHealthState(modelId).status).toBe("half_open");
		if (router.getRouteHealthState(modelId).status === "half_open") {
			// The slot is now held — trial_in_flight is true.
			const state = router.getRouteHealthState(modelId);
			if (state.status === "half_open") expect(state.trial_in_flight).toBe(true);
		}

		// A SECOND concurrent cold thread must NOT also trial the same route: the slot
		// is taken, so resolution surfaces transient-unavailable (no other route for
		// this model) rather than sending a second concurrent trial.
		const second = resolveModel(modelId, router, db, "local-site", undefined, {
			threadId: "cold-thread-B",
			nowMs,
		});
		expect(second.kind).toBe("error");
		if (second.kind === "error") {
			expect(second.reason).toBe("transient-unavailable");
		}
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// findAnyRemoteModel + hub-only resolveModel path
// ──────────────────────────────────────────────────────────────────────────────

describe("findAnyRemoteModel", () => {
	it("returns the best remote model when a spoke has advertised models", () => {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			["spoke-1", "spoke", JSON.stringify([{ id: "claude" }]), now, now],
		);

		const result = findAnyRemoteModel(db, "local-site");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.modelId).toBe("claude");
			expect(result.hosts[0].site_id).toBe("spoke-1");
		}
	});

	it("ranks remote models by stable RouteId, not tier (R-RT8)", () => {
		// tier is gone; across spokes the lexically-smaller route_id wins, with no
		// tier preference. aaa-spoke:... sorts before zzz-spoke:...
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[
				"zzz-spoke",
				"z",
				JSON.stringify([{ id: "llama3", route_id: "zzz-spoke:openai-compatible:llama3" }]),
				now,
				now,
			],
		);
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[
				"aaa-spoke",
				"a",
				JSON.stringify([{ id: "claude", route_id: "aaa-spoke:bedrock:claude" }]),
				now,
				now,
			],
		);

		const result = findAnyRemoteModel(db, "local-site");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.modelId).toBe("claude"); // aaa-spoke route_id sorts first
			expect(result.hosts[0].site_id).toBe("aaa-spoke");
		}
	});

	it("excludes stale hosts (online_at older than 5 minutes)", () => {
		const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			["spoke-stale", "stale", JSON.stringify([{ id: "gpt-4", tier: 3 }]), stale, stale],
		);

		const result = findAnyRemoteModel(db, "local-site");

		expect(result.ok).toBe(false);
	});

	it("excludes the local site from candidates", () => {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			["local-site", "self", JSON.stringify([{ id: "claude", tier: 2 }]), now, now],
		);

		const result = findAnyRemoteModel(db, "local-site");

		expect(result.ok).toBe(false);
	});
});

describe("resolveModel — hub-only mode (empty default)", () => {
	it("discovers any remote spoke model when local default is empty", () => {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[
				"spoke-1",
				"spoke",
				JSON.stringify([{ id: "claude-3", tier: 2, capabilities: { max_context: 200000 } }]),
				now,
				now,
			],
		);

		// Hub-only: empty router (no local backends)
		const emptyRouter = new ModelRouter(new Map(), "");
		const resolution = resolveModel("", emptyRouter, db, "hub-site");

		expect(resolution.kind).toBe("remote");
		if (resolution.kind === "remote") {
			expect(resolution.modelId).toBe("claude-3");
			expect(resolution.hosts[0].site_id).toBe("spoke-1");
		}
	});

	it("returns error when hub-only and no remote spokes available", () => {
		const emptyRouter = new ModelRouter(new Map(), "");
		const resolution = resolveModel("", emptyRouter, db, "hub-site");

		expect(resolution.kind).toBe("error");
		if (resolution.kind === "error") {
			expect(resolution.error).toMatch(/no remote inference backends/i);
		}
	});
});

// `resolveSameTierFallback` and `resolveModelTier` were removed in the
// 2026-11-21-model-routing slice 2 (R-RT3). Under the spec a route failure only
// fails over to other routes for the same logical model; switching to a
// different model happens only on a refusal (slice 5). A model whose routes are
// all down returns `transient-unavailable` and is not substituted, so the
// same-tier substitution tests that lived here no longer describe real behavior.

// AC.3 — readiness gate. A not-ready (self-configuring) backend must NOT
// resolve `kind:"local"` even when it is the default and even with no
// requirements; it resolves `transient-unavailable` (retryable), not
// `capability-mismatch`. After expansion the concrete model resolves local.
describe("resolveModel readiness gate (AC.3)", () => {
	function readinessBackend(ready: boolean) {
		return {
			id: "umans",
			readiness: {
				isReady: () => ready,
				start: () => {},
				dispose: () => {},
			},
			chat: async function* () {},
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: true,
				vision: false,
				extended_thinking: false,
				max_context: 0,
			}),
		};
	}

	it("defers a not-ready default with NO requirements to transient-unavailable (not kind:local)", () => {
		const backends = new Map([["umans", readinessBackend(false)]]);
		const router = new ModelRouter(backends, "umans");
		const resolution = resolveModel(undefined, router, db, "local-site");
		expect(resolution.kind).toBe("error");
		if (resolution.kind === "error") {
			expect(resolution.reason).toBe("transient-unavailable");
		}
	});

	it("defers a not-ready default WITH requirements to transient-unavailable (not capability-mismatch)", () => {
		const backends = new Map([["umans", readinessBackend(false)]]);
		const router = new ModelRouter(backends, "umans");
		const resolution = resolveModel(undefined, router, db, "local-site", { tool_use: true });
		expect(resolution.kind).toBe("error");
		if (resolution.kind === "error") {
			expect(resolution.reason).toBe("transient-unavailable");
		}
	});

	it("resolves a concrete model id local once the readiness backend is ready and expanded", () => {
		// Simulate post-expansion: a concrete backend is registered, the
		// namespace removed, not-ready cleared.
		const concrete = {
			id: "umans-coder",
			chat: async function* () {},
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: true,
				vision: false,
				extended_thinking: false,
				max_context: 200000,
			}),
		};
		const backends = new Map([["umans", readinessBackend(false)]]);
		const router = new ModelRouter(backends, "umans");
		router.addDynamicBackend("umans-coder", concrete, concrete.capabilities());
		router.redirectDefault("umans", "umans-coder");
		router.removeBackend("umans");

		const resolution = resolveModel("umans-coder", router, db, "local-site");
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.modelId).toBe("umans-coder");
		}
		// The default now resolves to the concrete model too.
		const def = resolveModel(undefined, router, db, "local-site");
		expect(def.kind).toBe("local");
	});
});

describe("required context window (no silent default)", () => {
	const backendWithCaps = (caps: Record<string, unknown>) => ({
		id: "model-under-test",
		chat: async function* () {
			yield { type: "text" as const, text: "test" };
		},
		capabilities: () => caps,
	});

	it("resolves a local backend that advertises a window to kind:local with that window", () => {
		const backend = backendWithCaps({
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			extended_thinking: false,
			max_context: 128000,
		});
		const router = new ModelRouter(new Map([["model-under-test", backend]]), "model-under-test");

		const resolution = resolveModel("model-under-test", router, db, "local-site");
		expect(resolution.kind).toBe("local");
		const local = resolution as Extract<ModelResolution, { kind: "local" }>;
		expect(local.max_context).toBe(128000);
	});

	it("routes a local backend with no advertised context window to kind:error (no 200k default)", () => {
		// capabilities() omits max_context — the exact case the old `?? 200_000`
		// masked. A ready local backend should always advertise one, so absence
		// is a misconfiguration we surface rather than a window we guess.
		const backend = backendWithCaps({
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			extended_thinking: false,
		});
		const router = new ModelRouter(new Map([["model-under-test", backend]]), "model-under-test");

		const resolution = resolveModel("model-under-test", router, db, "local-site");
		expect(resolution.kind).toBe("error");
		if (resolution.kind === "error") {
			expect(resolution.error).toMatch(/no context window/i);
			expect(resolution.reason).toBe("transient-unavailable");
		}
	});
});

describe("resolveTargetCapabilities", () => {
	const fullCaps = {
		streaming: true,
		tool_use: true,
		system_prompt: true,
		prompt_caching: true,
		vision: true,
		extended_thinking: false,
		max_context: 200000,
	};

	function routerStub(caps: typeof fullCaps | null) {
		return {
			getEffectiveCapabilities: () => caps,
		} as unknown as ModelRouter;
	}

	function remoteHost(capabilities?: {
		streaming?: boolean;
		tool_use?: boolean;
		system_prompt?: boolean;
		prompt_caching?: boolean;
		vision?: boolean;
		max_context?: number;
	}) {
		return {
			site_id: "remote-site",
			host_name: "remote-host",
			sync_url: null,
			online_at: null,
			modified_at: null,
			capabilities,
		};
	}

	it("local: returns the router's effective capabilities verbatim", () => {
		const res: ModelResolution = {
			kind: "local",
			backend: {} as any,
			modelId: "opus",
			max_context: 200000,
		};
		expect(resolveTargetCapabilities(res, routerStub(fullCaps))).toEqual(fullCaps);
	});

	it("local: propagates null when the backend id is unregistered", () => {
		const res: ModelResolution = {
			kind: "local",
			backend: {} as any,
			modelId: "ghost",
			max_context: 200000,
		};
		expect(resolveTargetCapabilities(res, routerStub(null))).toBeNull();
	});

	it("remote: surfaces a non-vision backend's vision:false (the regression) so the substitution gate fires", () => {
		// REGRESSION: this branch used to return `undefined`, skipping Stage 5b
		// substitution and shipping raw image blocks to a text-only remote
		// backend (e.g. umans-glm-5.2) — a hard "content.type invalid" failure.
		const res: ModelResolution = {
			kind: "remote",
			hosts: [remoteHost({ vision: false, prompt_caching: true, max_context: 128000 })],
			modelId: "umans-glm-5.2",
			max_context: 128000,
		};
		const caps = resolveTargetCapabilities(res, routerStub(fullCaps));
		expect(caps).not.toBeNull();
		expect(caps?.vision).toBe(false);
	});

	it("remote: preserves an advertised vision:true", () => {
		const res: ModelResolution = {
			kind: "remote",
			hosts: [remoteHost({ vision: true, max_context: 200000 })],
			modelId: "opus",
			max_context: 200000,
		};
		expect(resolveTargetCapabilities(res, routerStub(null))?.vision).toBe(true);
	});

	it("remote: defaults vision to false when the host advertised caps but no vision flag (never ship raw images to an unconfirmed backend)", () => {
		const res: ModelResolution = {
			kind: "remote",
			hosts: [remoteHost({ prompt_caching: true, max_context: 128000 })],
			modelId: "some-remote",
			max_context: 128000,
		};
		expect(resolveTargetCapabilities(res, routerStub(null))?.vision).toBe(false);
	});

	it("remote: returns null when the chosen host advertised no capabilities", () => {
		const res: ModelResolution = {
			kind: "remote",
			hosts: [remoteHost(undefined)],
			modelId: "some-remote",
			max_context: 128000,
		};
		expect(resolveTargetCapabilities(res, routerStub(null))).toBeNull();
	});

	it("remote: returns null when the hosts array is empty", () => {
		const res: ModelResolution = {
			kind: "remote",
			hosts: [],
			modelId: "some-remote",
			max_context: 128000,
		};
		expect(resolveTargetCapabilities(res, routerStub(null))).toBeNull();
	});

	it("error: returns null", () => {
		const res: ModelResolution = { kind: "error", error: "no backends" };
		expect(resolveTargetCapabilities(res, routerStub(fullCaps))).toBeNull();
	});
});
