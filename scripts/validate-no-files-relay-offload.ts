#!/usr/bin/env bun
/**
 * Validates AC.8 / R-UD14: NO relay payload path writes to the synced `files`
 * table.
 *
 * The unified-delegation design (docs/design/specs/2026-06-29-unified-delegation.md)
 * deleted the >2MB inference offload that wrote the assembled context to the
 * `files` table and read it back from the consumer's replica — a race against
 * sync convergence. Delegated context now travels as `ContextSegment[]` (one
 * range-pointer is kilobytes regardless of token count), so the relay path must
 * never touch `files` again. This gate makes the removal a CI-enforced invariant
 * rather than a one-time deletion: if anyone re-introduces a `files` write on a
 * relay-payload code path, the build fails here.
 *
 * Scope: the files that build, ship, resolve, or wait on relay payloads. A
 * `files`-table write anywhere in this set is, by construction, a relay-payload
 * write. (Legitimate `files` writes — the agent's `file` tool, tool-result image
 * offload, the VFS — live OUTSIDE this set and are unaffected.)
 *
 * Run: bun run scripts/validate-no-files-relay-offload.ts
 * Wired into: bun check (pre-commit hook), alongside validate-outbox-invariant.ts
 *
 * LIMITATION: this is a shallow, fixed-file-set scanner (matching the sibling
 * outbox gate's style), not a taint analysis. It only inspects the relay-path
 * files listed below and only catches literal `files`-table writes ON those
 * lines. A `files` write routed through a helper in an UNLISTED module would
 * evade it, and a listed file that no longer exists is silently skipped. When
 * relay code moves or grows, extend RELAY_PAYLOAD_FILES to keep the gate honest.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The relay-payload code paths. A write to `files` in any of these is a relay
// offload by definition.
const RELAY_PAYLOAD_FILES = [
	"packages/agent/src/relay-processor.ts",
	"packages/agent/src/relay-stream$.ts",
	"packages/agent/src/relay-backend.ts",
	"packages/agent/src/relay-wait$.ts",
	"packages/agent/src/delegation-segments.ts",
	// The agent loop's remote-inference branch builds the relay payload here.
	"packages/agent/src/bound-agent-loop.ts",
];

// A write that targets the `files` table: raw SQL mutation, or an
// insertRow/updateRow/softDelete with "files" as the table argument.
const FILES_RAW_SQL = /["'`]\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+files\b/i;
const FILES_REPO_WRITE = /\b(?:insertRow|updateRow|softDelete)\s*\(\s*[^,]+,\s*["'`]files["'`]/;

interface Violation {
	file: string;
	line: number;
	text: string;
}

export function findFilesWriteInLine(line: string): boolean {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
		return false;
	}
	return FILES_RAW_SQL.test(line) || FILES_REPO_WRITE.test(line);
}

export async function main() {
	const root = resolve(import.meta.dir, "..");
	const violations: Violation[] = [];

	for (const relPath of RELAY_PAYLOAD_FILES) {
		const fullPath = resolve(root, relPath);
		let content: string;
		try {
			content = readFileSync(fullPath, "utf-8");
		} catch {
			// A listed file that no longer exists is not a violation — the set is
			// intentionally broad and tolerant of refactors.
			continue;
		}
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (findFilesWriteInLine(lines[i])) {
				violations.push({ file: relPath, line: i + 1, text: lines[i].trim().slice(0, 100) });
			}
		}
	}

	if (violations.length === 0) {
		console.log("no-files-relay-offload: no relay payload path writes to the files table");
		process.exit(0);
	}

	console.error(
		`no-files-relay-offload violated: ${violations.length} relay-path write(s) to the files table\n`,
	);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}`);
		console.error(`    ${v.text}`);
	}
	console.error(
		"\nThe >2MB inference offload was deleted (R-UD14). Delegated context travels as " +
			"ContextSegment[] (a range-pointer is kilobytes regardless of token count). Do not " +
			"re-introduce a files-table offload on a relay payload path.",
	);
	process.exit(1);
}

if (import.meta.main) {
	main();
}
