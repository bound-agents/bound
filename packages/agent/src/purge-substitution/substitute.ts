/**
 * Purge substitution. See `index.ts` for the architectural
 * rationale and post-condition contract.
 */

import type { Message } from "@bound/shared";

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
	//    expansion. The wire-protocol contract requires both halves
	//    of a pair purge together.
	const toolCallToPair = new Map<string, string>();
	const toolResultToPair = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "tool_call") {
			for (let j = i + 1; j < messages.length; j++) {
				if (messages[j].role === "tool_result") {
					toolCallToPair.set(m.id, messages[j].id);
					toolResultToPair.set(messages[j].id, m.id);
					break;
				}
			}
		}
	}

	// 3. Symmetric expansion — purging either side of a pair drops
	//    the other side too.
	for (const group of purgeGroups) {
		const additionalIds = new Set<string>();
		for (const id of Array.from(group.ids)) {
			const pairedResult = toolCallToPair.get(id);
			if (pairedResult && !group.ids.has(pairedResult)) {
				additionalIds.add(pairedResult);
			}
			const pairedCall = toolResultToPair.get(id);
			if (pairedCall && !group.ids.has(pairedCall)) {
				additionalIds.add(pairedCall);
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
