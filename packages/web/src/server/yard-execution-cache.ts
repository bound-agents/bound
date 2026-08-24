import type { YardExecutionEvent } from "@bound/shared";

function isTerminalRoot(event: YardExecutionEvent): boolean {
	return (
		event.node.kind === "run" &&
		event.node_id === event.run_id &&
		event.parent_id === null &&
		event.phase !== "started"
	);
}

/**
 * Ephemeral replay buffer for executions still running on this server.
 * Terminal runs are deliberately absent: their persisted tool-call/result
 * messages are the reload contract once delivery completes.
 */
export class YardExecutionCache {
	private readonly traces = new Map<string, Map<number, YardExecutionEvent>>();

	add(event: YardExecutionEvent): void {
		if (isTerminalRoot(event)) {
			this.traces.delete(event.trace_id);
			return;
		}
		const trace = this.traces.get(event.trace_id) ?? new Map<number, YardExecutionEvent>();
		const existing = trace.get(event.seq);
		if (!existing) trace.set(event.seq, event);
		this.traces.set(event.trace_id, trace);
	}

	forThread(threadId: string): YardExecutionEvent[] {
		return [...this.traces.values()]
			.flatMap((trace) => [...trace.values()])
			.filter((event) => event.thread_id === threadId)
			.sort((a, b) => a.seq - b.seq);
	}
}
