import { counter, histogram } from "@bound/shared";

const agentToolDispatches = counter("bound.agent.tool_dispatches", {
	description: "Main-agent tool dispatches by outcome and kind",
});
const agentToolDuration = histogram("bound.agent.tool_dispatch.duration", {
	description: "Main-agent tool dispatch duration",
	unit: "s",
});
const schedulerOutcomes = counter("bound.scheduler.outcomes", {
	description: "Scheduler task executions by outcome and type",
});
const schedulerQueueDelay = histogram("bound.scheduler.queue.duration", {
	description: "Delay from a task's scheduled time to successful claim",
	unit: "s",
});
const schedulerClaimDelay = histogram("bound.scheduler.claim.duration", {
	description: "Delay from successful claim to execution start",
	unit: "s",
});
const schedulerExecutionDuration = histogram("bound.scheduler.execution.duration", {
	description: "Scheduler task execution duration",
	unit: "s",
});

type AgentMetricName =
	| "tool_dispatch"
	| "scheduler"
	| "scheduler_queue"
	| "scheduler_claim"
	| "scheduler_execution";
type AgentMetricRecorder = (
	name: AgentMetricName,
	value: number,
	attributes: Record<string, string>,
) => void;

let testMetricRecorder: AgentMetricRecorder | undefined;

export function setAgentMetricRecorderForTest(recorder?: AgentMetricRecorder): void {
	testMetricRecorder = recorder;
}

export function recordAgentOperationalMetric(
	name: "tool_dispatch" | "scheduler",
	attributes: Record<string, string>,
): void {
	testMetricRecorder?.(name, 1, attributes);
	if (name === "tool_dispatch") agentToolDispatches.add(1, attributes);
	else schedulerOutcomes.add(1, attributes);
}

export function recordAgentToolDuration(
	durationMs: number,
	attributes: Record<string, string>,
): void {
	agentToolDuration.record(Math.max(0, durationMs) / 1000, attributes);
}

function recordSchedulerDuration(
	name: "scheduler_queue" | "scheduler_claim" | "scheduler_execution",
	durationMs: number,
	attributes: Record<string, string>,
): void {
	const seconds = Math.max(0, durationMs) / 1000;
	testMetricRecorder?.(name, seconds, attributes);
	if (name === "scheduler_queue") schedulerQueueDelay.record(seconds, attributes);
	else if (name === "scheduler_claim") schedulerClaimDelay.record(seconds, attributes);
	else schedulerExecutionDuration.record(seconds, attributes);
}

export function recordSchedulerQueueDelay(
	durationMs: number,
	attributes: Record<string, string>,
): void {
	recordSchedulerDuration("scheduler_queue", durationMs, attributes);
}

export function recordSchedulerClaimDelay(
	durationMs: number,
	attributes: Record<string, string>,
): void {
	recordSchedulerDuration("scheduler_claim", durationMs, attributes);
}

export function recordSchedulerExecutionDuration(
	durationMs: number,
	attributes: Record<string, string>,
): void {
	recordSchedulerDuration("scheduler_execution", durationMs, attributes);
}
