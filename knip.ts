import type { KnipConfig } from "knip";

// Dead-code gate (`bun run knip`). Test files count as usage: the bun plugin
// treats `*.test.ts` as entries, so helpers exported for tests stay live.
// Every suppression below carries the reason it cannot be statically traced.
const config: KnipConfig = {
	workspaces: {
		".": {
			entry: [
				"scripts/*.ts",
				"scripts/__tests__/**/*.ts",
				// Compiled by scripts/test-sandbox-compiled.ts via Bun.build entrypoints.
				"scripts/fixtures/sandbox-smoke.ts",
				"e2e/**/*.ts",
			],
			project: ["scripts/**/*.ts", "e2e/**/*.ts"],
			ignoreDependencies: [
				// Pinned so node-gyp's lifecycle deps resolve for the kotlin postinstall build.
				"abbrev",
				"node-gyp",
				"nopt",
				// Root scripts resolve these from the hoisted workspace packages that declare them.
				"svelte",
				/^tree-sitter(-.+)?$/,
			],
			// Spawned as `bun scripts/build-sandbox-runtime.ts` from the repo root, not a relative import.
			ignoreUnresolved: ["scripts/build-sandbox-runtime.ts"],
		},
		"packages/cli": {
			project: ["src/**/*.ts"],
		},
		"packages/less": {
			entry: ["src/boundless.tsx"],
			project: ["src/**/*.{ts,tsx}"],
		},
		"packages/web": {
			entry: ["scripts/**/*.ts"],
			project: ["src/**/*.{ts,svelte}", "scripts/**/*.ts"],
		},
		"packages/docs": {
			entry: ["scripts/*.ts", "src/sidebar.ts"],
		},
		"packages/agent": {
			entry: ["scripts/**/*.ts"],
			project: ["src/**/*.ts", "scripts/**/*.ts"],
		},
		"packages/shared": {
			entry: ["scripts/**/*.ts"],
			project: ["src/**/*.ts", "scripts/**/*.ts"],
			ignoreDependencies: [
				// Loaded by string name in scripts/probe-read-structure-grammars.ts (grammar candidates).
				"tree-sitter-c-sharp",
				"tree-sitter-lua",
				"tree-sitter-php",
				"tree-sitter-sql",
			],
		},
		"packages/*": {
			project: ["src/**/*.ts"],
		},
	},
};

export default config;
