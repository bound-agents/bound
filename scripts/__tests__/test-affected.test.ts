import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
	type WorkspaceGraph,
	buildWorkspaceGraph,
	determineAffectedPackages,
	isGlobalFile,
	packageDirForFile,
	shouldRunScriptsTests,
} from "../test-affected";

/**
 * A hand-built graph mirroring the real workspace shape closely enough to
 * exercise the closure logic:
 *   shared <- core <- agent <- {cli, sync, web}
 *   shared <- llm <- agent
 *   shared (leaf dep, depended on by everything)
 */
function fixtureGraph(): WorkspaceGraph {
	const nameToDir = new Map<string, string>([
		["@bound/shared", "packages/shared"],
		["@bound/core", "packages/core"],
		["@bound/llm", "packages/llm"],
		["@bound/agent", "packages/agent"],
		["@bound/cli", "packages/cli"],
		["@bound/sync", "packages/sync"],
		["@bound/web", "packages/web"],
	]);
	const deps = new Map<string, Set<string>>([
		["packages/shared", new Set()],
		["packages/core", new Set(["@bound/shared"])],
		["packages/llm", new Set(["@bound/shared"])],
		["packages/agent", new Set(["@bound/core", "@bound/llm", "@bound/shared"])],
		["packages/cli", new Set(["@bound/agent"])],
		["packages/sync", new Set(["@bound/agent", "@bound/core"])],
		["packages/web", new Set(["@bound/agent", "@bound/sync"])],
	]);
	const dependents = new Map<string, Set<string>>();
	for (const dir of deps.keys()) dependents.set(dir, new Set());
	for (const [dir, depNames] of deps) {
		for (const depName of depNames) {
			const depDir = nameToDir.get(depName);
			if (depDir) dependents.get(depDir)?.add(dir);
		}
	}
	return { nameToDir, deps, dependents };
}

describe("test-affected: packageDirForFile", () => {
	it("maps a file inside a package to its dir", () => {
		expect(packageDirForFile("packages/agent/src/tools/introspect.ts")).toBe("packages/agent");
	});
	it("returns null for a file outside any package", () => {
		expect(packageDirForFile("docs/design/specs/foo.md")).toBeNull();
		expect(packageDirForFile("README.md")).toBeNull();
	});
});

describe("test-affected: isGlobalFile", () => {
	it("flags test-infra config that affects every package's test outcome", () => {
		expect(isGlobalFile("bunfig.toml")).toBe(true);
		expect(isGlobalFile("package.json")).toBe(true);
		expect(isGlobalFile("scripts/test-preload.ts")).toBe(true);
	});
	it("does NOT flag the hook or the selector itself (they change selection, not outcomes)", () => {
		expect(isGlobalFile(".githooks/pre-commit")).toBe(false);
		expect(isGlobalFile("scripts/test-affected.ts")).toBe(false);
	});
	it("does not flag package-local or doc files", () => {
		expect(isGlobalFile("packages/agent/package.json")).toBe(false);
		expect(isGlobalFile("docs/foo.md")).toBe(false);
	});
});

describe("test-affected: shouldRunScriptsTests", () => {
	it("is true when a scripts/ file changed (guards the selector itself)", () => {
		expect(shouldRunScriptsTests(["scripts/test-affected.ts"])).toBe(true);
		expect(shouldRunScriptsTests(["scripts/validate-outbox-invariant.ts"])).toBe(true);
	});
	it("is false when nothing under scripts/ changed", () => {
		expect(shouldRunScriptsTests(["packages/agent/src/x.ts", "docs/foo.md"])).toBe(false);
	});
});

describe("test-affected: determineAffectedPackages", () => {
	const graph = fixtureGraph();

	it("returns empty when no package sources changed", () => {
		const affected = determineAffectedPackages(["docs/design/specs/foo.md", "README.md"], graph);
		expect(affected.size).toBe(0);
	});

	it("returns just the changed leaf-consumer package (no dependents)", () => {
		// web is a top consumer — nothing depends on it
		const affected = determineAffectedPackages(["packages/web/src/server.ts"], graph);
		expect([...affected].sort()).toEqual(["packages/web"]);
	});

	it("expands a mid-graph change to its transitive dependents", () => {
		// agent changed -> agent, plus cli, sync, web (all depend on agent;
		// web also via sync)
		const affected = determineAffectedPackages(["packages/agent/src/agent-loop.ts"], graph);
		expect([...affected].sort()).toEqual([
			"packages/agent",
			"packages/cli",
			"packages/sync",
			"packages/web",
		]);
	});

	it("expands a deep leaf-dep change across the whole consumer graph", () => {
		// shared changed -> everything that transitively depends on shared
		const affected = determineAffectedPackages(["packages/shared/src/types.ts"], graph);
		expect([...affected].sort()).toEqual([
			"packages/agent",
			"packages/cli",
			"packages/core",
			"packages/llm",
			"packages/shared",
			"packages/sync",
			"packages/web",
		]);
	});

	it("returns ALL packages when a global file changed", () => {
		const affected = determineAffectedPackages(
			["bunfig.toml", "packages/web/src/server.ts"],
			graph,
		);
		expect(affected.size).toBe(graph.deps.size);
	});

	it("unions multiple independently-changed packages", () => {
		// core changed (-> agent, cli, sync, web) and llm changed (-> agent)
		const affected = determineAffectedPackages(
			["packages/core/src/x.ts", "packages/llm/src/y.ts"],
			graph,
		);
		expect([...affected].sort()).toEqual([
			"packages/agent",
			"packages/cli",
			"packages/core",
			"packages/llm",
			"packages/sync",
			"packages/web",
		]);
	});
});

describe("test-affected: buildWorkspaceGraph (against the real repo)", () => {
	const root = resolve(import.meta.dir, "..", "..");
	const graph = buildWorkspaceGraph(root);

	it("discovers all 12 workspace packages", () => {
		expect(graph.deps.size).toBe(12);
		expect(graph.nameToDir.get("@bound/agent")).toBe("packages/agent");
	});

	it("a change to @bound/shared fans out to the entire workspace", () => {
		const affected = determineAffectedPackages(["packages/shared/src/index.ts"], graph);
		// shared is depended on (transitively) by every other package
		expect(affected.size).toBe(graph.deps.size);
	});

	it("a leaf-consumer change (cli) affects only cli", () => {
		const affected = determineAffectedPackages(["packages/cli/src/main.ts"], graph);
		expect([...affected]).toEqual(["packages/cli"]);
	});
});
