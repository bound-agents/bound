import type { Database } from "bun:sqlite";
import type { RelayInboxEntry, RelayConfig, Logger } from "@bound/shared";
import { readUnprocessed, markProcessed, writeOutbox } from "@bound/core";
import type { MCPClient } from "./mcp-client.js";

const DEFAULT_POLL_INTERVAL_MS = 500;

interface IdempotencyCacheEntry {
	response: string;
	expiresAt: number;
}

export class RelayProcessor {
	private stopped = false;
	private idempotencyCache = new Map<string, IdempotencyCacheEntry>();
	private pendingCancels = new Set<string>();

	constructor(
		private db: Database,
		private siteId: string,
		private mcpClients: Map<string, MCPClient>,
		private keyringSiteIds: Set<string>,
		private logger: Logger,
		private relayConfig?: RelayConfig,
	) {}

	start(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): { stop: () => void } {
		this.stopped = false;
		const tick = async () => {
			if (this.stopped) return;
			try {
				await this.processPendingEntries();
				this.pruneIdempotencyCache();
			} catch (error) {
				this.logger.error("Relay processor tick failed", { error });
			}
			if (!this.stopped) {
				setTimeout(tick, pollIntervalMs);
			}
		};
		setTimeout(tick, pollIntervalMs);
		return {
			stop: () => {
				this.stopped = true;
			},
		};
	}

	private async processPendingEntries(): Promise<void> {
		const entries = readUnprocessed(this.db);
		if (entries.length === 0) return;

		// First pass: collect cancels to check against pending requests
		for (const entry of entries) {
			if (entry.kind === "cancel" && entry.ref_id) {
				this.pendingCancels.add(entry.ref_id);
				markProcessed(this.db, [entry.id]);
			}
		}

		// Second pass: process non-cancel entries
		for (const entry of entries) {
			if (entry.kind === "cancel") continue;
			await this.processEntry(entry);
		}
	}

	private async processEntry(entry: RelayInboxEntry): Promise<void> {
		// Placeholder - will be implemented in Task 2
	}

	private pruneIdempotencyCache(): void {
		const now = Date.now();
		for (const [key, value] of this.idempotencyCache) {
			if (value.expiresAt <= now) {
				this.idempotencyCache.delete(key);
			}
		}
	}
}
