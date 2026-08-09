// Pure extraction logic for the inline aux-invocation cards.
//
// When the agent calls the `aux` tool with action=invoke, the tool result
// carries a `Thread: <uuid>` trailer (sync path: auxiliary.ts handleInvoke;
// background path: server.ts finishParent) naming the child thread the errand
// ran on. Background invocations first return a placeholder mentioning
// "queued on thread <uuid>", which resolves to the trailer form when the aux
// finishes. Aux threads are excluded from the thread directory, so the card
// this module powers is the only navigable door into them. This module
// isolates the "which tool calls are aux-invoke cards, and what thread/status
// do they reference" decision so it can be unit-tested without a DOM.

interface ToolUseLike {
	id: string;
	name: string;
	input: unknown;
}

interface ResultLike {
	content: string;
	exit_code?: number | null;
}

export interface AuxInvokeRef {
	/** The tool_use id of the originating `aux` call (stable render key). */
	toolUseId: string;
	/** The invoked identity's name, from the call input. */
	agentName: string;
	/** The aux child thread id, or null while no result names one yet. */
	threadId: string | null;
	status: "running" | "completed" | "failed";
}

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// The result trailer both invoke paths append. Anchored to end-of-content so
// a summary that merely *mentions* some other thread mid-text cannot hijack
// the link.
const THREAD_TRAILER_RE = new RegExp(`\\bThread: (${UUID_SOURCE})\\s*$`, "i");

// The background placeholder written while the errand is still running:
// "Auxiliary agent 'x' queued on thread <uuid> — running in background."
const QUEUED_RE = new RegExp(`\\bqueued on thread (${UUID_SOURCE})\\b`, "i");

function readString(input: unknown, key: string): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const value = (input as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Select the `aux`-tool calls in a turn that invoked an identity and resolve
 * each to the child thread it ran on plus a coarse status. Calls with no
 * result yet, and background placeholders, report `running`; a result whose
 * exit code is non-zero or whose content is an invoke error reports `failed`.
 * Calls that never produced a thread reference (e.g. validation errors like
 * "no active auxiliary agent named 'x'") are skipped entirely — there is no
 * thread to link to.
 */
export function extractAuxInvokeRefs(
	toolUses: ToolUseLike[],
	resultsByToolUseId: Record<string, ResultLike>,
): AuxInvokeRef[] {
	const refs: AuxInvokeRef[] = [];
	const seen = new Set<string>();
	for (const tu of toolUses) {
		if (tu.name !== "aux") continue;
		if (readString(tu.input, "action") !== "invoke") continue;
		const agentName = readString(tu.input, "name");
		if (!agentName) continue;
		if (seen.has(tu.id)) continue;

		const result = resultsByToolUseId[tu.id];
		if (!result) {
			// Still awaiting the result — a foreground invoke in flight.
			seen.add(tu.id);
			refs.push({ toolUseId: tu.id, agentName, threadId: null, status: "running" });
			continue;
		}

		const trailer = result.content.match(THREAD_TRAILER_RE);
		const queued = trailer ? null : result.content.match(QUEUED_RE);
		const threadId = trailer?.[1] ?? queued?.[1] ?? null;
		if (!threadId) continue; // validation error / legacy result — nothing to link

		const failed =
			(result.exit_code != null && result.exit_code !== 0) ||
			/\b(completed with error|errand failed)\b/i.test(result.content);
		const status: AuxInvokeRef["status"] = queued ? "running" : failed ? "failed" : "completed";

		seen.add(tu.id);
		refs.push({ toolUseId: tu.id, agentName, threadId, status });
	}
	return refs;
}
