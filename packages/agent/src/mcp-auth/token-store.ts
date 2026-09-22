import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Result, err, ok } from "@bound/shared";
import type { StoredOAuthTokens } from "@modelcontextprotocol/client";

/**
 * Owner-side OAuth token custody for http MCP servers.
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §9 (token custody),
 * R-MO22 / R-MO23 / R-MO24. Modeled on the ChatGPT-OAuth
 * `FileTokenStore` / `TokenManager` (packages/llm/src/drivers/chatgpt-oauth/token-store.ts):
 * expiry-gated access, single-flight refresh, rotated-bundle-persisted-before-return.
 *
 * Two facts shape the design:
 *  - Tokens NEVER sync and NEVER cross the relay (R-MO24). This is plain file
 *    I/O against one per-host `config/mcp-auth.json`; there is no DB path.
 *  - The file holds N per-server token bundles PLUS one `registrations` map
 *    shared across servers keyed by authorization-server issuer (R-MO22): one
 *    client identity per (host, AS), N audience-restricted tokens. Because many
 *    servers share the file, every write serializes through one per-file writer
 *    promise-chain and lands write-temp-plus-rename — two servers refreshing
 *    concurrently must never read-modify-write over each other, since a lost
 *    rotated refresh token is an unrecoverable de-authorization.
 */

/** Space-delimited scope convention, matching the challenge-row `scope` columns. */
function unionScopes(a: string, b: string): string {
	const seen = new Set<string>();
	for (const s of [...a.split(/\s+/), ...b.split(/\s+/)]) {
		if (s.length > 0) seen.add(s);
	}
	return [...seen].join(" ");
}

/**
 * A per-server token bundle. Scopes are a **space-joined string** (same
 * convention as the challenge row's `scope_demand` / `granted_scopes`), so a
 * bundle round-trips against the demand without a shape conversion.
 *
 * `issuer` is the SEP-2352 authorization-server stamp, round-tripped verbatim
 * from the SDK's `StoredOAuthTokens.issuer` (R-MO23). `codeVerifier` and
 * `discoveryState` are the provider-contract ephemera the owner persists per
 * server so the slice-3 code-for-token exchange can complete across a restart
 * (R-MO18 keeps them resolver-LOCAL on the resolver; owner-side they live here).
 */
export interface McpTokenBundle {
	accessToken: string;
	refreshToken?: string;
	/** Space-joined scope set held for this server. */
	scopes: string;
	/** Epoch ms at which the access token expires. */
	accessTokenExpiresAt: number;
	/** SEP-2352 authorization-server issuer stamp, round-tripped verbatim. */
	issuer?: string;
	/** PKCE verifier persisted for the in-flight resolution attempt (owner-side). */
	codeVerifier?: string;
	/** RFC 9728/8414 discovery state persisted across the redirect round-trip. */
	discoveryState?: unknown;
}

/**
 * A cached client registration, keyed by authorization-server issuer and
 * SHARED across servers with the same issuer (R-MO22, R-MO25). Carries the
 * non-secret `client_id` (R-MO3) plus any registration metadata the provider
 * needs. NEVER holds a `client_secret` — that lives only in the owner config
 * (R-MO4) and never touches this file.
 */
export interface McpClientRegistration {
	clientId: string;
	/** Optional registration metadata (e.g. DCR response fields). Non-secret. */
	metadata?: Record<string, unknown>;
}

interface McpAuthFile {
	servers: Record<string, McpTokenBundle>;
	registrations: Record<string, McpClientRegistration>;
}

/** A lost grant: a terminal token-endpoint error (R-MO12). Raises a challenge. */
export interface LostGrant {
	kind: "lost_grant";
	/** The RFC 6749 §5.2 terminal error code (`invalid_grant` | `invalid_client`). */
	error: string;
}

/** A refresh that failed transiently and should retry later, not re-auth (R-MO12). */
export interface RefreshTransient {
	kind: "transient";
	detail: string;
}

export type RefreshError = LostGrant | RefreshTransient;

/**
 * The refresh function the store calls when an access token is expired. It
 * performs the RFC 6749 refresh POST and returns either a rotated bundle or a
 * classified failure. The store owns single-flight and persistence; the caller
 * owns the wire request so the store stays free of transport concerns and
 * unit-testable with a stub.
 */
export type RefreshFn = (bundle: McpTokenBundle) => Promise<Result<McpTokenBundle, RefreshError>>;

/** Refresh this many ms before `exp` so an in-flight request never races the boundary. */
export const MCP_TOKEN_REFRESH_SKEW_MS = 60_000;

function isBundle(v: unknown): v is McpTokenBundle {
	if (typeof v !== "object" || v === null) return false;
	const b = v as Record<string, unknown>;
	return (
		typeof b.accessToken === "string" &&
		typeof b.scopes === "string" &&
		typeof b.accessTokenExpiresAt === "number"
	);
}

function parseFile(raw: string): McpAuthFile {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return { servers: {}, registrations: {} };
		const obj = parsed as Record<string, unknown>;
		const servers: Record<string, McpTokenBundle> = {};
		if (typeof obj.servers === "object" && obj.servers !== null) {
			for (const [name, b] of Object.entries(obj.servers as Record<string, unknown>)) {
				if (isBundle(b)) servers[name] = b;
			}
		}
		const registrations: Record<string, McpClientRegistration> = {};
		if (typeof obj.registrations === "object" && obj.registrations !== null) {
			for (const [issuer, r] of Object.entries(obj.registrations as Record<string, unknown>)) {
				if (
					typeof r === "object" &&
					r !== null &&
					typeof (r as { clientId?: unknown }).clientId === "string"
				) {
					registrations[issuer] = r as McpClientRegistration;
				}
			}
		}
		return { servers, registrations };
	} catch {
		return { servers: {}, registrations: {} };
	}
}

/**
 * The default `config/mcp-auth.json` path beside the operator's `mcp.json`
 * (R-MO5). Injected in tests so a tmpdir file replaces the real one.
 */
export function defaultMcpAuthPath(configDir = "config"): string {
	return join(configDir, "mcp-auth.json");
}

/**
 * Custodies OAuth token bundles for http MCP servers in one per-host file.
 *
 * ALL persistence flows through {@link write}, which chains onto a single
 * per-instance writer promise so two concurrent refreshes cannot interleave a
 * read-modify-write (R-MO22). Each write reads the file fresh, mutates, and
 * lands write-temp-plus-rename so a crash mid-write never leaves a torn file.
 * A `saveTokens` persistence failure propagates to the caller and the in-memory
 * cache is NOT advanced (R-MO23) — never leave an in-memory token the disk lacks.
 */
export class McpTokenStore {
	private writeChain: Promise<void> = Promise.resolve();
	private readonly refreshInFlight = new Map<
		string,
		Promise<Result<McpTokenBundle, RefreshError>>
	>();

	constructor(
		private readonly path: string,
		private readonly now: () => number = Date.now,
	) {}

	private read(): McpAuthFile {
		try {
			return parseFile(readFileSync(this.path, "utf8"));
		} catch {
			return { servers: {}, registrations: {} };
		}
	}

	/**
	 * Serialize a read-modify-write onto the single per-file chain and land it
	 * write-temp-plus-rename. Resolves with the mutator's return; a write failure
	 * rejects the caller's await while leaving the chain usable for the next call.
	 */
	private write<T>(mutate: (file: McpAuthFile) => T): Promise<T> {
		const run = this.writeChain.then(() => {
			const file = this.read();
			const result = mutate(file);
			mkdirSync(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.tmp.${Math.random().toString(36).slice(2)}`;
			writeFileSync(tmp, JSON.stringify(file), "utf8");
			renameSync(tmp, this.path);
			return result;
		});
		// Keep the chain alive even if this write rejected, so a persistence
		// failure on one server does not wedge every later write.
		this.writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** The current bundle for a server, or null. Plain read, no refresh. */
	getBundle(server: string): McpTokenBundle | null {
		return this.read().servers[server] ?? null;
	}

	/**
	 * Persist a bundle for a server, unioning its scopes with the scopes already
	 * held on disk so a write NEVER narrows the grant (R-MO20 custody clause).
	 * Propagates a persistence failure to the caller (R-MO23).
	 */
	async saveBundle(server: string, bundle: McpTokenBundle): Promise<void> {
		await this.write((file) => {
			const existing = file.servers[server];
			const scopes = existing ? unionScopes(existing.scopes, bundle.scopes) : bundle.scopes;
			file.servers[server] = { ...bundle, scopes };
		});
	}

	/** The cached registration for an authorization-server issuer, or null. */
	getRegistration(issuer: string): McpClientRegistration | null {
		return this.read().registrations[issuer] ?? null;
	}

	/** Cache a client registration keyed by AS issuer, shared across servers (R-MO22). */
	async saveRegistration(issuer: string, reg: McpClientRegistration): Promise<void> {
		await this.write((file) => {
			file.registrations[issuer] = reg;
		});
	}

	/** Persist the per-server PKCE verifier for the in-flight resolution attempt. */
	async saveCodeVerifier(server: string, verifier: string): Promise<void> {
		await this.write((file) => {
			const existing = file.servers[server];
			file.servers[server] = existing
				? { ...existing, codeVerifier: verifier }
				: { accessToken: "", scopes: "", accessTokenExpiresAt: 0, codeVerifier: verifier };
		});
	}

	/** Persist per-server discovery state across the redirect round-trip. */
	async saveDiscoveryState(server: string, state: unknown): Promise<void> {
		await this.write((file) => {
			const existing = file.servers[server];
			file.servers[server] = existing
				? { ...existing, discoveryState: state }
				: { accessToken: "", scopes: "", accessTokenExpiresAt: 0, discoveryState: state };
		});
	}

	private isExpired(bundle: McpTokenBundle): boolean {
		return this.now() >= bundle.accessTokenExpiresAt - MCP_TOKEN_REFRESH_SKEW_MS;
	}

	/**
	 * Return a live access token for a server: hand back the current token when
	 * unexpired, else run a SINGLE-FLIGHT refresh (concurrent expiry checks for
	 * one server share one refresh POST) and persist the rotated bundle BEFORE
	 * returning the new token (R-MO22). A terminal refresh error surfaces as a
	 * {@link LostGrant} for the caller to raise a challenge; a transient error
	 * surfaces as {@link RefreshTransient} and leaves the on-disk token intact
	 * (R-MO12).
	 */
	async getValidAccessToken(
		server: string,
		refresh: RefreshFn,
	): Promise<Result<string, RefreshError | { kind: "no_bundle" }>> {
		const bundle = this.getBundle(server);
		if (bundle === null || bundle.accessToken === "") {
			return err({ kind: "no_bundle" });
		}
		if (!this.isExpired(bundle)) {
			return ok(bundle.accessToken);
		}
		const rotated = await this.refreshSingleFlight(server, bundle, refresh);
		if (!rotated.ok) return rotated;
		return ok(rotated.value.accessToken);
	}

	private refreshSingleFlight(
		server: string,
		bundle: McpTokenBundle,
		refresh: RefreshFn,
	): Promise<Result<McpTokenBundle, RefreshError>> {
		const existing = this.refreshInFlight.get(server);
		if (existing) return existing;
		const run = (async (): Promise<Result<McpTokenBundle, RefreshError>> => {
			const result = await refresh(bundle);
			if (!result.ok) return result;
			// Rotated bundle persisted BEFORE any caller can use the new token.
			await this.saveBundle(server, result.value);
			return result;
		})().finally(() => {
			this.refreshInFlight.delete(server);
		});
		this.refreshInFlight.set(server, run);
		return run;
	}
}

/**
 * Classify a token-endpoint failure by the RFC 6749 §5.2 error body, not HTTP
 * status alone (R-MO12). Terminal errors (`invalid_grant`, `invalid_client`)
 * are a lost grant. Everything else — 5xx, 429, network throw, timeout, and any
 * UNLISTED token-endpoint error code — is transient: a temporarily-unreachable
 * or misbehaving authorization server is not a revoked grant, so retry, never
 * touch the challenge row. Default-to-transient is safe here because a burned
 * refresh token is already dead and retry cannot double-spend (contrast the
 * authorize-leg default-to-terminal in R-MO17c, slice 3).
 */
const TERMINAL_TOKEN_ERRORS = new Set(["invalid_grant", "invalid_client"]);

export function classifyTokenEndpointError(
	errorCode: string | undefined,
): "terminal" | "transient" {
	if (errorCode !== undefined && TERMINAL_TOKEN_ERRORS.has(errorCode)) return "terminal";
	return "transient";
}

/** Coerce an SDK {@link StoredOAuthTokens} response into an {@link McpTokenBundle}. */
export function bundleFromStoredTokens(
	tokens: StoredOAuthTokens,
	now: number,
	fallbackScopes: string,
): McpTokenBundle {
	const expiresInMs = typeof tokens.expires_in === "number" ? tokens.expires_in * 1000 : 3600_000;
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		scopes:
			typeof tokens.scope === "string" && tokens.scope.length > 0 ? tokens.scope : fallbackScopes,
		accessTokenExpiresAt: now + expiresInMs,
		issuer: tokens.issuer,
	};
}
