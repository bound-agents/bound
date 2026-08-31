import type { WorkClaimDiscipline, WorkRetirementRule } from "@bound/core";
import { RELAY_KINDS, RELAY_KIND_REGISTRY, type RelayKind } from "@bound/shared";

export interface DurableWorkRegistration {
	kind: string;
	claimDiscipline: WorkClaimDiscipline;
	retirementRule: WorkRetirementRule;
	backing: "local" | "synced";
	ttlMs: number | null;
	deadLetterPolicy: "retain-7d";
	idempotencyKey: (identity: Record<string, string>) => string;
	consumer: "relay" | "scheduler" | "dispatch" | "task";
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
		idempotencyKey: (identity) => `dispatch:${identity.message_id}`,
		consumer: "dispatch",
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
