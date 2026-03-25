/**
 * Config key consistency test.
 *
 * Verifies that the keys stored by the config loader in optionalConfig
 * match the keys actually used by consuming code throughout the codebase.
 *
 * This catches the exact class of bug where the loader stores a config
 * under key "cronSchedules" but the consumer looks for "cron_schedules",
 * causing the feature to silently never activate.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/**
 * Recursively collect all .ts files under a directory, skipping node_modules.
 */
function collectTsFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			collectTsFiles(full, acc);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
			acc.push(full);
		}
	}
	return acc;
}

describe("Config key consistency", () => {
	// Extract the keys that the config loader stores
	const LOADER_KEYS = (() => {
		// Read the source of loadOptionalConfigs to extract the key values
		const configLoaderPath = join(PROJECT_ROOT, "packages/core/src/config-loader.ts");
		const source = readFileSync(configLoaderPath, "utf-8");

		const keys: string[] = [];
		// Match pattern: key: "..." in the optionalConfigs array
		const keyPattern = /key:\s*"([^"]+)"/g;
		let match: RegExpExecArray | null;
		while ((match = keyPattern.exec(source)) !== null) {
			keys.push(match[1]);
		}
		return keys;
	})();

	it("config loader defines at least the known optional config keys", () => {
		// These are the keys we know should exist from the config loader source
		expect(LOADER_KEYS).toContain("network");
		expect(LOADER_KEYS).toContain("discord");
		expect(LOADER_KEYS).toContain("sync");
		expect(LOADER_KEYS).toContain("keyring");
		expect(LOADER_KEYS).toContain("mcp");
		expect(LOADER_KEYS).toContain("overlay");
		expect(LOADER_KEYS).toContain("cronSchedules");
	});

	it("all optionalConfig[...] lookups in the codebase use keys from the loader", () => {
		const packagesDir = join(PROJECT_ROOT, "packages");
		const tsFiles = collectTsFiles(packagesDir);

		// Patterns to match:
		//   optionalConfig["someKey"]
		//   optionalConfig['someKey']
		//   optionalConfig.someKey
		const bracketPattern = /optionalConfig\[["']([^"']+)["']\]/g;
		const dotPattern = /optionalConfig\.([a-zA-Z_]+)/g;

		const usedKeys = new Set<string>();
		const usages: Array<{ file: string; key: string }> = [];

		for (const file of tsFiles) {
			// Skip test files and this test itself
			if (file.includes("__tests__") || file.includes(".test.")) continue;

			const content = readFileSync(file, "utf-8");

			let match: RegExpExecArray | null;

			while ((match = bracketPattern.exec(content)) !== null) {
				usedKeys.add(match[1]);
				usages.push({ file: file.replace(packagesDir, ""), key: match[1] });
			}

			while ((match = dotPattern.exec(content)) !== null) {
				usedKeys.add(match[1]);
				usages.push({ file: file.replace(packagesDir, ""), key: match[1] });
			}
		}

		// Every key used in production code must be a key the loader stores
		const loaderKeySet = new Set(LOADER_KEYS);
		const unknownKeys: Array<{ key: string; file: string }> = [];

		for (const usage of usages) {
			if (!loaderKeySet.has(usage.key)) {
				unknownKeys.push(usage);
			}
		}

		if (unknownKeys.length > 0) {
			const details = unknownKeys.map((u) => `  ${u.key} in ${u.file}`).join("\n");
			console.error(
				`Found optionalConfig lookups with keys not stored by the config loader:\n${details}`,
			);
		}

		expect(unknownKeys.length).toBe(0);
	});

	it("cron_schedules.json maps to 'cronSchedules' key (documents the naming convention)", () => {
		// The filename is cron_schedules.json but the optionalConfig key is
		// camelCased to "cronSchedules".  Any consumer must use "cronSchedules".
		expect(LOADER_KEYS).toContain("cronSchedules");

		// Verify the scheduler uses the correct key
		const schedulerPath = join(PROJECT_ROOT, "packages/agent/src/scheduler.ts");
		const schedulerSource = readFileSync(schedulerPath, "utf-8");
		expect(schedulerSource).toContain('optionalConfig["cronSchedules"]');
	});

	it("config loader filename-to-key mapping is internally consistent", () => {
		// Read the array literal from the config loader and verify each entry
		const configLoaderPath = join(PROJECT_ROOT, "packages/core/src/config-loader.ts");
		const source = readFileSync(configLoaderPath, "utf-8");

		// Extract filename/key pairs
		const pairPattern = /filename:\s*"([^"]+)",\s*schema:\s*\w+.*?,\s*key:\s*"([^"]+)"/gs;
		const pairs: Array<{ filename: string; key: string }> = [];
		let match: RegExpExecArray | null;
		while ((match = pairPattern.exec(source)) !== null) {
			pairs.push({ filename: match[1], key: match[2] });
		}

		expect(pairs.length).toBeGreaterThan(0);

		// Each pair's key must be a valid JS identifier
		for (const pair of pairs) {
			expect(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pair.key)).toBe(true);
		}

		// No duplicate keys
		const keys = pairs.map((p) => p.key);
		const uniqueKeys = [...new Set(keys)];
		expect(keys.length).toBe(uniqueKeys.length);

		// No duplicate filenames
		const filenames = pairs.map((p) => p.filename);
		const uniqueFilenames = [...new Set(filenames)];
		expect(filenames.length).toBe(uniqueFilenames.length);
	});
});
