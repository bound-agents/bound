import { describe, expect, it } from "bun:test";
import type { KeyringConfig } from "@bound/shared";
import { CryptoHasher } from "bun";
import { deriveSiteId, exportPublicKey, generateKeypair } from "../crypto";
import { verifyRequest } from "../signing";

/**
 * Regression guard for the freshness-gate fail-open on unparseable X-Timestamp.
 *
 * verifyRequest computes `timeDiff = Math.abs(localTime - new Date(ts).getTime())`
 * and rejects when `timeDiff > TOLERANCE`. For an unparseable timestamp,
 * getTime() is NaN, timeDiff is NaN, and `NaN > TOLERANCE` is false — which
 * would skip the staleness check (fail-open). A Number.isFinite guard in
 * verifyRequest makes the gate fail closed instead.
 *
 * NOTE: this was defense-in-depth, NOT an independently exploitable bypass —
 * the timestamp is part of the Ed25519 signing base, so a malformed timestamp
 * still requires a valid signature over it from a keyring-known private key.
 */
describe("verifyRequest — freshness gate on malformed timestamp", () => {
	async function signWith(ts: string) {
		const { publicKey, privateKey } = await generateKeypair();
		const siteId = await deriveSiteId(publicKey);
		const publicKeyEncoded = await exportPublicKey(publicKey);
		const keyring: KeyringConfig = {
			hosts: { [siteId]: { public_key: publicKeyEncoded, url: "http://localhost:3100" } },
		};
		const body = "";
		const hasher = new CryptoHasher("sha256");
		hasher.update(body);
		const bodyHashHex = Buffer.from(hasher.digest()).toString("hex");
		const signingBase = `GET\n/sync/ws\n${ts}\n${bodyHashHex}`;
		const sigBytes = await crypto.subtle.sign(
			"Ed25519",
			privateKey,
			new TextEncoder().encode(signingBase),
		);
		const headers = {
			"X-Site-Id": siteId,
			"X-Timestamp": ts,
			"X-Signature": Buffer.from(sigBytes).toString("hex"),
		};
		return { keyring, headers, body };
	}

	it("REJECTS a real but stale timestamp (baseline — gate works)", async () => {
		const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
		const { keyring, headers, body } = await signWith(stale);
		const result = await verifyRequest(keyring, "GET", "/sync/ws", headers, body);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("stale_timestamp");
	});

	it("REJECTS an unparseable timestamp instead of failing open", async () => {
		const { keyring, headers, body } = await signWith("not-a-date");
		const result = await verifyRequest(keyring, "GET", "/sync/ws", headers, body);
		// `new Date("not-a-date").getTime()` is NaN. Without the Number.isFinite
		// guard in verifyRequest, `NaN > TOLERANCE` is false and the staleness
		// branch is skipped (fail-open). The guard makes the gate fail closed.
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("stale_timestamp");
	});
});
