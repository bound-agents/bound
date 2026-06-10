/**
 * Purge substitution. See `index.ts` for the architectural
 * rationale and post-condition contract.
 */

import type { Message } from "@bound/shared";
import { extractToolUseIds } from "../tool-pair-sanitize/helpers";

export interface SubstitutePurgedMessagesParams {
	messages: ReadonlyArray<Message>;
	/** Used as `thread_id` on the synthesized summary developer messages. */
	threadId: string;
}

interface PurgeGroup {
	ids: Set<string>;
	summary: string;
}

/**
 * Replace purge-targeted messages with summary developer stubs.
 * Pure function. Does not mutate input.
 */
export function substitutePurgedMessages(params: SubstitutePurgedMessagesParams): Message[] {
	const { messages, threadId } = params;

	// 1. Collect purge groups from `role: "purge"` messages. Malformed
	//    metadata is silently skipped (the row is still dropped below
	//    via `purgeMessageIds`).
	const purgeMessages = messages.filter((m) => m.role === "purge");
	const purgeIdToSummary = new Map<string, string>();
	const purgeGroups: PurgeGroup[] = [];
	for (const purgeMsg of purgeMessages) {
		try {
			const purgeData = JSON.parse(purgeMsg.content);
			const targetIds: string[] = purgeData.target_ids ?? [];
			const summary: string = purgeData.summary ?? "Messages purged from conversation";
			if (targetIds.length > 0) {
				const group: PurgeGroup = { ids: new Set(targetIds), summary };
				purgeGroups.push(group);
				for (const id of targetIds) {
					purgeIdToSummary.set(id, summary);
				}
			}
		} catch {
			// Malformed purge metadata — skip silently.
		}
	}

	// 2. Build tool_call ↔ tool_result pairing index for symmetric
	//    expansion. The wire-protocol contract requires ALL halves
	//    of a pair purge together: a tool_call can carry N tool_use
	//    blocks and therefore own N tool_results.
	//
	//    Pairing is id-based: a tool_result's `tool_name` column carries
	//    its `tool_use_id`, and the tool_call whose content contains
	//    that tool_use block is its partner — the same association
	//    Stage 3 (tool-pair-sanitize) enforces, via the same
	//    `extractToolUseIds` helper. The previous positional scheme
	//    mapped each tool_call to only the FIRST following tool_result,
	//    so a multi-tool call's 2nd+ results escaped symmetric expansion
	//    and survived their call's purge as orphans.
	//
	//    Resolution is result-centric, one rule per tool_result:
	//      (a) id-based — its `tool_name` column carries a `tool_use_id`
	//          found in some tool_call's content (the same association
	//          Stage 3 / tool-pair-sanitize enforces, via the same
	//          `extractToolUseIds` helper); or
	//      (b) positional — no usable id (legacy rows where either side
	//          predates ContentBlock[] persistence): pair with the
	//          nearest PRECEDING tool_call.
	const toolCallToResults = new Map<string, string[]>();
	const toolResultToCall = new Map<string, string>();
	const callMsgIdByToolUseId = new Map<string, string>();
	for (const m of messages) {
		if (m.role !== "tool_call") continue;
		for (const tuId of extractToolUseIds(m.content)) {
			callMsgIdByToolUseId.set(tuId, m.id);
		}
	}
	let nearestPrecedingCallId: string | undefined;
	for (const m of messages) {
		if (m.role === "tool_call") {
			nearestPrecedingCallId = m.id;
			continue;
		}
		if (m.role !== "tool_result") continue;
		const idMatchedCall = m.tool_name ? callMsgIdByToolUseId.get(m.tool_name) : undefined;
		const callId = idMatchedCall ?? nearestPrecedingCallId;
		if (callId === undefined) continue; // orphan result — Stage 3 stubs it
		toolResultToCall.set(m.id, callId);
		const siblings = toolCallToResults.get(callId);
		if (siblings) siblings.push(m.id);
		else toolCallToResults.set(callId, [m.id]);
	}

	// 3. Symmetric expansion — purging any member of a pair group drops
	//    the rest too: a purged tool_call takes ALL its results, and a
	//    purged tool_result takes its call (which takes the sibling
	//    results, completing the closure in this same pass).
	for (const group of purgeGroups) {
		const additionalIds = new Set<string>();
		for (const id of Array.from(group.ids)) {
			const pairedResults = toolCallToResults.get(id);
			const pairedCall = toolResultToCall.get(id);
			for (const resultId of pairedResults ?? []) {
				if (!group.ids.has(resultId)) additionalIds.add(resultId);
			}
			if (pairedCall !== undefined && !group.ids.has(pairedCall)) {
				additionalIds.add(pairedCall);
				for (const siblingId of toolCallToResults.get(pairedCall) ?? []) {
					if (!group.ids.has(siblingId)) additionalIds.add(siblingId);
				}
			}
		}
		for (const id of Array.from(additionalIds)) {
			group.ids.add(id);
			purgeIdToSummary.set(id, group.summary);
		}
	}

	// 4. Walk messages and emit either the original or a summary
	//    stub at the first occurrence of each purge group.
	const output: Message[] = [];
	const processedPurgeGroups = new Set<number>();
	const purgeMessageIds = new Set(purgeMessages.map((m) => m.id));

	for (const msg of messages) {
		if (purgeMessageIds.has(msg.id)) continue; // drop the purge metadata rows

		// Use `.has()` not `.get() truthy` — an empty-string summary
		// is a valid (if uninformative) purge target and must still
		// drop the message. Pre-extraction, the inline check was
		// `if (purgedSummary)` which silently skipped the purge when
		// the agent passed `summary: ""`. fast-check property P3
		// surfaced this latent bug.
		if (purgeIdToSummary.has(msg.id)) {
			const groupIndex = purgeGroups.findIndex((g) => g.ids.has(msg.id));
			if (groupIndex !== -1 && !processedPurgeGroups.has(groupIndex)) {
				const group = purgeGroups[groupIndex];
				processedPurgeGroups.add(groupIndex);
				output.push({
					id: `purge-summary-${groupIndex}`,
					thread_id: threadId,
					role: "developer",
					content: `(purged ${group.ids.size} messages — agent-authored summary, unverified; verify against source tables before relying) ${group.summary}`,
					model_id: null,
					tool_name: null,
					created_at: msg.created_at,
					modified_at: msg.modified_at,
					host_origin: "local",
					deleted: 0,
					exit_code: null,
					metadata: null,
				});
			}
			continue; // skip the purged message (and subsequent group members)
		}

		output.push(msg);
	}

	return output;
}
