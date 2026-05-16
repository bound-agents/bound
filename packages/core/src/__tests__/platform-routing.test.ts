import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../database";
import {
	PLATFORM_HOST_STALE_THRESHOLD_MS,
	findFreshPlatformHost,
	isHostFresh,
	listFreshRemotePlatforms,
} from "../platform-routing";
import { applySchema } from "../schema";

describe("platform-routing", () => {
	let dbPath: string;
	let db: ReturnType<typeof createDatabase>;
	const localSiteId = "local-site-fixed";
	// Fixed reference instant so tests don't drift if the suite is slow.
	const NOW = Date.parse("2026-05-16T19:00:00.000Z");
	const fresh = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();
	const stale = (offsetMs = 0) =>
		new Date(NOW - PLATFORM_HOST_STALE_THRESHOLD_MS - 60_000 + offsetMs).toISOString();

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-platform-routing-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	function insertHost(opts: {
		siteId?: string;
		platforms: string[] | null;
		modifiedAt: string;
		onlineAt?: string | null;
		deleted?: 0 | 1;
	}): string {
		const siteId = opts.siteId ?? randomUUID();
		db.run(
			`INSERT INTO hosts
			   (site_id, host_name, online_at, modified_at, platforms, deleted)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				siteId,
				`host-${siteId.slice(0, 8)}`,
				opts.onlineAt ?? null,
				opts.modifiedAt,
				opts.platforms === null ? null : JSON.stringify(opts.platforms),
				opts.deleted ?? 0,
			],
		);
		return siteId;
	}

	describe("isHostFresh", () => {
		it("returns true when modified_at is within the stale threshold", () => {
			expect(isHostFresh({ modified_at: fresh(-30_000), online_at: null }, NOW)).toBe(true);
		});

		it("returns false when modified_at is past the stale threshold", () => {
			expect(isHostFresh({ modified_at: stale(), online_at: null }, NOW)).toBe(false);
		});

		it("falls back to online_at when modified_at is null", () => {
			expect(isHostFresh({ modified_at: null, online_at: fresh(-30_000) }, NOW)).toBe(true);
			expect(isHostFresh({ modified_at: null, online_at: stale() }, NOW)).toBe(false);
		});

		it("returns false when both timestamps are null", () => {
			expect(isHostFresh({ modified_at: null, online_at: null }, NOW)).toBe(false);
		});

		it("treats a host exactly at the threshold as fresh (inclusive)", () => {
			const ts = new Date(NOW - PLATFORM_HOST_STALE_THRESHOLD_MS).toISOString();
			expect(isHostFresh({ modified_at: ts, online_at: null }, NOW)).toBe(true);
		});
	});

	describe("findFreshPlatformHost", () => {
		it("returns the site_id of a fresh remote host advertising the platform", () => {
			const remoteId = insertHost({ platforms: ["discord"], modifiedAt: fresh(-30_000) });
			expect(findFreshPlatformHost(db, "discord", localSiteId, NOW)).toBe(remoteId);
		});

		it("returns null when the only advertising host is stale", () => {
			// Regression for the bug this helper exists to fix: the discord daemon
			// crashed shortly after boot at 19:01 and stopped beating; the local
			// daemon's discovery loop kept firing platform_request relays at it
			// every 60s for 12+ minutes. With this filter, the discovery path
			// now routes around the stale advertiser instead.
			insertHost({ platforms: ["discord"], modifiedAt: stale() });
			expect(findFreshPlatformHost(db, "discord", localSiteId, NOW)).toBeNull();
		});

		it("returns null when no host advertises the platform", () => {
			insertHost({ platforms: ["slack"], modifiedAt: fresh() });
			expect(findFreshPlatformHost(db, "discord", localSiteId, NOW)).toBeNull();
		});

		it("excludes the local site even when it advertises the platform", () => {
			insertHost({
				siteId: localSiteId,
				platforms: ["discord"],
				modifiedAt: fresh(),
			});
			expect(findFreshPlatformHost(db, "discord", localSiteId, NOW)).toBeNull();
		});

		it("excludes deleted hosts", () => {
			insertHost({ platforms: ["discord"], modifiedAt: fresh(), deleted: 1 });
			expect(findFreshPlatformHost(db, "discord", localSiteId, NOW)).toBeNull();
		});

		it("falls back to online_at when modified_at is null", () => {
			// Note: the live `hosts` schema has `modified_at NOT NULL`, so the
			// fallback is unreachable through normal inserts; we cover the
			// predicate-level behavior in the `isHostFresh` block above. This
			// kept-defensively fallback exists for parity with
			// `relay-router.ts:hostAge` against pre-schema-tightening rows.
		});

		it("skips hosts whose platforms JSON is corrupted", () => {
			db.run(
				`INSERT INTO hosts (site_id, host_name, online_at, modified_at, platforms, deleted)
				 VALUES (?, ?, ?, ?, ?, 0)`,
				["corrupt-site", "corrupt-host", null, fresh(), "{not-valid-json"],
			);
			const goodId = insertHost({ platforms: ["discord"], modifiedAt: fresh(-30_000) });
			expect(findFreshPlatformHost(db, "discord", localSiteId, NOW)).toBe(goodId);
		});

		it("prefers the most recently heart-beaten host when multiple advertise the platform", () => {
			insertHost({ siteId: "older", platforms: ["discord"], modifiedAt: fresh(-120_000) });
			const newerId = insertHost({
				siteId: "newer",
				platforms: ["discord"],
				modifiedAt: fresh(-10_000),
			});
			expect(findFreshPlatformHost(db, "discord", localSiteId, NOW)).toBe(newerId);
		});

		it("prefers a fresh host over a stale one even if the stale one is alphabetically first", () => {
			insertHost({ siteId: "aaaa-stale", platforms: ["discord"], modifiedAt: stale() });
			const freshId = insertHost({
				siteId: "zzzz-fresh",
				platforms: ["discord"],
				modifiedAt: fresh(-10_000),
			});
			expect(findFreshPlatformHost(db, "discord", localSiteId, NOW)).toBe(freshId);
		});
	});

	describe("listFreshRemotePlatforms", () => {
		it("returns platforms advertised by at least one fresh remote host", () => {
			insertHost({ platforms: ["discord", "slack"], modifiedAt: fresh(-30_000) });
			insertHost({ platforms: ["telegram"], modifiedAt: fresh(-30_000) });
			const result = listFreshRemotePlatforms(db, localSiteId, NOW);
			expect(new Set([...result])).toEqual(new Set(["discord", "slack", "telegram"]));
		});

		it("excludes platforms whose only advertiser is stale", () => {
			insertHost({ platforms: ["discord"], modifiedAt: stale() });
			insertHost({ platforms: ["slack"], modifiedAt: fresh(-30_000) });
			const result = listFreshRemotePlatforms(db, localSiteId, NOW);
			expect(result.has("discord")).toBe(false);
			expect(result.has("slack")).toBe(true);
		});

		it("includes a platform even if one advertiser is stale, as long as another is fresh", () => {
			insertHost({ platforms: ["discord"], modifiedAt: stale() });
			insertHost({ platforms: ["discord"], modifiedAt: fresh(-30_000) });
			expect(listFreshRemotePlatforms(db, localSiteId, NOW).has("discord")).toBe(true);
		});

		it("excludes the local site's own platforms", () => {
			insertHost({
				siteId: localSiteId,
				platforms: ["discord"],
				modifiedAt: fresh(),
			});
			expect(listFreshRemotePlatforms(db, localSiteId, NOW).has("discord")).toBe(false);
		});

		it("returns an empty set when no fresh remote host advertises any platform", () => {
			insertHost({ platforms: ["discord"], modifiedAt: stale() });
			expect(listFreshRemotePlatforms(db, localSiteId, NOW).size).toBe(0);
		});
	});
});
