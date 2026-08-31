import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { createAppContext } from "../app-context";
import { ConfigService, DatabaseService, EventBusService, bootstrapContainer } from "../container";

describe("DI Container", async () => {
	let configDir: string;
	let dbPath: string;

	beforeEach(() => {
		configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(configDir, { recursive: true });
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);

		// Create valid config files
		const allowlist = {
			default_web_user: "alice",
			users: {
				alice: { display_name: "Alice" },
			},
		};

		const backends = {
			backends: [
				{
					id: "ollama-local",
					provider: "openai-compatible",
					model: "llama3",
					context_window: 4096,
					tier: 1,
					base_url: "http://localhost:11434",
				},
			],
			default: "ollama-local",
		};

		writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(allowlist));
		writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(backends));
	});

	afterEach(async () => {
		try {
			await cleanupTmpDir(configDir);
		} catch {
			// ignore
		}
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("bootstraps container successfully with valid configs", async () => {
		const container = await bootstrapContainer(configDir, dbPath);
		expect(container).toBeDefined();
	});

	it("resolves DatabaseService singleton", async () => {
		const container = await bootstrapContainer(configDir, dbPath);
		const db1 = container.resolve(DatabaseService);
		const db2 = container.resolve(DatabaseService);

		// Should be the same instance (singleton)
		expect(db1).toBe(db2);
	});

	it("resolves ConfigService singleton", async () => {
		const container = await bootstrapContainer(configDir, dbPath);
		const config1 = container.resolve(ConfigService);
		const config2 = container.resolve(ConfigService);

		expect(config1).toBe(config2);
	});

	it("resolves EventBusService singleton", async () => {
		const container = await bootstrapContainer(configDir, dbPath);
		const eventBus1 = container.resolve(EventBusService);
		const eventBus2 = container.resolve(EventBusService);

		expect(eventBus1).toBe(eventBus2);
	});

	it("throws error when config files are missing", async () => {
		// Remove config files
		require("node:fs").unlinkSync(join(configDir, "allowlist.json"));

		await expect(bootstrapContainer(configDir, dbPath)).rejects.toThrow();
	});

	it("throws error when config validation fails", async () => {
		// Write invalid config
		const invalidAllowlist = {
			default_web_user: "alice",
			users: {}, // Invalid: must have at least one user
		};

		writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(invalidAllowlist));

		await expect(bootstrapContainer(configDir, dbPath)).rejects.toThrow();
	});

	it("creates database with schema on bootstrap", async () => {
		await bootstrapContainer(configDir, dbPath);

		// Verify tables exist
		const db = require("bun:sqlite").Database;
		const testDb = new db(dbPath);
		const tables = testDb
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
			.all() as Array<{ name: string }>;

		expect(tables.length).toBe(34); // ... + agents (#201) + local-only row_state_hashes cache + local_flags + 1 FTS5 virtual + 5 FTS5 shadow
		testDb.close();
	});
});

describe("AppContext", async () => {
	let configDir: string;
	let dbPath: string;

	beforeEach(() => {
		configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(configDir, { recursive: true });
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);

		const allowlist = {
			default_web_user: "alice",
			users: {
				alice: { display_name: "Alice" },
			},
		};

		const backends = {
			backends: [
				{
					id: "ollama-local",
					provider: "openai-compatible",
					model: "llama3",
					context_window: 4096,
					tier: 1,
					base_url: "http://localhost:11434",
				},
			],
			default: "ollama-local",
		};

		writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(allowlist));
		writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(backends));
	});

	afterEach(async () => {
		try {
			await cleanupTmpDir(configDir);
		} catch {
			// ignore
		}
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("creates AppContext with all services", async () => {
		const ctx = await createAppContext(configDir, dbPath);

		expect(ctx).toBeDefined();
		expect(ctx.db).toBeDefined();
		expect(ctx.config).toBeDefined();
		expect(ctx.eventBus).toBeDefined();
		expect(ctx.logger).toBeDefined();
		expect(ctx.siteId).toBeDefined();
		expect(ctx.hostName).toBeDefined();
	});

	it("generates site_id on first creation", async () => {
		const ctx = await createAppContext(configDir, dbPath);
		expect(ctx.siteId).toBeDefined();
		expect(ctx.siteId.length).toBeGreaterThan(0);

		// Verify site_id is stored in host_meta
		const hostMeta = ctx.db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get() as {
			value: string;
		};

		expect(hostMeta.value).toBe(ctx.siteId);
	});

	it("reuses existing site_id on subsequent creations", async () => {
		const ctx1 = await createAppContext(configDir, dbPath);
		const siteId1 = ctx1.siteId;
		ctx1.db.close();

		// Create another context with the same database path
		const ctx2 = await createAppContext(configDir, dbPath);
		const siteId2 = ctx2.siteId;
		ctx2.db.close();

		// Site IDs should match
		expect(siteId1).toBe(siteId2);
	});

	it("loads configuration into AppContext", async () => {
		const ctx = await createAppContext(configDir, dbPath);

		expect(ctx.config.allowlist.default_web_user).toBe("alice");
		expect(ctx.config.modelBackends.default).toBe("ollama-local");
	});

	it("provides typed event bus", async () => {
		const ctx = await createAppContext(configDir, dbPath);

		let received: unknown = null;
		ctx.eventBus.on("message:created", (data) => {
			received = data;
		});

		const mockMessage: Message = {
			id: "msg-1",
			thread_id: "thread-123",
			role: "user",
			content: "test",
			model_id: null,
			tool_name: null,
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			host_origin: "test",
		};

		ctx.eventBus.emit("message:created", {
			message: mockMessage,
			thread_id: "thread-123",
		});

		expect(received).toBeDefined();
	});

	it("initializes logger service", async () => {
		const ctx = await createAppContext(configDir, dbPath);

		expect(ctx.logger).toBeDefined();
		expect(typeof ctx.logger.info).toBe("function");
		expect(typeof ctx.logger.warn).toBe("function");
		expect(typeof ctx.logger.error).toBe("function");
		expect(typeof ctx.logger.debug).toBe("function");
	});
});
