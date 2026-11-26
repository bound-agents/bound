import type { Database } from "bun:sqlite";
import {
	findActiveConnectorHandleByThreadId,
	findActiveRssFeedByThreadId,
	findActiveWebhookByThreadId,
} from "@bound/core";
import { PASSIVE_INTAKE_TTL_MS, type RelayPassiveKind } from "@bound/shared";

interface PassiveIntakeBinding {
	id: string;
	name: string;
	task_id: string;
}

/**
 * Consumer-agnostic registration for a durable passive relay-inbox row type.
 * The scheduler owns wakeup folding; the reconciler owns stale-row recovery.
 */
export interface PassiveIntakeRegistration {
	kind: RelayPassiveKind;
	ttlMs: number;
	orphanPolicy: "dead-letter";
	noun: string;
	findBinding: (db: Database, threadId: string) => PassiveIntakeBinding | null;
	triggerKey: (binding: PassiveIntakeBinding) => string;
	titleFor: (threadId: string) => string;
}

/**
 * The sole registration point for scheduler-owned relay inbox kinds. Every
 * passive relay producer declares its kind in RELAY_PASSIVE_KINDS; the
 * completeness test requires a corresponding registration here.
 */
export const PASSIVE_INTAKE_REGISTRY: readonly PassiveIntakeRegistration[] = [
	{
		kind: "webhook_intake",
		ttlMs: PASSIVE_INTAKE_TTL_MS,
		orphanPolicy: "dead-letter",
		noun: "webhook",
		findBinding: findActiveWebhookByThreadId,
		triggerKey: (binding) => `webhook:${binding.name}`,
		titleFor: (threadId) => `Webhook intake not draining: handler thread ${threadId} is dark`,
	},
	{
		kind: "connector_intake",
		ttlMs: PASSIVE_INTAKE_TTL_MS,
		orphanPolicy: "dead-letter",
		noun: "connector",
		findBinding: findActiveConnectorHandleByThreadId,
		triggerKey: (binding) => `connector:event:${binding.id}`,
		titleFor: (threadId) => `Connector intake not draining: handler thread ${threadId} is dark`,
	},
	{
		kind: "rss_intake",
		ttlMs: PASSIVE_INTAKE_TTL_MS,
		orphanPolicy: "dead-letter",
		noun: "RSS feed",
		findBinding: findActiveRssFeedByThreadId,
		triggerKey: (binding) => `rss:${binding.name}`,
		titleFor: (threadId) => `RSS intake not draining: handler thread ${threadId} is dark`,
	},
] as const;
