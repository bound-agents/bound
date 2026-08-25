/**
 * One-shot bust of the AWS shared-config (`~/.aws/config` + `~/.aws/credentials`)
 * cache.
 *
 * `@smithy/shared-ini-file-loader`'s `readFile` memoizes each parsed ini file in
 * a module-level `filePromises` map for the lifetime of the process: once a
 * profile is read, edits to the file on disk are invisible until restart. That
 * bit us when a profile was added to `~/.aws/config` and a running bound picked
 * up the model-backend change on SIGHUP but kept resolving credentials against
 * the stale, pre-edit profile set.
 *
 * The loader does expose a lever: passing `ignoreCache: true` to `fromIni` /
 * `fromNodeProviderChain` threads down to `readFile`, where the branch is
 *
 *     if (!filePromises[path] || options?.ignoreCache) {
 *         filePromises[path] = fsReadFile(path, "utf8");
 *     }
 *
 * — note it re-ASSIGNS `filePromises[path]` with the fresh read, so a single
 * `ignoreCache: true` resolution does not merely bypass the cache for that one
 * call: it re-seeds it. Every subsequent cached resolution then sees the new
 * file. That makes a true one-shot bust possible — re-read exactly once after a
 * config reload, then fall back to the cache — instead of paying a disk read on
 * every credential resolution.
 *
 * The flag is process-global because the smithy cache is process-global: there
 * is one `filePromises` map shared across every driver instance, so one bust
 * re-seeds it for all of them.
 */

import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";

let bustPending = false;

/**
 * Mark the AWS shared-config cache stale. The next credential resolution (and
 * only the next) will re-read the ini files from disk, re-seeding the smithy
 * cache. Idempotent: multiple marks before a resolution collapse to one re-read.
 * Wired to config reload (SIGHUP) in the CLI start command.
 */
export function markAwsCredentialCacheStale(): void {
	bustPending = true;
}

/**
 * Consume the pending bust. Returns `true` exactly once per `markAwsCredentialCacheStale()`,
 * resetting the flag so the read after the re-seed goes back to the cache.
 * Exported for tests; production callers go through `resolveAwsCredentials`.
 */
export function consumeAwsCredentialCacheBust(): boolean {
	if (bustPending) {
		bustPending = false;
		return true;
	}
	return false;
}

/** Provider factories, injectable so tests can assert the `ignoreCache` hand-off without touching disk. */
export interface AwsCredentialProviderFactories {
	fromIni: typeof fromIni;
	fromNodeProviderChain: typeof fromNodeProviderChain;
}

const defaultFactories: AwsCredentialProviderFactories = {
	fromIni,
	fromNodeProviderChain,
};

/**
 * Resolve AWS credentials for an optional profile, honoring a pending one-shot
 * cache bust. With a `profile` set, uses `fromIni` (SSO / sts:AssumeRole / MFA);
 * without one, falls back to the node provider chain (env / SSO cache / instance
 * roles). When a bust is pending, passes `ignoreCache: true` so the ini files are
 * re-read and the smithy cache re-seeded; otherwise resolves against the cache.
 *
 * Returns the bare credential triple the AI SDK / SigV4 fetch expects.
 */
export async function resolveAwsCredentials(
	profile: string | undefined,
	factories: AwsCredentialProviderFactories = defaultFactories,
): Promise<{
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string | undefined;
}> {
	const ignoreCache = consumeAwsCredentialCacheBust();
	const provider = profile
		? factories.fromIni({ profile, ignoreCache })
		: factories.fromNodeProviderChain({ ignoreCache });
	const creds = await provider();
	return {
		accessKeyId: creds.accessKeyId,
		secretAccessKey: creds.secretAccessKey,
		sessionToken: creds.sessionToken,
	};
}
