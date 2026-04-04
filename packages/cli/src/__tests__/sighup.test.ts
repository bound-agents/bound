import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyringConfig } from "@bound/shared";

// Mock logger for testing
class TestLogger {
	logs: Array<{ level: string; message: string; details?: unknown }> = [];

	info(message: string, details?: unknown) {
		this.logs.push({ level: "info", message, details });
	}

	warn(message: string, details?: unknown) {
		this.logs.push({ level: "warn", message, details });
	}

	error(message: string, details?: unknown) {
		this.logs.push({ level: "error", message, details });
	}

	debug(message: string, details?: unknown) {
		this.logs.push({ level: "debug", message, details });
	}

	getMessages(level?: string): string[] {
		return this.logs.filter((l) => !level || l.level === level).map((l) => l.message);
	}
}

describe("SIGHUP handler", () => {
	let tempDir: string;
	let testLogger: TestLogger;

	beforeEach(() => {
		tempDir = mkdtempSync("bound-sighup-test-");
		testLogger = new TestLogger();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("AC12.1: reloads optional configs and updates appContext", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		// Create config files with minimal valid JSON (will be caught by schema validation)
		writeFileSync(join(tempDir, "sync.json"), JSON.stringify({ hub: "http://hub", sync_interval_seconds: 30 }));
		writeFileSync(join(tempDir, "keyring.json"), JSON.stringify({ hosts: {} }));

		const mockAppContext = {
			logger: testLogger,
			optionalConfig: {},
		} as any;

		await reloadConfigs({
			appContext: mockAppContext,
			configDir: tempDir,
			logger: testLogger,
		});

		// Verify configs were loaded (only those created files will be in the result)
		expect(mockAppContext.optionalConfig.sync?.ok).toBe(true);
		expect(mockAppContext.optionalConfig.keyring?.ok).toBe(true);
	});

	it("AC12.2: calls keyManager.reloadKeyring when keyring changed", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		let reloadCalled = false;
		let receivedKeyring: KeyringConfig | null = null;
		const mockKeyManager = {
			reloadKeyring(newKeyring: KeyringConfig) {
				reloadCalled = true;
				receivedKeyring = newKeyring;
			},
		} as any;

		// Initial state has empty keyring
		const mockAppContext = {
			logger: testLogger,
			optionalConfig: {
				keyring: {
					ok: true,
					value: { hosts: {} },
				},
			},
		} as any;

		// New keyring with a peer should trigger reloadKeyring
		writeFileSync(
			join(tempDir, "keyring.json"),
			JSON.stringify({
				hosts: { peer1: { public_key: "ed25519:test", url: "http://peer1:8080" } },
			}),
		);

		await reloadConfigs({
			appContext: mockAppContext,
			configDir: tempDir,
			keyManager: mockKeyManager,
			logger: testLogger,
		});

		// Verify KeyManager.reloadKeyring was called with the new keyring
		expect(reloadCalled).toBe(true);
		expect(receivedKeyring?.hosts.peer1).toBeTruthy();
	});

	it("AC12.3: skips keyring reload when keyring unchanged", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		let reloadCount = 0;
		const mockKeyManager = {
			reloadKeyring(newKeyring: KeyringConfig) {
				reloadCount++;
			},
		} as any;

		const keyringValue = { hosts: { peer1: { public_key: "ed25519:test", url: "http://peer1:8080" } } };

		const mockAppContext = {
			logger: testLogger,
			optionalConfig: {
				keyring: {
					ok: true,
					value: keyringValue,
				},
			},
		} as any;

		// Same keyring as before (no changes)
		writeFileSync(join(tempDir, "keyring.json"), JSON.stringify(keyringValue));

		await reloadConfigs({
			appContext: mockAppContext,
			configDir: tempDir,
			keyManager: mockKeyManager,
			logger: testLogger,
		});

		// keyManager.reloadKeyring should NOT have been called (config unchanged)
		expect(reloadCount).toBe(0);
	});

	it("AC12.5: bad config file is non-fatal, keeps previous value", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		const mockAppContext = {
			logger: testLogger,
			optionalConfig: {
				sync: {
					ok: true,
					value: { hub: "http://hub", sync_interval_seconds: 30 },
				},
			},
		} as any;

		// Write invalid JSON to sync.json
		writeFileSync(join(tempDir, "sync.json"), "{ invalid json");

		// Create a valid keyring file
		writeFileSync(
			join(tempDir, "keyring.json"),
			JSON.stringify({ hosts: { peer1: { public_key: "ed25519:test", url: "http://peer1:8080" } } }),
		);

		await reloadConfigs({
			appContext: mockAppContext,
			configDir: tempDir,
			logger: testLogger,
		});

		// Verify sync config is unchanged (previous value kept due to error)
		expect(mockAppContext.optionalConfig.sync?.ok).toBe(true);
		expect(mockAppContext.optionalConfig.sync?.value.hub).toBe("http://hub");

		// Verify keyring was still updated
		expect(mockAppContext.optionalConfig.keyring?.ok).toBe(true);

		// Verify error was logged
		const errors = testLogger.getMessages("error");
		expect(errors.some((e) => e.includes("sync"))).toBe(true);
	});

	it("AC12.6: concurrent reloads handled gracefully", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		const mockAppContext = {
			logger: testLogger,
			optionalConfig: {},
		} as any;

		writeFileSync(join(tempDir, "sync.json"), JSON.stringify({ hub: "http://hub", sync_interval_seconds: 30 }));

		const config = {
			appContext: mockAppContext,
			configDir: tempDir,
			logger: testLogger,
		};

		// Start two reloads concurrently and verify both complete
		const [result1, result2] = await Promise.all([reloadConfigs(config), reloadConfigs(config)]);

		// Both should complete successfully
		expect(result1).toBeUndefined();
		expect(result2).toBeUndefined();

		// Verify at least one reload attempt was logged
		const infoLogs = testLogger.getMessages("info");
		expect(infoLogs.some((m) => m.includes("Reloading"))).toBe(true);
	});
});
