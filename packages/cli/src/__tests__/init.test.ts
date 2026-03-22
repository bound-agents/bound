import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "../commands/init.js";

describe("bound init", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync("bound-test-");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates allowlist.json and model_backends.json with --ollama preset", async () => {
		await runInit({
			ollama: true,
			configDir: tempDir,
		});

		const allowlistPath = join(tempDir, "allowlist.json");
		const modelBackendsPath = join(tempDir, "model_backends.json");

		// Verify files exist
		expect(readFileSync(allowlistPath, "utf-8")).toBeTruthy();
		expect(readFileSync(modelBackendsPath, "utf-8")).toBeTruthy();

		// Verify content
		const allowlist = JSON.parse(readFileSync(allowlistPath, "utf-8"));
		const modelBackends = JSON.parse(readFileSync(modelBackendsPath, "utf-8"));

		// Check allowlist structure
		expect(allowlist).toHaveProperty("default_web_user");
		expect(allowlist).toHaveProperty("users");
		expect(Object.keys(allowlist.users).length).toBeGreaterThan(0);

		// Check model_backends structure
		expect(modelBackends).toHaveProperty("backends");
		expect(modelBackends).toHaveProperty("default");
		expect(modelBackends.backends.length).toBe(1);
		expect(modelBackends.backends[0].provider).toBe("ollama");
	});

	it("does not overwrite existing config without --force flag", async () => {
		// First init
		await runInit({
			ollama: true,
			configDir: tempDir,
		});

		const allowlistPath = join(tempDir, "allowlist.json");
		const originalContent = readFileSync(allowlistPath, "utf-8");

		// Second init should not overwrite
		await runInit({
			ollama: true,
			configDir: tempDir,
		});

		const finalContent = readFileSync(allowlistPath, "utf-8");
		expect(finalContent).toBe(originalContent);
	});

	it("overwrites existing config with --force flag", async () => {
		// First init
		await runInit({
			ollama: true,
			name: "user1",
			configDir: tempDir,
		});

		// Second init with force should overwrite
		await runInit({
			ollama: true,
			name: "user2",
			force: true,
			configDir: tempDir,
		});

		const allowlistPath = join(tempDir, "allowlist.json");
		const allowlist = JSON.parse(readFileSync(allowlistPath, "utf-8"));

		// The operator name should be updated
		expect(allowlist.default_web_user).toBe("user2");
	});

	it("creates optional config files with --with-sync", async () => {
		await runInit({
			ollama: true,
			withSync: true,
			configDir: tempDir,
		});

		const syncPath = join(tempDir, "sync.json");
		const syncContent = readFileSync(syncPath, "utf-8");
		const sync = JSON.parse(syncContent);

		expect(sync).toHaveProperty("hub");
		expect(sync).toHaveProperty("sync_interval_seconds");
	});

	it("creates mcp.json template with --with-mcp", async () => {
		await runInit({
			ollama: true,
			withMcp: true,
			configDir: tempDir,
		});

		const mcpPath = join(tempDir, "mcp.json");
		const mcpContent = readFileSync(mcpPath, "utf-8");
		const mcp = JSON.parse(mcpContent);

		expect(mcp).toHaveProperty("servers");
		expect(Array.isArray(mcp.servers)).toBe(true);
	});

	it("creates overlay.json template with --with-overlay", async () => {
		await runInit({
			ollama: true,
			withOverlay: true,
			configDir: tempDir,
		});

		const overlayPath = join(tempDir, "overlay.json");
		const overlayContent = readFileSync(overlayPath, "utf-8");
		const overlay = JSON.parse(overlayContent);

		expect(overlay).toHaveProperty("mounts");
	});

	it("uses custom name with --name flag", async () => {
		await runInit({
			ollama: true,
			name: "custom-operator",
			configDir: tempDir,
		});

		const allowlistPath = join(tempDir, "allowlist.json");
		const allowlist = JSON.parse(readFileSync(allowlistPath, "utf-8"));

		expect(allowlist.default_web_user).toBe("custom-operator");
		expect(allowlist.users).toHaveProperty("custom-operator");
	});

	it("creates Anthropic preset with --anthropic", async () => {
		// Set env var for test
		process.env.ANTHROPIC_API_KEY = "test-key";

		await runInit({
			anthropic: true,
			configDir: tempDir,
		});

		const modelBackendsPath = join(tempDir, "model_backends.json");
		const modelBackends = JSON.parse(readFileSync(modelBackendsPath, "utf-8"));

		expect(modelBackends.backends[0].provider).toBe("anthropic");
		expect(modelBackends.backends[0].model).toBe("claude-3-5-sonnet-20241022");
	});
});
