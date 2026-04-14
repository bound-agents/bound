import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import { ModelRouter } from "@bound/llm";
import {
	type ModelResolution,
	resolveModel,
	resolveModelTier,
	resolveSameTierFallback,
} from "../model-resolution";

// Test database setup
let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-model-resolution-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
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
					maxContextWindow: 200000,
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
					maxContextWindow: 200000,
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
				["remote-1", "Remote Host", JSON.stringify(["claude-haiku"]), 0, now, now],
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
					maxContextWindow: 200000,
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
					maxContextWindow: 200000,
				}),
			};

			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("unknown-model-xyz", modelRouter, db, "local-site");

			expect(resolution.kind).toBe("error");
			if (resolution.kind === "error") {
				expect(resolution.error).toContain("unknown-model-xyz");
				expect(resolution.error).toContain("claude-opus");
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
					maxContextWindow: 200000,
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
					maxContextWindow: 200000,
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
					maxContextWindow: 200000,
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

		it("sorts remote hosts by online_at when returning remote resolution (AC2.2)", () => {
			const now = new Date();
			const recentTime = new Date(now.getTime() - 1 * 60 * 1000).toISOString();
			const olderTime = new Date(now.getTime() - 3 * 60 * 1000).toISOString();

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"older-host",
					"Older Host",
					JSON.stringify(["claude-haiku"]),
					0,
					olderTime,
					new Date().toISOString(),
				],
			);

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"recent-host",
					"Recent Host",
					JSON.stringify(["claude-haiku"]),
					0,
					recentTime,
					new Date().toISOString(),
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
					maxContextWindow: 200000,
				}),
			};

			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			const resolution = resolveModel("claude-haiku", modelRouter, db, "local-site");

			expect(resolution.kind).toBe("remote");
			if (resolution.kind === "remote") {
				expect(resolution.hosts[0].site_id).toBe("recent-host");
				expect(resolution.hosts[1].site_id).toBe("older-host");
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
					maxContextWindow: 200000,
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

		it("resolveModel with no requirements accepts remote hosts without capability metadata (AC7.3 end-to-end)", () => {
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
					maxContextWindow: 200000,
				}),
			};

			const backends = new Map([["local-model", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "local-model");

			// Request vision-model WITHOUT requirements (no capability filtering)
			const resolution = resolveModel("vision-model", modelRouter, db, "local-site");

			// Should be remote since host is available (unverified legacy format accepted)
			expect(resolution.kind).toBe("remote");
			if (resolution.kind === "remote") {
				expect(resolution.hosts.length).toBe(1);
				expect(resolution.hosts[0].unverified).toBe(true);
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
					maxContextWindow: 200000,
				}),
			};

			const backends = new Map([["local-model", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "local-model");

			// Request with vision requirement
			const resolution = resolveModel("vision-model", modelRouter, db, "local-site", {
				vision: true,
			});

			// Should fall back to unverified host when no verified match
			expect(resolution.kind).toBe("remote");
			if (resolution.kind === "remote") {
				expect(resolution.hosts.length).toBe(1);
				expect(resolution.hosts[0].unverified).toBe(true);
				expect(resolution.hosts[0].site_id).toBe("legacy-remote-fallback");
			}
		});

		// AC5.3 — primary backend is rate-limited, alternative exists with matching capability
		it("falls back to alternative when primary backend is rate-limited (AC5.3)", () => {
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
					max_context: 200000,
				}),
			};

			const backends = new Map([
				["primary", primaryBackend],
				["alternative", alternativeBackend],
			]);
			const modelRouter = new ModelRouter(backends, "primary");

			// Mark the primary backend as rate-limited
			modelRouter.markRateLimited("primary", 60_000);

			// Request vision capability; primary lacks vision and is rate-limited
			// listEligible() should exclude primary (rate-limited) and return only alternative
			const resolution = resolveModel("primary", modelRouter, db, "site-1", { vision: true });

			// Should fall back to alternative backend
			expect(resolution.kind).toBe("local");
			const localRes = resolution as Extract<ModelResolution, { kind: "local" }>;
			expect(localRes.modelId).toBe("alternative");
			expect(localRes.reResolved).toBe(true);
		});
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// findAnyRemoteModel + hub-only resolveModel path
// ──────────────────────────────────────────────────────────────────────────────

import { findAnyRemoteModel } from "../relay-router";

describe("findAnyRemoteModel", () => {
	it("returns the best remote model when a spoke has advertised models", () => {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			["spoke-1", "spoke", JSON.stringify([{ id: "claude", tier: 2 }]), now, now],
		);

		const result = findAnyRemoteModel(db, "local-site");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.modelId).toBe("claude");
			expect(result.hosts[0].site_id).toBe("spoke-1");
		}
	});

	it("prefers lower-tier models across multiple spokes", () => {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			["spoke-high", "high-tier", JSON.stringify([{ id: "llama3", tier: 5 }]), now, now],
		);
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			["spoke-low", "low-tier", JSON.stringify([{ id: "claude", tier: 2 }]), now, now],
		);

		const result = findAnyRemoteModel(db, "local-site");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.modelId).toBe("claude"); // lower tier wins
			expect(result.hosts[0].site_id).toBe("spoke-low");
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
			["spoke-1", "spoke", JSON.stringify([{ id: "claude-3", tier: 2 }]), now, now],
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

describe("resolveSameTierFallback", () => {
	const makeMockBackend = (caps?: Partial<{ vision: boolean; tool_use: boolean }>) => ({
		chat: async function* () {
			yield { type: "text" as const, text: "test" };
		},
		capabilities: () => ({
			streaming: true,
			tool_use: caps?.tool_use ?? true,
			system_prompt: true,
			prompt_caching: false,
			vision: caps?.vision ?? false,
			max_context: 200000,
		}),
	});

	it("returns a same-tier alternative when requested model is unavailable", () => {
		const backendA = makeMockBackend();
		const backendB = makeMockBackend();

		const backends = new Map([
			["glm", backendA],
			["phi3", backendB],
		]);
		const tiers = new Map([
			["glm", 1],
			["phi3", 1],
		]);
		const router = new ModelRouter(backends, "glm", undefined, tiers);

		// "deepseek" doesn't exist, but we tell the fallback it was tier 1
		const result = resolveSameTierFallback("deepseek", router, db, "local-site", 1);

		expect(result).not.toBeNull();
		if (result) {
			expect(result.kind).toBe("local");
			if (result.kind === "local") {
				// Should pick one of the tier-1 backends
				expect(["glm", "phi3"]).toContain(result.modelId);
			}
		}
	});

	it("returns null when no same-tier alternative exists", () => {
		const backendA = makeMockBackend();

		const backends = new Map([["opus", backendA]]);
		const tiers = new Map([["opus", 5]]);
		const router = new ModelRouter(backends, "opus", undefined, tiers);

		// Looking for tier 1 alternatives, but only tier 5 exists
		const result = resolveSameTierFallback("glm", router, db, "local-site", 1);

		expect(result).toBeNull();
	});

	it("excludes the originally-requested model from fallback candidates", () => {
		const backendA = makeMockBackend();

		const backends = new Map([["glm", backendA]]);
		const tiers = new Map([["glm", 1]]);
		const router = new ModelRouter(backends, "glm", undefined, tiers);

		// "glm" itself is the only tier-1 backend, but it's the one that failed
		const result = resolveSameTierFallback("glm", router, db, "local-site", 1);

		expect(result).toBeNull();
	});

	it("respects capability requirements when finding fallback", () => {
		const visionBackend = makeMockBackend({ vision: true });
		const noVisionBackend = makeMockBackend({ vision: false });

		const backends = new Map([
			["llava", visionBackend],
			["phi3", noVisionBackend],
		]);
		const tiers = new Map([
			["llava", 1],
			["phi3", 1],
		]);
		const router = new ModelRouter(backends, "phi3", undefined, tiers);

		// Requesting vision, only llava has it
		const result = resolveSameTierFallback("deepseek", router, db, "local-site", 1, {
			vision: true,
		});

		expect(result).not.toBeNull();
		if (result && result.kind === "local") {
			expect(result.modelId).toBe("llava");
		}
	});
});

	it("normalizes literal 'default' model hint to the actual default backend", () => {
		const mockBackend = {
			id: "opus",
			chat: async function* () {
				yield { type: "text" as const, text: "test" };
			},
			capabilities: () => ({
				streaming: true,
				tools: true,
				vision: false,
				maxContextWindow: 200000,
			}),
		};

		const backends = new Map([["opus", mockBackend]]);
		const modelRouter = new ModelRouter(backends, "opus");

		// Passing "default" should resolve to the default backend ("opus"), not fail
		const resolution = resolveModel("default", modelRouter, db, "local-site");

		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.modelId).toBe("opus");
		}
	});
});

describe("resolveModelTier", () => {
	it("returns local tier when model is in the local router", () => {
		const backend = {
			chat: async function* () {
				yield { type: "text" as const, text: "test" };
			},
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				max_context: 4096,
			}),
		};

		const backends = new Map([["glm-4.7", backend]]);
		const tiers = new Map([["glm-4.7", 2]]);
		const router = new ModelRouter(backends, "glm-4.7", undefined, tiers);

		const tier = resolveModelTier("glm-4.7", router, db, "local-site");
		expect(tier).toBe(2);
	});

	it("returns remote tier from hosts table when model not in local router", () => {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, 0, ?, ?)`,
			[
				"remote-spoke",
				"Remote Spoke",
				JSON.stringify([{ id: "glm-4.7", tier: 2, capabilities: {} }]),
				now,
				now,
			],
		);

		// Empty router — hub-only node
		const router = new ModelRouter(new Map(), "");

		const tier = resolveModelTier("glm-4.7", router, db, "hub-site");
		expect(tier).toBe(2);
	});

	it("returns null when model not found anywhere", () => {
		const router = new ModelRouter(new Map(), "");
		const tier = resolveModelTier("nonexistent", router, db, "local-site");
		expect(tier).toBeNull();
	});

	it("returns lowest tier when multiple remote hosts advertise same model at different tiers", () => {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, 0, ?, ?)`,
			[
				"spoke-a",
				"Spoke A",
				JSON.stringify([{ id: "glm-4.7", tier: 3, capabilities: {} }]),
				now,
				now,
			],
		);
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, 0, ?, ?)`,
			[
				"spoke-b",
				"Spoke B",
				JSON.stringify([{ id: "glm-4.7", tier: 2, capabilities: {} }]),
				now,
				now,
			],
		);

		const router = new ModelRouter(new Map(), "");
		const tier = resolveModelTier("glm-4.7", router, db, "hub-site");
		expect(tier).toBe(2);
	});
});

describe("resolveSameTierFallback — remote hosts", () => {
	it("finds a remote same-tier alternative when no local backends exist", () => {
		const now = new Date().toISOString();
		// Remote host has sonnet at tier 2
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, 0, ?, ?)`,
			[
				"spoke-with-sonnet",
				"Sonnet Spoke",
				JSON.stringify([{ id: "sonnet", tier: 2, capabilities: { tool_use: true } }]),
				now,
				now,
			],
		);

		// Empty local router (hub-only)
		const router = new ModelRouter(new Map(), "");

		// glm-4.7 at tier 2 failed, looking for same-tier alternative
		const result = resolveSameTierFallback("glm-4.7", router, db, "hub-site", 2);

		expect(result).not.toBeNull();
		if (result) {
			expect(result.kind).toBe("remote");
			if (result.kind === "remote") {
				expect(result.modelId).toBe("sonnet");
				expect(result.hosts[0].site_id).toBe("spoke-with-sonnet");
			}
		}
	});

	it("excludes the failed model from remote candidates", () => {
		const now = new Date().toISOString();
		// Remote host only has glm-4.7 (the model that failed)
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, 0, ?, ?)`,
			[
				"spoke-glm-only",
				"GLM Spoke",
				JSON.stringify([{ id: "glm-4.7", tier: 2, capabilities: {} }]),
				now,
				now,
			],
		);

		const router = new ModelRouter(new Map(), "");

		const result = resolveSameTierFallback("glm-4.7", router, db, "hub-site", 2);
		expect(result).toBeNull();
	});

	it("prefers local backends over remote hosts", () => {
		const now = new Date().toISOString();
		// Remote host has sonnet at tier 2
		db.run(
			`INSERT INTO hosts (site_id, host_name, models, deleted, online_at, modified_at)
			 VALUES (?, ?, ?, 0, ?, ?)`,
			[
				"spoke-remote",
				"Remote Spoke",
				JSON.stringify([{ id: "sonnet", tier: 2, capabilities: {} }]),
				now,
				now,
			],
		);

		// Local router also has a tier-2 backend
		const localBackend = {
			chat: async function* () {
				yield { type: "text" as const, text: "test" };
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
		const backends = new Map([["local-sonnet", localBackend]]);
		const tiers = new Map([["local-sonnet", 2]]);
		const router = new ModelRouter(backends, "local-sonnet", undefined, tiers);

		const result = resolveSameTierFallback("glm-4.7", router, db, "local-site", 2);

		expect(result).not.toBeNull();
		if (result) {
			// Should prefer local
			expect(result.kind).toBe("local");
		}
	});
});
