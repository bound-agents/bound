import type { WorkClaimDiscipline, WorkRetirementRule } from "@bound/core";
import { RELAY_KINDS, RELAY_KIND_REGISTRY, type RelayKind } from "@bound/shared";

export interface DurableWorkSubtype {
	type: "user_message" | "notification" | "tool_result";
	idempotencyKey: (identity: Record<string, string>) => string;
}

export interface DurableWorkRegistration {
	kind: string;
	claimDiscipline: WorkClaimDiscipline;
	retirementRule: WorkRetirementRule;
	backing: "local" | "synced";
	ttlMs: number | null;
	deadLetterPolicy: "retain-7d";
	/** Non-dispatch work kinds have one identity shape. */
	idempotencyKey?: (identity: Record<string, string>) => string;
	consumer: "relay" | "scheduler" | "dispatch" | "task";
	/** Dispatch event types have distinct identity shapes. */
	subtypes?: readonly DurableWorkSubtype[];
}

const relayRegistration = (kind: RelayKind): DurableWorkRegistration => ({
	kind,
	claimDiscipline: "local-exclusive",
	retirementRule: "single-ack",
	backing: "local",
	ttlMs: kind === "stream_chunk" || kind === "stream_end" ? 5 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000,
	deadLetterPolicy: "retain-7d",
	idempotencyKey: (identity) => identity.idempotency_key ?? `${kind}:${identity.id}`,
	consumer: RELAY_KIND_REGISTRY[kind].dispatch === "passive" ? "scheduler" : "relay",
});

/** Additive declaration only in 4A: production continues to use legacy tables. */
export const DURABLE_WORK_REGISTRY: readonly DurableWorkRegistration[] = [
	...RELAY_KINDS.map(relayRegistration),
	{
		kind: "dispatch_message",
		claimDiscipline: "local-exclusive",
		retirementRule: "single-ack",
		backing: "local",
		ttlMs: null,
		deadLetterPolicy: "retain-7d",
		consumer: "dispatch",
		subtypes: [
			{ type: "user_message", idempotencyKey: (identity) => identity.message_id },
			{ type: "notification", idempotencyKey: (identity) => `notify:${identity.notification_id}` },
			{
				type: "tool_result",
				idempotencyKey: (identity) => `tool-result:${identity.thread_id}:${identity.call_id}`,
			},
		],
	},
	{
		kind: "task_fire",
		claimDiscipline: "local-exclusive",
		retirementRule: "single-ack",
		backing: "local",
		ttlMs: null,
		deadLetterPolicy: "retain-7d",
		idempotencyKey: (identity) => `task-fire:${identity.task_id}:${identity.scheduled_at}`,
		consumer: "task",
	},
] as const;

export const DURABLE_WORK_KINDS = DURABLE_WORK_REGISTRY.map((registration) => registration.kind);
