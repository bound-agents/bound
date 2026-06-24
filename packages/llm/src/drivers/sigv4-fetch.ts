/**
 * SigV4-signing `fetch` wrapper.
 *
 * Built for the `bedrock-mantle` Responses API (issue #155), where the
 * OpenAI GPT-5.x models are served on an OpenAI-compatible surface that
 * still authenticates with AWS SigV4 — not a bearer token. The native
 * `@ai-sdk/openai` provider accepts a custom `fetch`, so we plug a fetch
 * that signs each outgoing request with the ambient AWS credentials. No
 * bearer token is ever materialized; nothing expires or needs refresh
 * beyond what the credential provider itself manages.
 *
 * Why per-request signing: SigV4 binds the signature to a timestamp
 * (`x-amz-date`) and the exact request bytes, so every request must be
 * signed fresh. We also re-invoke the credential provider per request so a
 * provider backed by short-term/SSO credentials (the constraint on hosts
 * that disallow long-lived tokens) gets its rotation honored — the
 * provider is expected to cache internally and only hit the network when
 * its own cache is cold.
 *
 * The signer is `aws4fetch`'s `AwsClient`, which produces a signed
 * `Request` we then hand to the underlying fetch. `aws4fetch` can infer
 * service+region from a standard `service.region.amazonaws.com` host, but
 * the mantle endpoint (`bedrock-mantle.{region}.api.aws`) is non-standard,
 * so `service` and `region` are always passed explicitly.
 */

import { AwsClient } from "aws4fetch";

export interface SigV4Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface SigV4FetchConfig {
	/**
	 * Resolves the AWS credentials to sign with. Invoked once per request so
	 * a refreshing/SSO-backed provider's rotation is honored. Implementations
	 * should cache internally (the AWS SDK credential providers do).
	 */
	credentials: () => Promise<SigV4Credentials>;
	/** SigV4 service name (the scope's service component). */
	service: string;
	/** AWS region (the scope's region component). */
	region: string;
	/**
	 * Underlying fetch to delegate the signed request to. Defaults to the
	 * global `fetch`. Overridable as a test seam and to compose with other
	 * fetch wrappers (logging, timeout).
	 */
	baseFetch?: typeof fetch;
}

/**
 * Returns a `fetch`-shaped function that SigV4-signs every request with the
 * configured credentials, service, and region before delegating to
 * `baseFetch`. Shape-compatible with `@ai-sdk/openai`'s `fetch` option.
 */
export function createSigV4Fetch(config: SigV4FetchConfig): typeof fetch {
	const base = config.baseFetch ?? fetch;
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const creds = await config.credentials();
		const client = new AwsClient({
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
			sessionToken: creds.sessionToken,
			service: config.service,
			region: config.region,
		});
		// Normalize to a Request so the signer sees method, headers, and body
		// as one unit; aws4fetch reads the body to compute the payload hash.
		const request = new Request(input as RequestInfo | URL, init);
		const signed = await client.sign(request);
		return base(signed);
	}) as typeof fetch;
}
