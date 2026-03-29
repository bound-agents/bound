# MCP Server — Phase 4: Build Script Updates

**Goal:** Compile all three binaries (`bound`, `boundctl`, `bound-mcp`) from `scripts/build.ts` and report all three sizes in build output.

**Architecture:** Pure infrastructure change — extend the existing `build.ts` script with two additional `bun build --compile` steps mirroring the existing `bound` step. No new packages or dependencies.

**Tech Stack:** Bun, `scripts/build.ts` (already uses `execSync`, `statSync`, `existsSync`)

**Scope:** Phase 4 of 4

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

This is an infrastructure phase. Verified operationally (not by automated tests).

**Verifies: None** — the phase verifies via `bun run build` producing all three binaries.

---

<!-- START_TASK_1 -->
### Task 1: Add `boundctl` and `bound-mcp` compile steps to `scripts/build.ts`

**Files:**
- Modify: `scripts/build.ts` (full rewrite)

**Current state of `scripts/build.ts`:**
- Line 1: `#!/usr/bin/env bun`
- Lines 5–6: imports `execSync`, `existsSync`, `statSync`
- Lines 8–35: `build()` function with:
  - Step 1 (lines 13–18): web assets
  - Step 2 (lines 21–29): compile `dist/bound` (with try/catch + fallback message)
  - Summary (lines 31–35): report `dist/bound` size if it exists

**Replace `scripts/build.ts` with this complete file:**

```typescript
#!/usr/bin/env bun
// Build script for Bound
// Builds web assets (with embedded SPA) and compiles all binaries

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

async function build() {
	console.log("Building Bound...\n");

	// Step 1: Build web assets + embed for binary
	console.log("1. Building web UI...");
	try {
		execSync("cd packages/web && bun run build", { stdio: "inherit" });
	} catch {
		console.error("Failed to build web assets");
		process.exit(1);
	}

	// Step 2: Compile bound (main agent binary)
	console.log("\n2. Compiling bound binary...");
	try {
		execSync("bun build --compile packages/cli/src/bound.ts --outfile dist/bound", {
			stdio: "inherit",
		});
	} catch {
		console.error("Binary compilation failed (expected in some dev environments)");
		console.log("Use 'bun packages/cli/src/bound.ts' to run directly");
	}

	// Step 3: Compile boundctl (management CLI)
	console.log("\n3. Compiling boundctl binary...");
	try {
		execSync("bun build --compile packages/cli/src/boundctl.ts --outfile dist/boundctl", {
			stdio: "inherit",
		});
	} catch {
		console.error("boundctl compilation failed");
		console.log("Use 'bun packages/cli/src/boundctl.ts' to run directly");
	}

	// Step 4: Compile bound-mcp (MCP stdio server)
	console.log("\n4. Compiling bound-mcp binary...");
	try {
		execSync(
			"bun build --compile packages/mcp-server/src/server.ts --outfile dist/bound-mcp",
			{ stdio: "inherit" },
		);
	} catch {
		console.error("bound-mcp compilation failed");
		console.log("Use 'bun packages/mcp-server/src/server.ts' to run directly");
	}

	// Summary
	console.log("\n--- Build summary ---");
	for (const binary of ["dist/bound", "dist/boundctl", "dist/bound-mcp"]) {
		if (existsSync(binary)) {
			const sizeMB = (statSync(binary).size / (1024 * 1024)).toFixed(2);
			console.log(`  ${binary} (${sizeMB} MB)`);
		} else {
			console.log(`  ${binary} (not built)`);
		}
	}
}

build().catch((error) => {
	console.error("Build failed:", error);
	process.exit(1);
});
```

**Verification:**

Ensure all three binaries compile successfully:

```bash
bun run build
```

Expected output (sizes will vary):
```
Building Bound...

1. Building web UI...
...
2. Compiling bound binary...
...
3. Compiling boundctl binary...
...
4. Compiling bound-mcp binary...
...

--- Build summary ---
  dist/bound (XX.XX MB)
  dist/boundctl (XX.XX MB)
  dist/bound-mcp (XX.XX MB)
```

Expected: all three binaries appear in the summary with non-zero sizes.

Then smoke-test the new binaries are executable:

```bash
./dist/boundctl --help 2>&1 | head -3
./dist/bound-mcp --help 2>&1 | head -3 || true
```

Expected: `./dist/boundctl` prints usage. `./dist/bound-mcp --help` may time out or print nothing (it expects MCP stdio input) but must not immediately crash with a non-zero exit.

**Commit:** `build: compile boundctl and bound-mcp binaries in build script`
<!-- END_TASK_1 -->
