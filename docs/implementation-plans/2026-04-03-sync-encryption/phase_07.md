# Sync Encryption Implementation Plan — Phase 7: boundcurl CLI Tool

**Goal:** Standalone diagnostic binary for authenticated, encrypted access to sync endpoints, with an offline decrypt mode for captured traffic inspection.

**Architecture:** New `packages/cli/src/boundcurl.ts` entry point following the same lightweight pattern as `boundctl.ts`: load keypair via `ensureKeypair()`, load keyring from config dir, create one-shot `KeyManager` and `SyncTransport` for request mode. Two operating modes: (1) request mode sends encrypted requests and prints decrypted JSON responses, (2) decrypt mode decrypts stdin using a specified peer's shared secret. Compiled as the 4th binary alongside bound, boundctl, and bound-mcp.

**Tech Stack:** Existing CLI patterns (boundctl.ts), KeyManager + SyncTransport from earlier phases, bun build --compile

**Scope:** Phase 7 of 8 from original design

**Codebase verified:** 2026-04-03

---

## Acceptance Criteria Coverage

This phase implements and tests:

### sync-encryption.AC13: boundcurl CLI
- **sync-encryption.AC13.1 Success:** Request mode sends authenticated, encrypted request and prints decrypted JSON response
- **sync-encryption.AC13.2 Success:** Decrypt mode with explicit --nonce decrypts stdin as ciphertext
- **sync-encryption.AC13.3 Success:** Decrypt mode without --nonce interprets first 24 bytes of stdin as nonce, remainder as ciphertext
- **sync-encryption.AC13.4 Success:** Binary compiles as dist/boundcurl alongside existing 3 binaries

---

<!-- START_TASK_1 -->
### Task 1: Create boundcurl.ts entry point

**Verifies:** sync-encryption.AC13.1, sync-encryption.AC13.2, sync-encryption.AC13.3

**Files:**
- Create: `packages/cli/src/boundcurl.ts`

**Implementation:**

Create `packages/cli/src/boundcurl.ts` following the `boundctl.ts` pattern:

```typescript
#!/usr/bin/env bun
import "reflect-metadata";

import { ensureKeypair } from "@bound/sync";
import { KeyManager, SyncTransport } from "@bound/sync";
import { decryptBody } from "@bound/sync";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function getArgValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printUsage();
		process.exit(0);
	}

	const configDir = getArgValue(args, "--config-dir") || "config";
	const dataDir = getArgValue(args, "--data-dir") || "data";

	// Load keypair
	const keypair = await ensureKeypair(dataDir);

	// Load keyring
	const keyringPath = resolve(configDir, "keyring.json");
	let keyring;
	try {
		keyring = JSON.parse(readFileSync(keyringPath, "utf-8"));
	} catch {
		console.error(`Failed to load keyring from ${keyringPath}`);
		process.exit(1);
	}

	// Initialize KeyManager
	const keyManager = new KeyManager(keypair, keypair.siteId);
	await keyManager.init(keyring);

	if (args.includes("--decrypt")) {
		await decryptMode(args, keyManager);
	} else {
		await requestMode(args, keypair, keyManager, keyring);
	}
}

async function requestMode(
	args: string[],
	keypair: { publicKey: CryptoKey; privateKey: CryptoKey; siteId: string },
	keyManager: KeyManager,
	keyring: { hosts: Record<string, { public_key: string; url: string }> },
) {
	// Parse: boundcurl METHOD URL [--data BODY] [--peer SITE_ID]
	const method = args.find((a) => !a.startsWith("-") && a === a.toUpperCase()) || "GET";
	const url = args.find((a) => a.startsWith("http://") || a.startsWith("https://"));
	const data = getArgValue(args, "--data") || getArgValue(args, "-d") || "";
	const peer = getArgValue(args, "--peer");

	if (!url) {
		console.error("Error: URL required. Usage: boundcurl POST http://hub:3000/sync/pull --data '{...}'");
		process.exit(1);
	}

	// Resolve peer siteId — if not provided, try to resolve from URL and keyring
	let targetSiteId = peer;
	if (!targetSiteId) {
		// Try to find peer by URL match in keyring
		for (const [hostId, hostConfig] of Object.entries(keyring.hosts)) {
			if (url.startsWith((hostConfig as { url: string }).url)) {
				targetSiteId = hostId;
				break;
			}
		}
	}
	if (!targetSiteId) {
		console.error("Error: Could not resolve target peer. Use --peer SITE_ID.");
		process.exit(1);
	}

	const transport = new SyncTransport(keyManager, keypair.privateKey, keypair.siteId);
	const path = new URL(url).pathname;

	try {
		const response = await transport.send(method, url, path, data, targetSiteId);
		// Pretty-print JSON response
		try {
			const json = JSON.parse(response.body);
			console.log(JSON.stringify(json, null, 2));
		} catch {
			console.log(response.body);
		}
		process.exit(response.status >= 400 ? 1 : 0);
	} catch (err) {
		console.error("Request failed:", err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

async function decryptMode(args: string[], keyManager: KeyManager) {
	// Parse: boundcurl --decrypt --peer SITE_ID [--nonce HEX]
	const peer = getArgValue(args, "--peer");
	const nonceHex = getArgValue(args, "--nonce");

	if (!peer) {
		console.error("Error: --peer SITE_ID required for decrypt mode.");
		process.exit(1);
	}

	const symmetricKey = keyManager.getSymmetricKey(peer);
	if (!symmetricKey) {
		console.error(`Error: No shared secret for peer ${peer}. Check keyring.json.`);
		process.exit(1);
	}

	// Read stdin
	const chunks: Uint8Array[] = [];
	const reader = Bun.stdin.stream().getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const input = Buffer.concat(chunks);

	let nonce: Uint8Array;
	let ciphertext: Uint8Array;

	if (nonceHex) {
		// Explicit nonce: stdin is pure ciphertext (AC13.2)
		nonce = Buffer.from(nonceHex, "hex");
		ciphertext = input;
	} else {
		// No explicit nonce: first 24 bytes of stdin are nonce (AC13.3)
		if (input.length < 24) {
			console.error("Error: Input too short. Need at least 24 bytes for nonce.");
			process.exit(1);
		}
		nonce = input.slice(0, 24);
		ciphertext = input.slice(24);
	}

	try {
		const plaintext = decryptBody(ciphertext, nonce, symmetricKey);
		const text = new TextDecoder().decode(plaintext);
		// Pretty-print if JSON
		try {
			console.log(JSON.stringify(JSON.parse(text), null, 2));
		} catch {
			process.stdout.write(text);
		}
	} catch (err) {
		console.error("Decryption failed:", err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

function printUsage() {
	console.log(`boundcurl — Authenticated encrypted sync endpoint diagnostic tool

Usage:
  boundcurl METHOD URL [options]           Send encrypted request
  boundcurl --decrypt --peer ID [options]  Decrypt captured traffic

Request mode:
  boundcurl POST http://hub:3000/sync/pull --data '{"since_seq":0}'
  boundcurl POST http://hub:3000/sync/push --data '...' --peer abc123

Decrypt mode:
  cat captured.bin | boundcurl --decrypt --peer abc123
  cat captured.bin | boundcurl --decrypt --peer abc123 --nonce deadbeef...

Options:
  --data, -d BODY     Request body (JSON string)
  --peer SITE_ID      Target peer site ID (auto-resolved from URL if omitted)
  --decrypt           Decrypt mode: read ciphertext from stdin
  --nonce HEX         Explicit nonce (48 hex chars). Without this, first 24 bytes of stdin are nonce.
  --config-dir DIR    Config directory (default: "config")
  --data-dir DIR      Data directory (default: "data")
  --help, -h          Show this help`);
}

main().catch((err) => {
	console.error("Fatal:", err instanceof Error ? err.message : err);
	process.exit(1);
});
```

**Key design decisions:**
- Follows the exact same lightweight startup as `boundctl.ts`: no AppContext, no DI container, just keypair + keyring.
- Request mode auto-resolves peer siteId from URL when possible (matches against keyring host URLs).
- Decrypt mode supports both explicit `--nonce` (AC13.2) and nonce-prefixed input (AC13.3).
- Pretty-prints JSON output when possible, falls back to raw text.
- Exit code reflects request status (0 for success, 1 for errors).

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No type errors.

**Commit:** `feat(cli): add boundcurl diagnostic tool`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add boundcurl to build.ts and package.json

**Verifies:** sync-encryption.AC13.4

**Files:**
- Modify: `scripts/build.ts` (add 4th bun build --compile step)
- Modify: `packages/cli/package.json` (add bin entry)

**Implementation:**

In `scripts/build.ts`, add a 4th build step after the existing 3:

```typescript
// Add after the bound-mcp build step:
try {
	console.log("Building boundcurl...");
	await Bun.build({
		entrypoints: ["packages/cli/src/boundcurl.ts"],
		outdir: "dist",
		compile: true,
		target: "bun",
	});
	// Or if using shell command pattern:
	// execSync("bun build --compile packages/cli/src/boundcurl.ts --outfile dist/boundcurl");
} catch (err) {
	console.error("Failed to compile boundcurl:", err);
}
```

Follow the exact pattern used for the other 3 binaries in the build script. Also add `"dist/boundcurl"` to the build summary array (at `build.ts:55` which lists the binaries for size reporting).

In `packages/cli/package.json`, add bin entry:

```json
"bin": {
	"bound": "src/bound.ts",
	"boundctl": "src/boundctl.ts",
	"boundcurl": "src/boundcurl.ts"
}
```

**Verification:**

Run: `bun run build`
Expected: Build succeeds, `dist/boundcurl` binary is created alongside `dist/bound`, `dist/boundctl`, `dist/bound-mcp`.

Run: `ls -la .worktrees/sync-encryption/dist/boundcurl`
Expected: File exists and is executable.

**Commit:** `chore(build): add boundcurl as 4th compiled binary`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for boundcurl

**Verifies:** sync-encryption.AC13.1, sync-encryption.AC13.2, sync-encryption.AC13.3

**Files:**
- Create: `packages/cli/src/__tests__/boundcurl.test.ts`

**Testing:**

Test boundcurl's core functions by importing and calling them directly (not by spawning the process). Extract the request and decrypt logic into testable functions.

Tests must verify each AC:

- **sync-encryption.AC13.1 (request mode):** Set up a local encrypted Hono server. Call the request mode function with a URL, method, and body. Verify it returns decrypted JSON matching the server's response.
- **sync-encryption.AC13.2 (decrypt with explicit nonce):** Encrypt a known plaintext with a known key and nonce. Call the decrypt function with `--nonce` providing the hex nonce and the ciphertext on stdin. Verify output matches original plaintext.
- **sync-encryption.AC13.3 (decrypt with nonce-prefixed input):** Concatenate nonce (24 bytes) + ciphertext. Call the decrypt function without `--nonce`. Verify it extracts the nonce from the first 24 bytes and decrypts correctly.

Additional tests:
- **Missing peer:** Call request mode without `--peer` and with a URL that doesn't match any keyring entry. Verify it exits with error.
- **Input too short for decrypt:** Pass fewer than 24 bytes without `--nonce`. Verify error message.
- **Decryption failure:** Pass ciphertext encrypted with wrong key. Verify "Decryption failed" error.

**Verification:**

Run: `bun test packages/cli/src/__tests__/boundcurl.test.ts`
Expected: All tests pass.

**Commit:** `test(cli): add boundcurl unit tests`
<!-- END_TASK_3 -->
