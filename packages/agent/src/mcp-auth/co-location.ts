import { type Result, err, ok } from "@bound/shared";
import {
	type AuthorizationServerMetadata,
	type OAuthClientInformationMixed,
	assertSecureTokenEndpoint,
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	refreshAuthorization,
} from "@modelcontextprotocol/client";
import { extractOAuthErrorCode } from "./owner-exchange";
import { canonicalResource } from "./resolver";
import {
	type McpTokenBundle,
	type McpTokenStore,
	type RefreshError,
	type RefreshFn,
	bundleFromStoredTokens,
	classifyTokenEndpointError,
} from "./token-store";

/**
 * Co-location owner-side OAuth support for MCP Apps (R-MO27b LEG A + LEG B).
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §11, R-MO27b.
 *
 * The MCP-Apps proxy attaches an OAuth token at the OWNING host's fetch edge —
 * either directly (this host owns the server, LEG A) or after a peer relays the
 * request here (LEG B). Both paths need a live access token, which means a
 * refresh path. This module lives in `@bound/agent` (which depends on the MCP
 * SDK) so the CLI start wiring can build the refresh closure WITHOUT the CLI
 * package taking a direct dependency on `@modelcontextprotocol/client`.
 *
 * The refresh mirrors owner-exchange.ts: the owner independently discovers PRM →
 * AS metadata from its OWN config, validates the token endpoint belongs to the
 * issuer origin, then POSTs the RFC 6749 refresh with its own client
 * credentials. It never acts on a peer's word (there is no peer word here — the
 * refresh is entirely owner-local; only the browser's JSON-RPC body crossed the
 * relay, never a token).
 */

/** The owner's config for a server: url + client credentials it holds (R-MO4). */
export interface CoLocationServerConfig {
	name: string;
	url: string;
	scopes?: string[];
	clientId?: string;
	/** Confidential-client secret; owner-host config only, NEVER handed off (R-MO30). */
	clientSecret?: string;
}

/**
 * Build an RFC 6749 refresh closure for one server, keyed to the owner's own
 * config. `resolveConfig` reads the live owner config at refresh time (so a
 * SIGHUP config reload is honored). `fetchFn` is injectable for tests.
 */
export function buildOwnerRefreshFn(
	serverName: string,
	resolveConfig: (name: string) => CoLocationServerConfig | null,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
): RefreshFn {
	return async (bundle: McpTokenBundle): Promise<Result<McpTokenBundle, RefreshError>> => {
		const config = resolveConfig(serverName);
		if (!config) {
			return err({ kind: "transient", detail: `no owner config for ${serverName}` });
		}
		if (!bundle.refreshToken) {
			return err({ kind: "lost_grant", error: "invalid_grant" });
		}
		let ownerPrm: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | undefined;
		try {
			ownerPrm = await discoverOAuthProtectedResourceMetadata(config.url, undefined, fetchFn);
		} catch {
			ownerPrm = undefined;
		}
		const asSeed = ownerPrm?.authorization_servers?.[0] || config.url;
		let asMetadata: AuthorizationServerMetadata | undefined;
		try {
			asMetadata = await discoverAuthorizationServerMetadata(asSeed, { fetchFn });
		} catch (e) {
			return err({
				kind: "transient",
				detail: `AS metadata discovery failed: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
		if (!asMetadata?.token_endpoint) {
			return err({ kind: "transient", detail: "owner AS metadata carries no token_endpoint" });
		}
		try {
			assertSecureTokenEndpoint(asMetadata.token_endpoint);
		} catch (e) {
			return err({
				kind: "transient",
				detail: `insecure token endpoint: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
		const clientInformation: OAuthClientInformationMixed = config.clientId
			? config.clientSecret
				? { client_id: config.clientId, client_secret: config.clientSecret }
				: { client_id: config.clientId }
			: { client_id: "" };
		if (!clientInformation.client_id) {
			return err({ kind: "transient", detail: `no client_id configured for ${serverName}` });
		}
		const ownerResource = canonicalResource(config.url, ownerPrm);
		try {
			const tokens = await refreshAuthorization(asSeed, {
				metadata: asMetadata,
				clientInformation,
				refreshToken: bundle.refreshToken,
				resource: ownerResource ? new URL(ownerResource) : undefined,
				fetchFn,
			});
			const fallbackScopes =
				config.scopes && config.scopes.length > 0 ? config.scopes.join(" ") : bundle.scopes;
			return ok(
				bundleFromStoredTokens(
					{ ...tokens, issuer: asMetadata.issuer },
					Date.now(),
					fallbackScopes,
				),
			);
		} catch (e) {
			// Classify the token-endpoint failure by RFC 6749 §5.2 error code (R-MO12):
			// terminal → lost grant (raise a challenge), else transient (retry).
			const code = extractOAuthErrorCode(e);
			if (classifyTokenEndpointError(code) === "terminal") {
				return err({ kind: "lost_grant", error: code ?? "invalid_grant" });
			}
			return err({
				kind: "transient",
				detail: e instanceof Error ? e.message : String(e),
			});
		}
	};
}

/** The disposition of a co-location access-token lookup. */
export type CoLocationTokenResult =
	| { ok: true; value: string }
	| { ok: false; error: { kind: "no_bundle" | "lost_grant" | "transient" | "not_oauth" | string } };

/**
 * Return a live access token for a locally-owned oauth server (R-MO27b LEG A).
 * `not_oauth` when the server is not oauth-configured (the caller then keeps its
 * static-header / no-auth path). Otherwise runs the store's refresh path.
 */
export async function getCoLocationAccessToken(
	store: McpTokenStore,
	serverName: string,
	resolveConfig: (name: string) => CoLocationServerConfig | null,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<CoLocationTokenResult> {
	if (!resolveConfig(serverName)) return { ok: false, error: { kind: "not_oauth" } };
	const result = await store.getValidAccessToken(
		serverName,
		buildOwnerRefreshFn(serverName, resolveConfig, fetchFn),
	);
	if (result.ok) return { ok: true, value: result.value };
	return { ok: false, error: result.error };
}

/**
 * Owner-side MCP-App proxy handler (R-MO27b LEG B). Resolves the upstream URL
 * from the owner's own config, attaches the owner's own token at its own edge,
 * performs the fetch, and returns status/headers/body. The browser NEVER
 * supplied a credential (the serving host stripped cookies/authorization before
 * relaying), so none is echoed. A server this owner does not configure yields a
 * 502 (stale capability snapshot on the serving host); a missing/lost grant
 * yields a 401 so the serving host surfaces the pending challenge.
 */
export async function handleOwnerMcpAppProxy(
	store: McpTokenStore,
	resolveConfig: (name: string) => CoLocationServerConfig | null,
	payload: {
		server_name: string;
		method: string;
		headers: Record<string, string>;
		body_base64: string;
	},
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ status: number; headers: Record<string, string>; body_base64: string }> {
	const config = resolveConfig(payload.server_name);
	if (!config) {
		return { status: 502, headers: {}, body_base64: "" };
	}
	const tokenResult = await getCoLocationAccessToken(
		store,
		payload.server_name,
		resolveConfig,
		fetchImpl,
	);
	const headers = new Headers();
	// The serving host already stripped browser cookies/authorization; the
	// allow-listed subset (accept, content-type, mcp-session-id, …) is safe.
	for (const [k, v] of Object.entries(payload.headers)) headers.set(k, v);
	if (tokenResult.ok) {
		headers.set("authorization", `Bearer ${tokenResult.value}`);
	} else if (tokenResult.error.kind === "no_bundle" || tokenResult.error.kind === "lost_grant") {
		// No live grant: relay back a 401 so the serving host surfaces the pending
		// challenge. Do NOT direct-fetch unauthenticated (it would 401-loop upstream).
		return { status: 401, headers: { "content-type": "application/json" }, body_base64: "" };
	}
	const method = payload.method.toUpperCase();
	const hasBody = method !== "GET" && method !== "HEAD" && payload.body_base64.length > 0;
	const upstream = await fetchImpl(config.url, {
		method,
		headers,
		body: hasBody ? Buffer.from(payload.body_base64, "base64") : undefined,
		redirect: "follow",
	});
	const outHeaders: Record<string, string> = {};
	for (const [k, v] of upstream.headers) {
		const lower = k.toLowerCase();
		if (
			lower === "content-encoding" ||
			lower === "content-length" ||
			lower === "transfer-encoding" ||
			lower === "connection" ||
			lower.startsWith("access-control-")
		) {
			continue;
		}
		outHeaders[k] = v;
	}
	const bodyBuf = Buffer.from(await upstream.arrayBuffer());
	return { status: upstream.status, headers: outHeaders, body_base64: bodyBuf.toString("base64") };
}
