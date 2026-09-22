/**
 * MCP OAuth bridge-integration wiring (slice 3.5).
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, R-MO2 (provider
 * construction + wiring clause), R-MO11/R-MO14-16b (settle-and-wake glue),
 * R-MO17/R-MO19/R-MO20 (resolver bridge + owner exchange).
 *
 * Slices 1-3 built every seam; this module constructs the runtime objects and
 * hands them to the connect site, the web callback route, and the relay
 * processor so the feature runs end to end.
 *
 * ONE token store per host (the `config/mcp-auth.json` file has a single
 * serialized writer, R-MO22) and ONE raise debouncer, both shared across every
 * oauth-configured server's provider. The resolver and owner-exchange consumer
 * read the same store. Servers without an `auth` block get no provider and keep
 * byte-identical behavior (R-MO2).
 */

import {
	type CoLocationServerConfig,
	type CoLocationTokenResult,
	type ExchangeOutcome,
	type MCPServerConfig,
	McpChallengeResolver,
	McpOAuthProvider,
	McpTokenStore,
	type OwnerServerConfig,
	RaiseDebouncer,
	type ResolverAttempt,
	type ResolverServerConfig,
	consumeHandoff,
	defaultMcpAuthPath,
	getCoLocationAccessToken,
	handleOwnerMcpAppProxy,
	writeHandoff,
} from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { OauthMcpResolverBridge } from "@bound/web";

/** The oauth-relevant slice of an http MCP server, extracted from `MCPServerConfig`. */
interface OauthServerEntry {
	name: string;
	url: string;
	scopes?: string[];
	clientId?: string;
	clientSecret?: string;
}

/**
 * The runtime objects the CLI start path wires into three seams: the MCP
 * connect site (provider factory, R-MO2), the web callback route (resolver
 * bridge, R-MO17/R-MO27), and the relay processor (owner-exchange handoff
 * consumer, R-MO19/R-MO20). Null when no http server declares an `auth` block.
 */
export interface McpOAuthWiring {
	/** Shared per-host token store (single serialized writer, R-MO22). */
	store: McpTokenStore;
	/**
	 * Build the v2 `OAuthClientProvider` for one oauth-configured server (R-MO2).
	 * The connect site assigns the returned provider to `serverConfig.authProvider`.
	 * Returns null for a server with no `auth` block — leave `authProvider` unset.
	 */
	providerFor(server: MCPServerConfig): McpOAuthProvider | null;
	/** The resolver bridge backing `GET /oauth/mcp/callback` + `POST /oauth/mcp/claim`. */
	bridge: OauthMcpResolverBridge;
	/**
	 * The owner-exchange handoff consumer for `relayProcessor.setMcpAuthHandoffConsumer`.
	 * Consumes both LOCAL_WORK_TARGET (self-owned) and peer-transferred handoffs.
	 */
	consumeHandoffPayload: (payload: Record<string, unknown>) => Promise<void>;
	/**
	 * Co-location token accessor (R-MO27b LEG A). Returns a live access token for a
	 * locally-configured oauth server, running the refresh path. The MCP-Apps proxy
	 * calls this to attach `Authorization: Bearer` at THIS host's fetch edge when it
	 * is the server's owner. `no_bundle` / lost-grant surface so the route can 401
	 * naming the pending challenge instead of an unauthenticated upstream fetch.
	 */
	getAccessTokenForServer(serverName: string): Promise<CoLocationTokenResult>;
	/**
	 * Owner-side MCP-App proxy consumer (R-MO27b LEG B). Runs on the OWNING host of
	 * an app-bearing server when the serving web host relays a `mcp_app_proxy` row
	 * here: resolves the upstream URL from its own config, attaches its own token,
	 * performs the fetch, and returns the upstream status/headers/body. The owner
	 * NEVER receives or echoes a browser credential (the relay strips them).
	 */
	handleMcpAppProxy(
		payload: {
			server_name: string;
			method: string;
			headers: Record<string, string>;
			body_base64: string;
		},
		fetchImpl?: typeof globalThis.fetch,
	): Promise<{ status: number; headers: Record<string, string>; body_base64: string }>;
}

/** Read the oauth-configured http servers out of the live MCP config. */
function oauthServers(appContext: AppContext): Map<string, OauthServerEntry> {
	const out = new Map<string, OauthServerEntry>();
	const mcpResult = appContext.optionalConfig.mcp;
	if (!mcpResult?.ok) return out;
	const cfg = mcpResult.value as {
		servers: Array<{
			name: string;
			transport: string;
			url?: string;
			auth?: { type: "oauth"; scopes?: string[]; client_id?: string; client_secret?: string };
		}>;
	};
	for (const s of cfg.servers) {
		if (s.transport !== "http" || !s.auth || s.auth.type !== "oauth" || !s.url) continue;
		out.set(s.name, {
			name: s.name,
			url: s.url,
			scopes: s.auth.scopes,
			clientId: s.auth.client_id,
			clientSecret: s.auth.client_secret,
		});
	}
	return out;
}

/**
 * Construct the MCP OAuth runtime wiring, or null when no oauth-configured http
 * server exists (so the whole feature stays inert on hosts that don't use it).
 *
 * `configDir` locates `config/mcp-auth.json` beside `mcp.json` (R-MO5).
 * `reconnect` re-runs MCP connect for a server that resolved connect-time auth
 * (R-MO13b); wired by the caller against the live client map.
 * `webPort` is the daemon's loopback callback port (R-MO27); injected for tests.
 */
export function createMcpOAuthWiring(
	appContext: AppContext,
	configDir: string,
	reconnect: (serverName: string) => Promise<void> | void,
	webPort = 3001,
): McpOAuthWiring | null {
	const servers = oauthServers(appContext);
	if (servers.size === 0) return null;

	const { db, siteId } = appContext;
	const store = new McpTokenStore(defaultMcpAuthPath(configDir));
	const debouncer = new RaiseDebouncer();

	const providerFor = (server: MCPServerConfig): McpOAuthProvider | null => {
		if (
			server.transport !== "http" ||
			!server.auth ||
			server.auth.type !== "oauth" ||
			!server.url
		) {
			return null;
		}
		return new McpOAuthProvider(
			db,
			store,
			{
				name: server.name,
				url: server.url,
				scopes: server.auth.scopes,
				clientId: server.auth.client_id,
				clientSecret: server.auth.client_secret,
			},
			// The owning site of a locally-configured server is THIS host (R-MO6):
			// the config lives here, so this host is the challenge's owner.
			siteId,
			debouncer,
		);
	};

	// The resolver reads server config (url + non-secret client_id) live at
	// resolution time (R-MO17). It is the in-process holder of live attempt state.
	const resolveResolverConfig = (serverName: string): ResolverServerConfig | null => {
		const s = servers.get(serverName);
		if (!s) return null;
		return { name: s.name, url: s.url, scopes: s.scopes, clientId: s.clientId };
	};
	const resolver = new McpChallengeResolver(db, resolveResolverConfig, globalThis.fetch, webPort);

	// The owner reads its own config (url + client credentials it holds, R-MO4)
	// to perform the code-for-token exchange (R-MO20).
	const resolveOwnerConfig = (serverName: string): OwnerServerConfig | null => {
		const s = servers.get(serverName);
		if (!s) return null;
		return {
			name: s.name,
			url: s.url,
			scopes: s.scopes,
			clientId: s.clientId,
			clientSecret: s.clientSecret,
		};
	};

	const consumeHandoffPayload = async (payload: Record<string, unknown>): Promise<void> => {
		// The relay-processor validated the payload against mcpAuthHandoffPayloadSchema
		// before calling us; consumeHandoff re-narrows via its typed param.
		const outcome: ExchangeOutcome = await consumeHandoff(db, payload as never, {
			siteId,
			store,
			resolveConfig: resolveOwnerConfig,
			reconnect,
		});
		if (outcome.kind === "dead_letter") {
			// A dead-letter throw surfaces to the durable-work claim so the row is
			// not acked (R-MO21 redrive). resolved/failed/dropped are terminal acks.
			throw new Error(`mcp_auth_handoff dead-lettered: ${outcome.reason}`);
		}
	};

	// LEG A + LEG B (R-MO27b) delegate to the shared owner-side co-location helper
	// in @bound/agent (which holds the MCP SDK dependency), so this CLI package
	// stays free of a direct `@modelcontextprotocol/client` import. `resolveOwnerConfig`
	// reads the owner's live config (url + client credentials it holds) at call time.
	const getAccessTokenForServer = (
		serverName: string,
	): ReturnType<typeof getCoLocationAccessToken> =>
		getCoLocationAccessToken(
			store,
			serverName,
			resolveOwnerConfig as (name: string) => CoLocationServerConfig | null,
		);

	const handleMcpAppProxy = (
		payload: {
			server_name: string;
			method: string;
			headers: Record<string, string>;
			body_base64: string;
		},
		fetchImpl?: typeof globalThis.fetch,
	): Promise<{ status: number; headers: Record<string, string>; body_base64: string }> =>
		handleOwnerMcpAppProxy(
			store,
			resolveOwnerConfig as (name: string) => CoLocationServerConfig | null,
			payload,
			fetchImpl,
		);

	// The bridge the web callback route holds (R-MO17/R-MO19/R-MO27). forwardOutcome
	// writes the handoff to the owning host; a self-owned challenge targets
	// LOCAL_WORK_TARGET and is consumed in-process by the same relay lane.
	const bridge: OauthMcpResolverBridge = {
		attemptForState(state: string): ResolverAttempt | null {
			return resolver.attemptForState(state);
		},
		forwardOutcome(attempt, outcome): void {
			const row = findChallengeOwner(appContext, attempt.challengeId);
			writeHandoff(db, {
				attempt,
				outcome,
				ownerSiteId: row ?? siteId,
				localSiteId: siteId,
			});
			resolver.discardAttempt(attempt.challengeId);
		},
		async claimForLogin(
			target,
		): Promise<
			{ ok: true; authorizeUrl: string; challengeId: string } | { ok: false; error: string }
		> {
			if (!target.challengeId) {
				return {
					ok: false,
					error: "claim by server_name is not yet supported; pass a challenge_id",
				};
			}
			const result = await resolver.claim(target.challengeId);
			if (!result.ok) {
				return { ok: false, error: result.error.detail };
			}
			return {
				ok: true,
				authorizeUrl: result.value.authorizationUrl,
				challengeId: result.value.challengeId,
			};
		},
	};
	return {
		store,
		providerFor,
		bridge,
		consumeHandoffPayload,
		getAccessTokenForServer,
		handleMcpAppProxy,
	};
}

/** The owning `site_id` of a challenge row, or null if the row is absent. */
function findChallengeOwner(appContext: AppContext, challengeId: string): string | null {
	const row = appContext.db
		.query("SELECT owning_site_id FROM mcp_auth_challenges WHERE id = ?")
		.get(challengeId) as { owning_site_id: string } | null;
	return row?.owning_site_id ?? null;
}
