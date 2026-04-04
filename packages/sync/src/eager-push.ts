import type { Database } from "bun:sqlite";
import { recordRelayCycle } from "@bound/core";
import type { KeyringConfig, Logger, RelayInboxEntry } from "@bound/shared";
import type { ReachabilityTracker } from "./reachability.js";
import { signRequest } from "./signing.js";
import type { SyncTransport } from "./transport.js";

export interface EagerPushConfig {
	privateKey: CryptoKey;
	siteId: string;
	db: Database;
	keyring: KeyringConfig;
	reachabilityTracker: ReachabilityTracker;
	logger: Logger;
	transport?: SyncTransport;
}

export async function eagerPushToSpoke(
	config: EagerPushConfig,
	targetSiteId: string,
	entries: RelayInboxEntry[],
): Promise<boolean> {
	if (!config.reachabilityTracker.isReachable(targetSiteId)) {
		config.logger.debug("Skipping eager push to unreachable spoke", { targetSiteId });
		return false;
	}

	// Look up spoke URL from hosts table
	const host = config.db
		.query("SELECT sync_url FROM hosts WHERE site_id = ? AND deleted = 0")
		.get(targetSiteId) as { sync_url: string | null } | null;

	if (!host?.sync_url) {
		// NAT'd host — no URL, sync-only delivery
		return false;
	}

	try {
		const pushStartTime = Date.now();
		const body = JSON.stringify({ entries });
		let response: Response | import("./transport.js").TransportResponse;

		if (config.transport) {
			response = await config.transport.send(
				"POST",
				`${host.sync_url}/api/relay-deliver`,
				"/api/relay-deliver",
				body,
				targetSiteId,
				AbortSignal.timeout(5000),
			);
		} else {
			const headers = await signRequest(
				config.privateKey,
				config.siteId,
				"POST",
				"/api/relay-deliver",
				body,
			);

			response = await fetch(`${host.sync_url}/api/relay-deliver`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body,
				signal: AbortSignal.timeout(5000),
			});
		}

		const pushLatencyMs = Date.now() - pushStartTime;
		const pushSucceeded =
			"ok" in response ? response.ok : response.status >= 200 && response.status < 300;

		// Record relay cycle for this push batch
		if (entries.length > 0) {
			try {
				recordRelayCycle(config.db, {
					direction: "outbound",
					peer_site_id: targetSiteId,
					kind: entries[0].kind,
					delivery_method: "eager_push",
					latency_ms: pushLatencyMs,
					expired: false,
					success: pushSucceeded,
				});
			} catch {
				// Non-fatal if metrics recording fails
			}
		}

		if (pushSucceeded) {
			config.reachabilityTracker.recordSuccess(targetSiteId);
			return true;
		}
		config.reachabilityTracker.recordFailure(targetSiteId);
		return false;
	} catch {
		config.reachabilityTracker.recordFailure(targetSiteId);
		return false;
	}
}
