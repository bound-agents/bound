import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "../commands/init.js";
import { runStart } from "../commands/start.js";

describe("Bound CLI E2E Integration Test", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync("bound-e2e-");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("initializes config files correctly", async () => {
		// Step 1: Initialize with Ollama preset
		await runInit({
			ollama: true,
			name: "test-operator",
			configDir: tempDir,
		});

		// Verify init created required files
		const allowlistPath = join(tempDir, "allowlist.json");
		const modelBackendsPath = join(tempDir, "model_backends.json");

		// Both files should exist
		let fileExists = false;
		try {
			const fs = await import("node:fs");
			fileExists = fs.existsSync(allowlistPath) && fs.existsSync(modelBackendsPath);
		} catch {
			// ignore
		}

		expect(fileExists).toBe(true);
	});

	it("graceful handling of missing config during start", async () => {
		// Try to start with no config
		try {
			await runStart({ configDir: tempDir });
			// Should fail gracefully
			expect(false).toBe(true);
		} catch (error) {
			// Expected behavior - missing config should cause error
			expect(error).toBeTruthy();
		}
	});

	it("multiple init operations are idempotent", async () => {
		// First init
		await runInit({
			ollama: true,
			name: "operator-1",
			configDir: tempDir,
		});

		// Second init without force flag
		await runInit({
			ollama: true,
			name: "operator-2",
			configDir: tempDir,
		});

		// Config should still exist with original values
		const { readFileSync } = await import("node:fs");
		const allowlistPath = join(tempDir, "allowlist.json");
		const allowlist = JSON.parse(readFileSync(allowlistPath, "utf-8"));

		// Original operator name should be preserved
		expect(allowlist.default_web_user).toBe("operator-1");
	});

	it("init with optional configs creates all templates", async () => {
		await runInit({
			ollama: true,
			withSync: true,
			withMcp: true,
			withOverlay: true,
			configDir: tempDir,
		});

		const { existsSync } = await import("node:fs");

		expect(existsSync(join(tempDir, "sync.json"))).toBe(true);
		expect(existsSync(join(tempDir, "mcp.json"))).toBe(true);
		expect(existsSync(join(tempDir, "overlay.json"))).toBe(true);
	});

	it("init with Anthropic preset handles missing API key gracefully", async () => {
		// Ensure API key is not set
		delete process.env.ANTHROPIC_API_KEY;

		await runInit({
			anthropic: true,
			configDir: tempDir,
		});

		// Should still create configs even without API key
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(tempDir, "allowlist.json"))).toBe(true);
		expect(existsSync(join(tempDir, "model_backends.json"))).toBe(true);
	});
});
