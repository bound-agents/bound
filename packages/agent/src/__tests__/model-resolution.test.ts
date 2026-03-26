import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import { ModelRouter } from "@bound/llm";
import { resolveModel } from "../model-resolution";

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
});
