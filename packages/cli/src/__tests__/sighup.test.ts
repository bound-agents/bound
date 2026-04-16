import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyringConfig, Logger } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import type { KeyManager } from "@bound/sync";

// Test type for AppContext used in unit tests
interface TestAppContext {
	logger: Logger;
	optionalConfig: Record<string, { ok: boolean; value?: unknown; error?: unknown }>;
}

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

	afterEach(async () => {
		await cleanupTmpDir(tempDir);
	});

	it("AC12.1: reloads optional configs and updates appContext", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		// Create config files with minimal valid JSON (will be caught by schema validation)
		writeFileSync(join(tempDir, "sync.json"), JSON.stringify({ hub: "http://hub" }));
		writeFileSync(join(tempDir, "keyring.json"), JSON.stringify({ hosts: {} }));

		const mockAppContext: TestAppContext = {
			logger: testLogger,
			optionalConfig: {},
		};

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
		const mockKeyManager: Partial<KeyManager> = {
			reloadKeyring(_newKeyring: KeyringConfig) {
				reloadCalled = true;
				receivedKeyring = _newKeyring;
			},
		};

		// Initial state has empty keyring
		const mockAppContext: TestAppContext = {
			logger: testLogger,
			optionalConfig: {
				keyring: {
					ok: true,
					value: { hosts: {} },
				},
			},
		};

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
		const mockKeyManager: Partial<KeyManager> = {
			reloadKeyring(_newKeyring: KeyringConfig) {
				reloadCount++;
			},
		};

		const keyringValue = {
			hosts: { peer1: { public_key: "ed25519:test", url: "http://peer1:8080" } },
		};

		const mockAppContext: TestAppContext = {
			logger: testLogger,
			optionalConfig: {
				keyring: {
					ok: true,
					value: keyringValue,
				},
			},
		};

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

	it("AC12.4: removed peers evicted from keyManager", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		let reloadCalled = false;
		let receivedKeyring: KeyringConfig | null = null;
		const mockKeyManager: Partial<KeyManager> = {
			reloadKeyring(newKeyring: KeyringConfig) {
				reloadCalled = true;
				receivedKeyring = newKeyring;
			},
		};

		// Initial state has peers A and B
		const keyringWithBoth = {
			hosts: {
				peer_a: { public_key: "ed25519:test_a", url: "http://peer_a:8080" },
				peer_b: { public_key: "ed25519:test_b", url: "http://peer_b:8080" },
			},
		};

		const mockAppContext: TestAppContext = {
			logger: testLogger,
			optionalConfig: {
				keyring: {
					ok: true,
					value: keyringWithBoth,
				},
			},
		};

		// Reload with only peer A (peer B removed)
		const keyringWithoutB = {
			hosts: {
				peer_a: { public_key: "ed25519:test_a", url: "http://peer_a:8080" },
			},
		};

		writeFileSync(join(tempDir, "keyring.json"), JSON.stringify(keyringWithoutB));

		await reloadConfigs({
			appContext: mockAppContext,
			configDir: tempDir,
			keyManager: mockKeyManager,
			logger: testLogger,
		});

		// Verify KeyManager.reloadKeyring was called with reduced keyring
		expect(reloadCalled).toBe(true);
		expect(receivedKeyring?.hosts.peer_a).toBeTruthy();
		expect(receivedKeyring?.hosts.peer_b).toBeUndefined();
		// Verify appContext was updated to the reduced keyring
		expect(mockAppContext.optionalConfig.keyring.value.hosts.peer_b).toBeUndefined();
	});

	it("AC12.5: bad config file is non-fatal, keeps previous value", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		const mockAppContext: TestAppContext = {
			logger: testLogger,
			optionalConfig: {
				sync: {
					ok: true,
					value: { hub: "http://hub" },
				},
			},
		};

		// Write invalid JSON to sync.json
		writeFileSync(join(tempDir, "sync.json"), "{ invalid json");

		// Create a valid keyring file
		writeFileSync(
			join(tempDir, "keyring.json"),
			JSON.stringify({
				hosts: { peer1: { public_key: "ed25519:test", url: "http://peer1:8080" } },
			}),
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

	it("calls mcpReload callback when mcp config changes", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		let reloadCalled = false;
		let receivedOldConfig: unknown = null;
		let receivedNewConfig: unknown = null;

		const mcpValue = {
			servers: [{ name: "old-server", command: "echo", transport: "stdio" }],
		};

		const mockAppContext: TestAppContext = {
			logger: testLogger,
			optionalConfig: {
				mcp: { ok: true, value: mcpValue },
			},
		};

		// Write new mcp.json with a different server
		const newMcpValue = {
			servers: [{ name: "new-server", command: "test", transport: "stdio" }],
		};
		writeFileSync(join(tempDir, "mcp.json"), JSON.stringify(newMcpValue));

		await reloadConfigs({
			appContext: mockAppContext,
			configDir: tempDir,
			logger: testLogger,
			onMcpConfigChanged: async (oldConfig, newConfig) => {
				reloadCalled = true;
				receivedOldConfig = oldConfig;
				receivedNewConfig = newConfig;
			},
		});

		expect(reloadCalled).toBe(true);
		expect((receivedOldConfig as { servers: unknown[] }).servers).toHaveLength(1);
		expect((receivedNewConfig as { servers: unknown[] }).servers).toHaveLength(1);
	});

	it("does not call mcpReload when mcp config unchanged", async () => {
		const { reloadConfigs } = await import("../sighup.js");

		let reloadCalled = false;

		// Key order must match Zod parse output: discriminant (transport) comes
		// before extension fields (command) in discriminatedUnion parsing.
		const mcpValue = {
			servers: [{ name: "server", transport: "stdio", command: "echo" }],
		};

		const mockAppContext: TestAppContext = {
			logger: testLogger,
			optionalConfig: {
				mcp: { ok: true, value: mcpValue },
			},
		};

		// Write same mcp.json (Zod will parse to same key order)
		writeFileSync(join(tempDir, "mcp.json"), JSON.stringify(mcpValue));

		await reloadConfigs({
			appContext: mockAppContext,
			configDir: tempDir,
			logger: testLogger,
			onMcpConfigChanged: async () => {
				reloadCalled = true;
			},
		});

		expect(reloadCalled).toBe(false);
	});

	it("AC12.6: concurrent reloads handled gracefully", async () => {
		const mockAppContext: TestAppContext = {
			logger: testLogger,
			optionalConfig: {},
		};

		writeFileSync(join(tempDir, "sync.json"), JSON.stringify({ hub: "http://hub" }));

		const config = {
			appContext: mockAppContext,
			configDir: tempDir,
			logger: testLogger,
			delayMs: 50, // Inject delay to force both calls to overlap during work
		};

		// Import the module
		const { reloadConfigs } = await import("../sighup.js");

		// Start two reloads concurrently via Promise.all
		// The delayMs will cause both to be running simultaneously during the work phase
		// The second call will check reloadInProgress while the first is still running
		const [result1, result2] = await Promise.all([reloadConfigs(config), reloadConfigs(config)]);

		// Both should complete successfully (one does work, one skips due to guard)
		expect(result1).toBeUndefined();
		expect(result2).toBeUndefined();

		// Verify the guard worked by checking message counts
		const infoLogs = testLogger.getMessages("info");
		const reloadingLogs = infoLogs.filter((m) => m.includes("Reloading optional configs"));

		const warnLogs = testLogger.getMessages("warn");
		const skipLogs = warnLogs.filter((m) => m.includes("reload already in progress"));

		// With the delay, second call should definitely see reloadInProgress as true
		// and log the skip message
		expect(skipLogs.length).toBe(1);
		// Only first call should log "Reloading"
		expect(reloadingLogs.length).toBe(1);
	});
});
