// Pure extraction logic for the inline aux-invocation cards.
//
// When the agent calls the `aux` tool with action=invoke, the persisted
// tool_result row carries `metadata.aux_thread` — the child thread the errand
// ran on — stamped by the tool (sync path: auxiliary.ts handleInvoke returns
// a ToolResultWithMetadata; background path: the DeferredToolResult's
// metadata rides the placeholder row and survives resolution, since
// resolveDeferredToolResult drops only the `background` marker). A background
// invocation additionally carries `metadata.background: true` while the
// errand is still running.
//
// Aux threads are excluded from the thread directory, so the card this module
// powers is the only navigable door into them. This module isolates the
// "which tool calls are aux-invoke cards, and what thread/status do they
// reference" decision so it can be unit-tested without a DOM.
//
// Rows persisted before the metadata channel existed carry the link as a
// `Thread: <uuid>` content trailer (or a "queued on thread <uuid>"
// placeholder); those parse as a legacy fallback.

interface ToolUseLike {
	id: string;
	name: string;
	input: unknown;
}

interface ResultLike {
	content: string;
	exit_code?: number | null;
	/** Raw `messages.metadata` — a JSON string from the API/WS, or already-parsed. */
	metadata?: string | Record<string, unknown> | null;
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

// Legacy content-trailer form (pre-metadata rows). Anchored to end-of-content
// so a summary that merely *mentions* some other thread mid-text cannot
// hijack the link.
const THREAD_TRAILER_RE = new RegExp(`\\bThread: (${UUID_SOURCE})\\s*$`, "i");

// Legacy background placeholder written while the errand was still running.
const QUEUED_RE = new RegExp(`\\bqueued on thread (${UUID_SOURCE})\\b`, "i");

function readString(input: unknown, key: string): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const value = (input as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/** Parse a message's metadata bag, tolerating the raw JSON-string form. */
function readMetadataBag(metadata: ResultLike["metadata"]): Record<string, unknown> | undefined {
	if (metadata == null) return undefined;
	let bag: unknown = metadata;
	if (typeof metadata === "string") {
		try {
			bag = JSON.parse(metadata);
		} catch {
			return undefined;
		}
	}
	if (typeof bag !== "object" || bag === null) return undefined;
	return bag as Record<string, unknown>;
}

/**
 * Select the `aux`-tool calls in a turn that invoked an identity and resolve
 * each to the child thread it ran on plus a coarse status. Calls with no
 * result yet, and unresolved background placeholders (`metadata.background`),
 * report `running`; a result whose exit code is non-zero or whose content is
 * an invoke error reports `failed`. Calls that never produced a thread
 * reference (e.g. validation errors like "no active auxiliary agent named
 * 'x'") are skipped entirely — there is no thread to link to.
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

		// Primary channel: the metadata bag stamped by the tool.
		const bag = readMetadataBag(result.metadata);
		const metaThread = typeof bag?.aux_thread === "string" ? bag.aux_thread : null;
		const inFlight = bag?.background === true;

		// Legacy fallback: rows persisted before the metadata channel existed.
		const trailer = metaThread ? null : result.content.match(THREAD_TRAILER_RE);
		const queued = metaThread || trailer ? null : result.content.match(QUEUED_RE);
		const threadId = metaThread ?? trailer?.[1] ?? queued?.[1] ?? null;
		if (!threadId) continue; // validation error — nothing to link

		const failed =
			(result.exit_code != null && result.exit_code !== 0) ||
			/\b(completed with error|errand failed)\b/i.test(result.content);
		const status: AuxInvokeRef["status"] =
			inFlight || queued ? "running" : failed ? "failed" : "completed";

		seen.add(tu.id);
		refs.push({ toolUseId: tu.id, agentName, threadId, status });
	}
	return refs;
}

export interface ActiveAuxRun {
	threadId: string;
	agentName: string;
}

/** Applies ephemeral aux lifecycle events without requiring a prior start frame. */
export function reduceActiveAuxRuns(
	runs: ActiveAuxRun[],
	event: { type: "aux:started" | "aux:completed"; thread_id: string; agent_name?: string },
): ActiveAuxRun[] {
	if (event.type === "aux:completed") return runs.filter((run) => run.threadId !== event.thread_id);
	if (!event.agent_name) return runs;
	return [
		...runs.filter((run) => run.threadId !== event.thread_id),
		{ threadId: event.thread_id, agentName: event.agent_name },
	];
}
