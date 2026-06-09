/**
 * One-shot AWS shared-config cache bust. The load-bearing behavior: a single
 * `markAwsCredentialCacheStale()` causes exactly the NEXT credential resolution
 * to pass `ignoreCache: true` (which re-seeds the smithy ini cache), and every
 * resolution after that goes back to the cache until the next mark.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
	type AwsCredentialProviderFactories,
	consumeAwsCredentialCacheBust,
	markAwsCredentialCacheStale,
	resolveAwsCredentials,
} from "../aws-credential-cache";

// Drain any pending bust left by a prior test so the flag starts clean.
beforeEach(() => {
	consumeAwsCredentialCacheBust();
});

describe("consumeAwsCredentialCacheBust — one-shot semantics", () => {
	it("returns false when no bust is pending", () => {
		expect(consumeAwsCredentialCacheBust()).toBe(false);
	});

	it("returns true exactly once after a mark, then false", () => {
		markAwsCredentialCacheStale();
		expect(consumeAwsCredentialCacheBust()).toBe(true);
		expect(consumeAwsCredentialCacheBust()).toBe(false);
		expect(consumeAwsCredentialCacheBust()).toBe(false);
	});

	it("collapses multiple marks before a consume into a single bust", () => {
		markAwsCredentialCacheStale();
		markAwsCredentialCacheStale();
		markAwsCredentialCacheStale();
		expect(consumeAwsCredentialCacheBust()).toBe(true);
		expect(consumeAwsCredentialCacheBust()).toBe(false);
	});
});

// Build injectable factories that record the `ignoreCache` each call saw and
// return static creds, so we can assert the hand-off without touching disk.
function recordingFactories(): {
	factories: AwsCredentialProviderFactories;
	iniCalls: Array<boolean | undefined>;
	chainCalls: Array<boolean | undefined>;
} {
	const iniCalls: Array<boolean | undefined> = [];
	const chainCalls: Array<boolean | undefined> = [];
	const creds = {
		accessKeyId: "AKIA",
		secretAccessKey: "secret",
		sessionToken: "token",
	};
	const factories = {
		fromIni: ((init?: { ignoreCache?: boolean }) => {
			iniCalls.push(init?.ignoreCache);
			return async () => creds;
		}) as unknown as AwsCredentialProviderFactories["fromIni"],
		fromNodeProviderChain: ((init?: { ignoreCache?: boolean }) => {
			chainCalls.push(init?.ignoreCache);
			return async () => creds;
		}) as unknown as AwsCredentialProviderFactories["fromNodeProviderChain"],
	};
	return { factories, iniCalls, chainCalls };
}

describe("resolveAwsCredentials — bust hand-off", () => {
	it("passes ignoreCache:true to fromIni only on the resolution after a mark", async () => {
		const { factories, iniCalls } = recordingFactories();

		// No bust pending: cached read.
		await resolveAwsCredentials("test-profile", factories);
		expect(iniCalls).toEqual([false]);

		// Mark stale → next resolution re-reads, the one after is cached again.
		markAwsCredentialCacheStale();
		await resolveAwsCredentials("test-profile", factories);
		await resolveAwsCredentials("test-profile", factories);
		expect(iniCalls).toEqual([false, true, false]);
	});

	it("routes profile-less resolution through the node chain and honors the bust there too", async () => {
		const { factories, iniCalls, chainCalls } = recordingFactories();

		markAwsCredentialCacheStale();
		await resolveAwsCredentials(undefined, factories);
		await resolveAwsCredentials(undefined, factories);

		expect(iniCalls).toEqual([]);
		expect(chainCalls).toEqual([true, false]);
	});

	it("returns the bare credential triple the AI SDK / SigV4 fetch expects", async () => {
		const { factories } = recordingFactories();
		const out = await resolveAwsCredentials("test-profile", factories);
		expect(out).toEqual({
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
			sessionToken: "token",
		});
	});
});
