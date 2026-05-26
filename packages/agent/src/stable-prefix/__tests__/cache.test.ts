/**
 * `StableSubsectionCache` invariant tests — the load-bearing
 * within-window byte stability contract.
 *
 * Background. R-VC25 mandates byte stability of the stable volatile
 * subsection across cold rebuilds within the cache TTL window. The
 * collector reads `last_accessed_at` from `semantic_memory` to sort
 * Discoverable Archive detail entries; that column is bumped via
 * direct SQL by `bumpRenderedDetailEntries` and other relevance-hint
 * paths (CONTRIBUTING.md narrow exception #1). When a bump shifts the
 * sort order between two cold paths, the rendered output mutates in
 * place — same length, different bytes — and Bedrock's prefix-match
 * cachePoint invalidates.
 *
 * Live evidence (thread `a0efd4a2-…` 18:01:39 → 18:01:59):
 *   - system block sha256 prefix: `eb0117b763bb` → `b55dff2241a9`
 *   - text length identical (279,865 chars)
 *   - cache_read collapsed 247,071 → 5,450 (mass invalidation)
 *   - cache_write rebuilt at 248,278
 *
 * The R-VC25 drift detector classified the same event as
 * `flavor:collect` — input fingerprint shifted without a covering
 * change_log row. The `StableSubsectionCache` is the architectural
 * fix: memoize the rendered output per-thread per-TTL-window so
 * collect-side mutations don't break wire-byte stability within the
 * Bedrock cache window.
 *
 * Invariants pinned here (declared verbatim in `cache.ts`):
 *
 *   K1 (load-bearing) — within the TTL window for a given thread,
 *      repeated `get` calls return byte-identical output even when
 *      the underlying DB state has mutated between calls.
 *
 *   K2 — cross-thread isolation. A bump in thread A's data does not
 *      pollute thread B's cached output.
 *
 *   K3 — TTL expiry. After `ttlMs` elapses, the next call re-collects
 *      and re-renders fresh data.
 *
 *   K4 — cold-start fidelity. On cache miss, output equals what
 *      `composeStableVolatileSubsection(collectStableVolatileInputs(db))`
 *      would have returned. The cache memoizes; it does not transform.
 *
 *   K7 — bypassable. `invalidate(threadId)` forces the next `get` to
 *      re-collect.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { STABLE_SUBSECTION_TTL_MS, StableSubsectionCache } from "../cache";
import { collectStableVolatileInputs } from "../collect";
import { composeStableVolatileSubsection } from "../compose";

let tmpDir: string;
let db: Database;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "stable-cache-test-"));
	const dbPath = join(tmpDir, "test.db");
	db = createDatabase(dbPath);
	applySchema(db);
});

afterAll(async () => {
	db.close();
	await cleanupTmpDir(tmpDir);
});

function insertDetailEntry(key: string, lastAccessedAt: string): void {
	const now = "2026-05-25T12:00:00Z";
	db.run(
		"INSERT INTO semantic_memory (id, key, value, tier, source, created_at, modified_at, last_accessed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[randomUUID(), key, `value-of-${key}`, "detail", "test", now, now, lastAccessedAt, 0],
	);
}

function bump(key: string, newAccessTime: string): void {
	db.run("UPDATE semantic_memory SET last_accessed_at = ? WHERE key = ?", [newAccessTime, key]);
}

function clearMemory(): void {
	db.run("DELETE FROM semantic_memory");
}

const T_NOW = 1779768000000; // fixed wall clock for test determinism

describe("StableSubsectionCache — invariant tests", () => {
	it("K1 (load-bearing): within TTL, last_accessed_at bumps do not mutate cached bytes", () => {
		clearMemory();
		// Insert detail entries that will land in the Discoverable Archive.
		// last_accessed_at orders them DESC; the bump test mutates that order.
		insertDetailEntry("entry-a", "2026-05-25T10:00:00Z");
		insertDetailEntry("entry-b", "2026-05-25T11:00:00Z");
		insertDetailEntry("entry-c", "2026-05-25T11:30:00Z");

		const cache = new StableSubsectionCache();
		const threadId = randomUUID();

		// First call: cold, collects + renders.
		const lines1 = cache.get({
			db,
			threadId,
			budgetPressure: false,
			nowMs: T_NOW,
		});
		const bytes1 = lines1.join("\n");

		// Bump entry-a to be the MOST recent. Without memoization, this
		// reorders the Discoverable Archive on the next render — that's
		// the bug we're fixing.
		bump("entry-a", "2026-05-25T13:00:00Z");

		// Second call: should hit cache, return identical bytes.
		const lines2 = cache.get({
			db,
			threadId,
			budgetPressure: false,
			nowMs: T_NOW + 1000, // 1s later, well within TTL
		});
		const bytes2 = lines2.join("\n");

		expect(bytes2).toBe(bytes1);
	});

	it("K2: cross-thread isolation — bump in thread A doesn't affect thread B's cached output", () => {
		clearMemory();
		insertDetailEntry("a-entry", "2026-05-25T10:00:00Z");
		insertDetailEntry("b-entry", "2026-05-25T11:00:00Z");

		const cache = new StableSubsectionCache();
		const threadA = randomUUID();
		const threadB = randomUUID();

		const aBytes1 = cache
			.get({ db, threadId: threadA, budgetPressure: false, nowMs: T_NOW })
			.join("\n");
		const bBytes1 = cache
			.get({ db, threadId: threadB, budgetPressure: false, nowMs: T_NOW })
			.join("\n");

		// Both threads should see the same content initially (same DB).
		expect(aBytes1).toBe(bBytes1);

		// Mutate. Both threads' cached bytes must remain stable.
		bump("a-entry", "2026-05-25T13:00:00Z");

		const aBytes2 = cache
			.get({ db, threadId: threadA, budgetPressure: false, nowMs: T_NOW + 1000 })
			.join("\n");
		const bBytes2 = cache
			.get({ db, threadId: threadB, budgetPressure: false, nowMs: T_NOW + 1000 })
			.join("\n");

		expect(aBytes2).toBe(aBytes1);
		expect(bBytes2).toBe(bBytes1);
	});

	it("K3: TTL expiry — after ttlMs elapses, re-collects fresh", () => {
		clearMemory();
		insertDetailEntry("ttl-a", "2026-05-25T10:00:00Z");
		insertDetailEntry("ttl-b", "2026-05-25T11:00:00Z");

		const cache = new StableSubsectionCache();
		const threadId = randomUUID();
		const customTtl = 60_000; // 1 minute for test speed

		const lines1 = cache.get({
			db,
			threadId,
			budgetPressure: false,
			nowMs: T_NOW,
			ttlMs: customTtl,
		});

		// Bump after TTL elapsed — re-collect should pick up the change.
		bump("ttl-a", "2026-05-25T13:00:00Z");

		const lines2 = cache.get({
			db,
			threadId,
			budgetPressure: false,
			nowMs: T_NOW + customTtl + 1, // strictly past TTL
			ttlMs: customTtl,
		});

		expect(lines2.join("\n")).not.toBe(lines1.join("\n"));
	});

	it("K4: cold-start fidelity — first call equals direct collect+compose output", () => {
		clearMemory();
		insertDetailEntry("fid-a", "2026-05-25T10:00:00Z");
		insertDetailEntry("fid-b", "2026-05-25T11:00:00Z");

		const cache = new StableSubsectionCache();
		const direct = composeStableVolatileSubsection(collectStableVolatileInputs(db, false)).join(
			"\n",
		);
		const viaCache = cache
			.get({ db, threadId: randomUUID(), budgetPressure: false, nowMs: T_NOW })
			.join("\n");

		expect(viaCache).toBe(direct);
	});

	it("K7: invalidate forces re-collect on next get", () => {
		clearMemory();
		insertDetailEntry("inv-a", "2026-05-25T10:00:00Z");
		insertDetailEntry("inv-b", "2026-05-25T11:00:00Z");

		const cache = new StableSubsectionCache();
		const threadId = randomUUID();

		const lines1 = cache.get({ db, threadId, budgetPressure: false, nowMs: T_NOW }).join("\n");
		bump("inv-a", "2026-05-25T13:00:00Z");
		cache.invalidate(threadId);
		const lines2 = cache
			.get({ db, threadId, budgetPressure: false, nowMs: T_NOW + 1000 })
			.join("\n");

		expect(lines2).not.toBe(lines1);
	});

	it("STABLE_SUBSECTION_TTL_MS is 1h to align with Bedrock cache TTL", () => {
		expect(STABLE_SUBSECTION_TTL_MS).toBe(60 * 60 * 1000);
	});
});
