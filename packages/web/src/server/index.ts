import type { Database } from "bun:sqlite";
import type { KeyringConfig, Logger, TypedEventEmitter } from "@bound/shared";
import type { KeyManager } from "@bound/sync";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelaySendPayload,
} from "@bound/sync";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { decodeAssetContent } from "./embedded-assets-codec";
import { hasLoopbackHostHeader } from "./lib/loopback";
import {
	type BackendPricing,
	type ModelsConfig,
	type RoutesConfig,
	registerRoutes,
} from "./routes/index";

type AssetMap = Map<string, { content: string; contentType: string }>;

async function loadEmbeddedAssets(): Promise<AssetMap> {
	let mod: typeof import("./embedded-assets");
	try {
		mod = await import("./embedded-assets");
	} catch {
		// The generated module is gitignored and absent in dev/CI checkouts.
		return new Map();
	}
	const decoded: AssetMap = new Map();
	for (const [path, asset] of mod.embeddedAssets ?? []) {
		decoded.set(path, {
			content: decodeAssetContent(asset.content),
			contentType: asset.contentType,
		});
	}
	return decoded;
}

export type { ModelsConfig, BackendPricing };

export type WebAppConfig = RoutesConfig & {
	/** Runs before every route, including routes registered here. */
	onRequest?: (method: string, path: string) => void;
};

export interface SyncAppConfig {
	siteId: string;
	keyring: KeyringConfig;
	logger: Logger;
	hubSiteId?: string;
	keyManager?: KeyManager;
	wsConfig?: {
		idleTimeout?: number;
		backpressureLimit?: number;
	};
	wsTransportHolder?: {
		addPeer: (
			siteId: string,
			sendFrame: (frame: Uint8Array) => boolean,
			symmetricKey: Uint8Array,
		) => void;
		removePeer: (siteId: string) => void;
		handleChangelogPush: (siteId: string, payload: ChangelogPushPayload) => void;
		handleChangelogAck: (siteId: string, payload: ChangelogAckPayload) => void;
		drainChangelog: (siteId: string) => void;
		handleRelaySend: (sourceSiteId: string, payload: RelaySendPayload) => void;
		handleRelayAck: (sourceSiteId: string, payload: RelayAckPayload) => void;
		handleSpoolTransfer: (sourceSiteId: string, payload: unknown) => void;
		handleSpoolTransferAck: (sourceSiteId: string, payload: unknown) => void;
		drainDurableWorkSpool: (siteId: string) => void;
		seedNewPeer: (siteId: string) => void;
		handleSnapshotAck: (siteId: string, payload: unknown) => void;
		continueSnapshotSeed: (siteId: string) => void;
		applySnapshotChunk: (tableName: string, rows: Array<Record<string, unknown>>) => number;
		handleReseedRequest: (siteId: string, payload: unknown) => void;
		handleConsistencyRequest: (siteId: string, payload: unknown) => void;
		handleRowPullRequest: (siteId: string, payload: unknown) => void;
		handleRowPullAck: (siteId: string, payload: unknown) => void;
		continueRowPull: (siteId: string) => void;
		continueConsistencyStream: (siteId: string) => void;
	} | null;
}

export async function createWebApp(
	db: Database,
	eventBus: TypedEventEmitter,
	config: WebAppConfig,
): Promise<Hono> {
	if (!config.operatorUserId) {
		throw new Error(
			"operatorUserId is required in WebAppConfig. " +
				"Resolve it from allowlist: deterministicUUID(BOUND_NAMESPACE, allowlist.default_web_user)",
		);
	}

	const app = new Hono();
	const routes = registerRoutes(db, eventBus, config);

	const { onRequest } = config;
	if (onRequest) {
		app.use("*", async (c, next) => {
			onRequest(c.req.method, new URL(c.req.url).pathname);
			return next();
		});
	}

	app.use("*", async (c, next) => {
		if (!hasLoopbackHostHeader(c.req.header("host"))) {
			return c.json({ error: "Invalid Host header" }, 400);
		}
		return next();
	});

	app.route("/api/threads", routes.threads);
	app.route("/api/threads", routes.messages);
	app.route("/api/files", routes.files);
	app.route("/api/memory", routes.memory);
	app.route("/api/status", routes.status);
	app.route("/api/tasks", routes.tasks);
	app.route("/api/advisories", routes.advisories);
	app.route("/api/mcp", routes.mcp);
	app.route("/api/mcp-apps", routes.mcpApps);
	app.route("/api/connectors", routes.connectors);
	app.route("/api/webhooks", routes.webhooks);
	app.route("/api/rss-feeds", routes.rssFeeds);
	app.route("/api/skills", routes.skills);
	app.route("/api/metrics", routes.metrics);
	app.route("/api/sandbox", routes.sandbox);
	app.route("/api/persona", routes.persona);
	app.route("/api/routing", routes.routing);
	app.route("/v1/responses", routes.responses);

	// MCP OAuth challenge resolution (MCP OAuth RFC §8/§11, R-MO17/R-MO27/R-MO27e).
	// `POST /oauth/mcp/claim` + `GET /oauth/mcp/callback` back `bound login`; the
	// consent-card list surface mounts at `/api/mcp-challenges`. These factories
	// are built in registerRoutes but, like the /api/mcp-apps regression guarded in
	// routes.integration.test.ts, 404 in the browser unless mounted here.
	app.route("/oauth/mcp", routes.oauthMcp);
	app.route("/api/mcp-challenges", routes.mcpChallenges);

	const assets = await loadEmbeddedAssets();
	if (assets.size > 0) {
		for (const [path, asset] of assets) {
			app.get(path, () => {
				return new Response(asset.content, {
					headers: { "content-type": asset.contentType },
				});
			});
		}
		app.get("/", () => {
			const index = assets.get("/index.html") ?? assets.values().next().value;
			if (!index) return new Response("Not found", { status: 404 });
			return new Response(index.content, {
				headers: { "content-type": index.contentType },
			});
		});
	} else {
		app.use("/*", serveStatic({ root: "./dist/client" }));
	}

	return app;
}
