import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendCapabilities, ContentBlock, LLMMessage } from "@bound/llm";
import type { Message } from "@bound/shared";
import { getFileThreadNotificationMessage, getLastThreadForFile } from "./file-thread-tracker";
import {
	buildCrossThreadDigest,
	buildVolatileEnrichment,
	computeBaseline,
} from "./summary-extraction.js";

export interface ContextParams {
	db: Database;
	threadId: string;
	taskId?: string;
	userId: string;
	currentModel?: string;
	contextWindow?: number;
	noHistory?: boolean;
	configDir?: string;
	hostName?: string;
	siteId?: string;
	relayInfo?: {
		remoteHost: string;
		localHost: string;
		model: string;
		provider: string;
	};
	/** When set, assembleContext() prepends a system message explaining silence semantics.
	 * toolNames lists the tools the agent should use to send messages on this platform.
	 * When omitted, a generic reference is used instead of a specific tool name.
	 */
	platformContext?: { platform: string; toolNames?: string[] };
	/**
	 * When set, context assembly performs in-place substitution of content blocks
	 * that the target backend does not support. Image blocks are replaced with text
	 * annotations when vision is not supported. Document blocks are always replaced
	 * with their text_representation.
	 */
	targetCapabilities?: BackendCapabilities;
}

/**
 * Estimates the character length of message content for token-budget purposes.
 * Handles both string content and ContentBlock[] content (produced by
 * substituteUnsupportedBlocks when the backend lacks vision/document support).
 * Text blocks contribute their text length; all other blocks contribute their
 * JSON-serialised length as a conservative approximation.
 */
export function estimateContentLength(content: string | ContentBlock[]): number {
	if (typeof content === "string") return content.length;
	return content.reduce((sum: number, block: ContentBlock) => {
		if (block.type === "text") return sum + block.text.length;
		return sum + JSON.stringify(block).length;
	}, 0);
}

// Cache for persona content - loaded once at startup
let personaCache: string | null = null;
let personaCachePath: string | null = null;

/**
 * Load persona from config directory
 * Loads config/persona.md if it exists
 */
function loadPersona(configDir: string): string | null {
	// Check if we already have this cached
	if (personaCachePath === configDir && personaCache !== undefined) {
		return personaCache;
	}

	const personaPath = join(configDir, "persona.md");
	if (existsSync(personaPath)) {
		try {
			const content = readFileSync(personaPath, "utf-8");
			personaCachePath = configDir;
			personaCache = content;
			return content;
		} catch {
			return null;
		}
	}

	personaCachePath = configDir;
	personaCache = null;
	return null;
}

/**
 * Assembles the context for an LLM call using the 8-stage pipeline from spec §13.1:
 * 1. MESSAGE_RETRIEVAL - Fetch messages by thread_id
 * 2. PURGE_SUBSTITUTION - Replace targeted IDs with summaries
 * 3. TOOL_PAIR_SANITIZATION - Ensure tool_call/tool_result pairs are correct
 * 4. MESSAGE_QUEUEING - Exclude non-tool messages during active tool-use
 * 5. ANNOTATION - Add model/host/timestamp annotations
 * 6. ASSEMBLY - Compose system prompt + persona + orientation + history + volatile
 * 7. BUDGET_VALIDATION - Check token count, truncate if needed
 * 8. METRIC_RECORDING - Record tokens (deferred to Phase 8)
 */
// Tracks per-thread+backend advisory "image stripped" notifications to avoid log noise.
// Map key: `${threadId}::${backendId}` (backendId approximated by vision flag string)
const advisoryDedup = new Set<string>();

/**
 * Substitutes content blocks that the target backend does not support.
 * Returns a new LLMMessage with substituted content, or the original if no substitution needed.
 * Never modifies the database.
 */
function substituteUnsupportedBlocks(
	msg: LLMMessage,
	targetCapabilities: BackendCapabilities,
	db: Database,
	threadId: string,
): LLMMessage {
	// Try to parse content as ContentBlock[] (may be a JSON string or already an array)
	let blocks: Array<{ type: string; [key: string]: unknown }> | null = null;
	if (Array.isArray(msg.content)) {
		blocks = msg.content as Array<{ type: string; [key: string]: unknown }>;
	} else if (typeof msg.content === "string") {
		try {
			const parsed = JSON.parse(msg.content);
			if (Array.isArray(parsed)) blocks = parsed;
		} catch {
			// Not JSON — plain text, no block substitution needed
		}
	}

	if (!blocks) return msg;

	// Check if any substitution is needed
	const hasImage = blocks.some((b) => b.type === "image");
	const hasDocument = blocks.some((b) => b.type === "document");
	if (!hasImage && !hasDocument) return msg;

	const substituted = blocks.map((block) => {
		if (block.type === "image" && !targetCapabilities.vision) {
			// Replace image block with text annotation
			const description = typeof block.description === "string" ? block.description : "image";
			return { type: "text" as const, text: `[Image: ${description}]` };
		}

		if (block.type === "document") {
			// Always replace document blocks with their text_representation
			const textRep =
				typeof block.text_representation === "string"
					? block.text_representation
					: "[Document: content unavailable]";
			return { type: "text" as const, text: textRep };
		}

		// Handle file_ref image sources that need DB lookup
		if (block.type === "image" && targetCapabilities.vision) {
			const source = block.source as
				| { type?: string; file_id?: string; data?: string; media_type?: string }
				| undefined;
			if (source?.type === "file_ref" && source.file_id) {
				// Attempt to resolve file content from files table
				const fileRow = db
					.query("SELECT content, is_binary FROM files WHERE id = ? AND deleted = 0")
					.get(source.file_id) as { content: string | null; is_binary: number } | null;

				if (!fileRow || !fileRow.content) {
					// File not found or binary without content — use text placeholder
					return {
						type: "text" as const,
						text: `[Image file unavailable: ${source.file_id}]`,
					};
				}
				// Resolve to base64 inline block
				return {
					type: "image" as const,
					source: {
						type: "base64" as const,
						media_type: "image/jpeg" as const, // default; ideally stored in files table
						data: fileRow.content,
					},
					description: block.description,
				};
			}
		}

		return block;
	});

	// Only emit advisory once per thread+vision-capability combo to avoid log noise
	if (hasImage && !targetCapabilities.vision) {
		const advisoryKey = `${threadId}::vision:false`;
		if (!advisoryDedup.has(advisoryKey)) {
			advisoryDedup.add(advisoryKey);
			// Note: we don't have access to logger here — advisory is a no-op for now.
			// Agent-loop logs the substitution at the call site.
		}
	}

	return { ...msg, content: substituted as LLMMessage["content"] };
}

// Static list of available built-in commands with brief descriptions
const AVAILABLE_COMMANDS = [
	{ name: "query", description: "Execute a SELECT query against the database" },
	{ name: "memorize", description: "Store a key-value memory entry" },
	{ name: "advisory", description: "Post a proactive advisory for operator review" },
	{ name: "forget", description: "Soft-delete a memory entry (supports --prefix)" },
	{ name: "schedule", description: "Schedule a deferred, cron, or event-driven task" },
	{ name: "cancel", description: "Cancel a scheduled task (supports --payload-match)" },
	{ name: "emit", description: "Emit a custom event on the event bus" },
	{ name: "purge", description: "Create a purge record targeting message IDs" },
	{ name: "await", description: "Poll until tasks reach a terminal state" },
	{ name: "cache-warm", description: "Pre-warm the prompt cache for a thread" },
	{ name: "cache-pin", description: "Pin a cache entry to prevent eviction" },
	{ name: "cache-unpin", description: "Unpin a previously pinned cache entry" },
	{ name: "cache-evict", description: "Evict a specific cache entry" },
	{ name: "model-hint", description: "Set or clear the model hint for the current task" },
	{ name: "archive", description: "Archive a thread to long-term storage" },
	{ name: "hostinfo", description: "Display registered host information" },
	{
		name: "skill-activate",
		description: "Activate a skill from /home/user/skills/{name}/SKILL.md",
	},
	{ name: "skill-list", description: "List skills with status, activations, and description" },
	{ name: "skill-read", description: "Read a skill's SKILL.md content with status header" },
	{ name: "skill-retire", description: "Retire a skill; scans tasks and creates advisories" },
] as const;

export function assembleContext(params: ContextParams): LLMMessage[] {
	const {
		db,
		threadId,
		userId,
		noHistory = false,
		configDir = "config",
		currentModel,
		contextWindow = 8000,
		hostName,
		siteId,
		relayInfo,
		platformContext,
		targetCapabilities,
	} = params;

	// Enrichment state — shared between Stage 6 volatile context and Stage 7 budget check
	let enrichmentBaseline: string | undefined;
	let enrichmentMessageIndex = -1;
	let enrichmentStartIdx = -1; // Index in volatileLines where enrichment section starts
	let enrichmentEndIdx = -1; // Index in volatileLines just after enrichment section ends
	let allVolatileLines: string[] = []; // Full volatile content for budget pressure rebuild
	let totalMemCount = 0;

	// Stage 1: MESSAGE_RETRIEVAL
	const messages: Message[] = [];
	if (!noHistory) {
		const query = db.query(
			"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
		);
		const rows = query.all(threadId) as Message[];
		messages.push(...rows);
	}

	// Stage 2: PURGE_SUBSTITUTION
	// Find any purge messages and replace targeted IDs with summaries
	const purgeMessages = messages.filter((m) => m.role === "purge");
	const purgeIdToSummary = new Map<string, string>();
	const purgeGroups: Array<{ ids: Set<string>; summary: string }> = [];

	for (const purgeMsg of purgeMessages) {
		try {
			const purgeData = JSON.parse(purgeMsg.content);
			const targetIds: string[] = purgeData.target_ids || [];
			const summary: string = purgeData.summary || "Messages purged from conversation";

			if (targetIds.length > 0) {
				const group = { ids: new Set(targetIds), summary };
				purgeGroups.push(group);

				for (const id of targetIds) {
					purgeIdToSummary.set(id, summary);
				}
			}
		} catch {
			// Ignore parse errors
		}
	}

	// Build a map of tool_call IDs to their paired tool_result IDs
	const toolCallToPair = new Map<string, string>();
	const toolResultToPair = new Map<string, string>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "tool_call") {
			// Find the next tool_result
			for (let j = i + 1; j < messages.length; j++) {
				if (messages[j].role === "tool_result") {
					toolCallToPair.set(msg.id, messages[j].id);
					toolResultToPair.set(messages[j].id, msg.id);
					break;
				}
			}
		}
	}

	// Expand purge groups to include paired tool messages
	for (const group of purgeGroups) {
		const additionalIds = new Set<string>();
		for (const id of Array.from(group.ids)) {
			// If this is a tool_call, include its paired tool_result
			const pairedResult = toolCallToPair.get(id);
			if (pairedResult && !group.ids.has(pairedResult)) {
				additionalIds.add(pairedResult);
			}
			// If this is a tool_result, include its paired tool_call
			const pairedCall = toolResultToPair.get(id);
			if (pairedCall && !group.ids.has(pairedCall)) {
				additionalIds.add(pairedCall);
			}
		}
		// Add the additional IDs to the group
		for (const id of Array.from(additionalIds)) {
			group.ids.add(id);
			purgeIdToSummary.set(id, group.summary);
		}
	}

	// Build the list of messages to process, replacing purge groups with summaries
	const messagesAfterPurge: Message[] = [];
	const processedPurgeGroups = new Set<number>();
	const purgeMessageIds = new Set(purgeMessages.map((m) => m.id));

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// Skip purge messages themselves
		if (purgeMessageIds.has(msg.id)) {
			continue;
		}

		// Check if this message is part of a purge group
		const purgedSummary = purgeIdToSummary.get(msg.id);
		if (purgedSummary) {
			// Find which purge group this belongs to
			const groupIndex = purgeGroups.findIndex((g) => g.ids.has(msg.id));
			if (groupIndex !== -1 && !processedPurgeGroups.has(groupIndex)) {
				// This is the first message in this purge group - replace it with a summary
				const group = purgeGroups[groupIndex];
				processedPurgeGroups.add(groupIndex);

				// Create a system message with the purge summary
				messagesAfterPurge.push({
					id: `purge-summary-${groupIndex}`,
					thread_id: threadId,
					role: "system",
					content: `(purged ${group.ids.size} messages) ${group.summary}`,
					model_id: null,
					tool_name: null,
					created_at: msg.created_at,
					modified_at: msg.modified_at,
					host_origin: "local",
				});
			}
			// Skip this message (and all subsequent messages in the same purge group)
			continue;
		}

		// Not purged - include it
		messagesAfterPurge.push(msg);
	}

	// Stage 2.5: NON-LLM ROLE FILTERING
	// Remove alert and DB-originated system messages BEFORE the tool pair sanitizer runs.
	// These non-LLM roles confuse the sanitizer's reordering logic when they appear
	// between tool_call/tool_result pairs. Purge-summary system messages (created in
	// Stage 2 with id prefix "purge-summary-") are preserved as meaningful context.
	const NON_LLM_ROLES = new Set(["alert", "purge"]);
	const messagesFiltered = messagesAfterPurge.filter((m) => {
		if (NON_LLM_ROLES.has(m.role)) return false;
		// Filter DB-originated system messages but keep purge summaries
		if (m.role === "system" && !m.id.startsWith("purge-summary-")) return false;
		return true;
	});

	// Stage 3: TOOL_PAIR_SANITIZATION
	// Ensure tool_call/tool_result pairs are adjacent (no messages between them).
	//
	// Pass 1: For each tool_call, look ahead for its matching tool_result.
	// If there are non-tool messages between them, move those messages before the tool_call.
	// This preserves the real tool_call -> tool_result adjacency that Bedrock requires.
	const reordered: Message[] = [];
	const consumed = new Set<number>();

	for (let i = 0; i < messagesFiltered.length; i++) {
		if (consumed.has(i)) continue;

		const msg = messagesFiltered[i];
		if (msg.role === "tool_call") {
			// Collect ALL tool_results that belong to this tool_call, looking past any
			// interleaved non-tool messages. The co-emitted assistant text is persisted
			// with the same `now` timestamp as the tool_call; if some tool_results land
			// in the next millisecond, ORDER BY (created_at, rowid) places the assistant
			// between the fast and slow results. We detect this by tracking which
			// tool_use_ids are still unmatched — if more are pending we continue past
			// the non-tool message; if all are matched we stop (legitimate post-pair msg).
			const matchIndices: number[] = [];
			const nonToolMessages: Message[] = [];
			const nonToolIndices: number[] = [];

			// Build set of expected tool_use_ids from this tool_call's content
			const pendingToolUseIds = new Set<string>();
			try {
				const tcBlocks = JSON.parse(msg.content);
				if (Array.isArray(tcBlocks)) {
					for (const block of tcBlocks) {
						if (block.type === "tool_use" && block.id) {
							pendingToolUseIds.add(block.id);
						}
					}
				}
			} catch {
				// Non-parseable content — fall back to unlimited scan
			}

			for (let j = i + 1; j < messagesFiltered.length; j++) {
				if (consumed.has(j)) continue;
				const jMsg = messagesFiltered[j];
				if (jMsg.role === "tool_call") {
					// Hit the next tool_call — stop collecting
					break;
				}
				if (jMsg.role === "tool_result") {
					matchIndices.push(j);
					// Remove matched tool_use_id from pending set
					if (jMsg.tool_name) pendingToolUseIds.delete(jMsg.tool_name);
				} else {
					// Non-tool message encountered after finding at least one result.
					// Continue scanning past it only if there are still unmatched
					// tool_use_ids — those results are displaced by the timestamp
					// collision and we need to keep looking for them.
					// If all tool_use_ids are matched (or the set was never populated),
					// stop: this message legitimately follows the completed pair.
					if (matchIndices.length > 0 && pendingToolUseIds.size === 0) {
						break;
					}
					// Interleaved non-tool message — move before the tool_call
					nonToolMessages.push(jMsg);
					nonToolIndices.push(j);
				}
			}

			if (matchIndices.length > 0) {
				// Move non-tool messages before the tool_call
				for (const m of nonToolMessages) {
					reordered.push(m);
				}
				for (const idx of nonToolIndices) {
					consumed.add(idx);
				}
				for (const idx of matchIndices) {
					consumed.add(idx);
				}
				// Push tool_call followed by ALL its tool_results in order
				reordered.push(msg);
				for (const idx of matchIndices) {
					reordered.push(messagesFiltered[idx]);
				}
			} else {
				// No tool_results found — push non-tool messages and tool_call as-is
				for (const m of nonToolMessages) {
					reordered.push(m);
				}
				for (const idx of nonToolIndices) {
					consumed.add(idx);
				}
				reordered.push(msg);
			}
		} else {
			reordered.push(msg);
		}
	}

	// Pass 2: Handle any remaining structural issues (orphaned tool_results, unclosed tool_calls)
	const sanitized: Message[] = [];
	let inActiveTool = false;
	let lastToolId = "";
	let prevSanitizedRole: string | null = null;

	for (const msg of reordered) {
		if (msg.role === "tool_call") {
			inActiveTool = true;
			lastToolId = msg.id;
			sanitized.push(msg);
			prevSanitizedRole = "tool_call";
		} else if (msg.role === "tool_result") {
			if (inActiveTool) {
				// First tool_result closing the active tool_call
				sanitized.push(msg);
				inActiveTool = false;
				prevSanitizedRole = "tool_result";
			} else if (prevSanitizedRole === "tool_result") {
				// Additional tool_result in a multi-tool response — push directly,
				// no synthetic tool_call needed. The driver merges these into one
				// user message per the Bedrock/Anthropic multi-tool requirement.
				sanitized.push(msg);
				// prevSanitizedRole stays "tool_result"
			} else {
				// Truly orphaned tool_result (no preceding tool_call at all) — inject synthetic.
				// Use the tool_result's own tool_use_id (stored in tool_name) so the Bedrock
				// driver emits a proper toolUse block instead of falling back to [{ text: "" }]
				// which Bedrock rejects with "text field is blank".
				const toolUseId = msg.tool_name || `synthetic-tc-${msg.id}`;
				sanitized.push({
					id: `synthetic-${msg.id}`,
					thread_id: threadId,
					role: "tool_call",
					content: JSON.stringify([
						{ type: "tool_use", id: toolUseId, name: "unknown", input: {} },
					]),
					model_id: null,
					tool_name: toolUseId,
					created_at: msg.created_at,
					modified_at: msg.modified_at,
					host_origin: msg.host_origin,
				});
				sanitized.push(msg);
				prevSanitizedRole = "tool_result";
			}
		} else {
			if (inActiveTool) {
				// Non-tool message during active tool-use with no real tool_result ahead
				// (pass 1 already moved interleaved messages for real pairs)
				sanitized.push({
					id: `synthetic-${lastToolId}`,
					thread_id: threadId,
					role: "tool_result",
					content: "Tool execution was interrupted",
					model_id: null,
					tool_name: null,
					created_at: lastToolId,
					modified_at: lastToolId,
					host_origin: "local",
				});
				inActiveTool = false;
				prevSanitizedRole = "tool_result";
			}
			sanitized.push(msg);
			prevSanitizedRole = msg.role;
		}
	}

	// Close any unclosed tool pair
	if (inActiveTool) {
		sanitized.push({
			id: `synthetic-close-${lastToolId}`,
			thread_id: threadId,
			role: "tool_result",
			content: "Tool execution completed",
			model_id: null,
			tool_name: null,
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			host_origin: "local",
		});
	}

	// Stage 4: MESSAGE_QUEUEING
	// Already handled by filtering - skip messages that were persisted during active tool-use

	// Stage 5: ANNOTATION
	// Convert Message to LLMMessage format with annotations
	// Also detect model switches between consecutive assistant messages per spec R-U11
	// Defense-in-depth: filter non-LLM roles in case any survived Stage 2.5
	const LLM_COMPATIBLE_ROLES = new Set(["user", "assistant", "system", "tool_call", "tool_result"]);

	// Build a map from tool_call message ID to the tool_use IDs contained within,
	// so we can propagate tool_use_id to the subsequent tool_result messages.
	const toolCallIdToToolUseId = new Map<string, string>();
	for (const m of sanitized) {
		if (m.role === "tool_call") {
			try {
				const blocks = JSON.parse(m.content);
				if (Array.isArray(blocks) && blocks.length > 0 && blocks[0].id) {
					toolCallIdToToolUseId.set(m.id, blocks[0].id);
				}
			} catch {
				// Content may not be JSON (e.g. synthetic tool_call)
			}
		}
	}

	const annotated: LLMMessage[] = [];
	let lastAssistantModel: string | null = null;
	let lastToolCallMsgId: string | null = null;
	let modelSwitchCount = 0;
	const MODEL_SWITCH_CAP = 3;

	for (let i = 0; i < sanitized.length; i++) {
		const m = sanitized[i];

		// Skip non-LLM roles (alert, purge, etc.)
		if (!LLM_COMPATIBLE_ROLES.has(m.role)) {
			continue;
		}

		// Track the last tool_call message ID for tool_use_id propagation
		if (m.role === "tool_call") {
			lastToolCallMsgId = m.id;
		}

		// Check for model switch on assistant messages; cap at MODEL_SWITCH_CAP
		// to prevent long threads with many switches from flooding the context.
		if (m.role === "assistant" && m.model_id) {
			if (lastAssistantModel && lastAssistantModel !== m.model_id) {
				if (modelSwitchCount < MODEL_SWITCH_CAP) {
					annotated.push({
						role: "system",
						content: `Model switched from ${lastAssistantModel} to ${m.model_id}`,
					});
					modelSwitchCount++;
				}
			}
			lastAssistantModel = m.model_id;
		}

		const msg: LLMMessage = {
			role: m.role as LLMMessage["role"],
			content: m.content,
			model_id: m.model_id || undefined,
			host_origin: m.host_origin,
		};

		// Propagate tool_use_id for tool_result messages
		// In the DB, tool_name stores the tool_use_id for tool_result messages
		if (m.role === "tool_result") {
			const toolUseId =
				m.tool_name ||
				(lastToolCallMsgId ? toolCallIdToToolUseId.get(lastToolCallMsgId) : null) ||
				`synthetic-${m.id}`;
			msg.tool_use_id = toolUseId;
		}

		annotated.push(msg);
	}

	// Stage 5b: CONTENT_SUBSTITUTION
	// Replace image/document blocks in assembled messages when the target backend lacks vision support.
	// This modifies the LLMMessage[] only — the persisted messages.content is never changed.
	const finalAnnotated = targetCapabilities
		? annotated.map((msg) => substituteUnsupportedBlocks(msg, targetCapabilities, db, threadId))
		: annotated;

	// Stage 6: ASSEMBLY
	// Start with system prompt
	const assembled: LLMMessage[] = [
		{
			role: "system",
			content:
				"You are a helpful AI assistant. You have access to tools to help the user. " +
				"Be concise and direct in your responses.",
		},
	];

	// Load and inject persona if it exists
	const persona = loadPersona(configDir);
	if (persona) {
		assembled.push({
			role: "system",
			content: persona,
		});
	}

	// Stable orientation section: available commands, current model, host identity
	const commandList = AVAILABLE_COMMANDS.map((c) => `  ${c.name} — ${c.description}`).join("\n");
	const orientationLines: string[] = [
		"## Orientation",
		"",
		"### Available Commands",
		commandList,
		"",
		"Run `commands` to list all commands (including MCP tools), or `commands <name>` for detailed syntax.",
		"",
		`### Current Model\n${currentModel || "default"}`,
		"",
		`### Host Identity\nHost: ${hostName || "unknown"}\nSite ID: ${siteId || "unknown"}`,
	];
	assembled.push({
		role: "system",
		content: orientationLines.join("\n"),
	});

	// Track inactive skill reference for volatile context note (AC3.4)
	let inactiveSkillRef: string | null = null;

	// Inject task-referenced skill body as system message (AC3.3, AC3.5)
	// Must be outside the !noHistory guard so it works when noHistory = true
	if (params.taskId) {
		try {
			const taskRow = db
				.query("SELECT payload FROM tasks WHERE id = ? AND deleted = 0")
				.get(params.taskId) as { payload: string | null } | null;

			if (taskRow?.payload) {
				let taskPayload: unknown;
				try {
					taskPayload = JSON.parse(taskRow.payload);
				} catch {
					// Malformed payload — skip skill injection
				}

				if (
					typeof taskPayload === "object" &&
					taskPayload !== null &&
					"skill" in taskPayload &&
					typeof (taskPayload as Record<string, unknown>).skill === "string"
				) {
					const skillName = (taskPayload as Record<string, unknown>).skill as string;

					const skillRow = db
						.query("SELECT id FROM skills WHERE name = ? AND status = 'active' AND deleted = 0")
						.get(skillName) as { id: string } | null;

					if (skillRow) {
						const skillMdRow = db
							.query("SELECT content FROM files WHERE path = ? AND deleted = 0")
							.get(`/home/user/skills/${skillName}/SKILL.md`) as {
							content: string;
						} | null;

						if (skillMdRow?.content) {
							assembled.push({
								role: "system",
								content: skillMdRow.content,
							});
						}
					} else {
						// Skill referenced but not active — note will appear in volatile context
						inactiveSkillRef = skillName;
					}
				}
			}
		} catch {
			// Non-fatal: skip skill body injection on any error
		}
	}

	// Add message history
	assembled.push(...finalAnnotated);

	// Add volatile context at the end per spec R-U30
	if (!noHistory) {
		const volatileLines: string[] = [];
		volatileLines.push(`User ID: ${userId}, Thread ID: ${threadId}`);

		// AC5.4: Model location when inference is relayed
		if (relayInfo) {
			volatileLines.push(
				`You are: ${relayInfo.model} (via ${relayInfo.provider} on host ${relayInfo.remoteHost}, relayed from ${relayInfo.localHost})`,
			);
		}

		// Platform silence semantics: user only sees what you explicitly send.
		if (platformContext) {
			const toolRef =
				platformContext.toolNames && platformContext.toolNames.length > 0
					? platformContext.toolNames.map((n) => `\`${n}\``).join(" or ")
					: "the platform send tool";
			volatileLines.push("");
			volatileLines.push(`## Platform Context: ${platformContext.platform}`);
			volatileLines.push(
				"The user of this conversation is on an external platform and cannot see your responses directly.",
			);
			volatileLines.push(
				`To send a message to the user, call ${toolRef}. If you do not call it, the user sees nothing (silence).`,
			);
			volatileLines.push(
				"Each call to the tool produces one separate message to the user. " +
					"Multiple calls are allowed and delivered in order.",
			);
		}

		// Include current model name
		if (currentModel) {
			volatileLines.push(`Current Model: ${currentModel}`);
		}

		// Stage 5.5: VOLATILE ENRICHMENT (replaces raw memory dump)
		enrichmentBaseline = computeBaseline(db, threadId, params.taskId, false);
		const { memoryDeltaLines, taskDigestLines } = buildVolatileEnrichment(db, enrichmentBaseline);

		// Query total memory count for the header line
		totalMemCount = (
			db.prepare("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0").get() as {
				c: number;
			}
		).c;

		// Format and append enrichment, recording start/end indices
		const memChangedCount = memoryDeltaLines.filter((l) => l.startsWith("- ")).length;
		let memHeaderLine = `Memory: ${totalMemCount} entries`;
		if (memChangedCount > 0) {
			memHeaderLine += ` (${memChangedCount} changed since your last turn in this thread)`;
		}

		// Record where enrichment section begins
		enrichmentStartIdx = volatileLines.length;
		volatileLines.push("");
		volatileLines.push(memHeaderLine);
		if (memoryDeltaLines.length > 0) {
			volatileLines.push(...memoryDeltaLines);
		}
		if (taskDigestLines.length > 0) {
			volatileLines.push("");
			volatileLines.push(...taskDigestLines);
		}
		// Record where enrichment section ends
		enrichmentEndIdx = volatileLines.length;

		// Include cross-thread digest
		const crossThreadDigest = buildCrossThreadDigest(db, userId);
		if (crossThreadDigest) {
			volatileLines.push("");
			volatileLines.push(crossThreadDigest);
		}

		// R-E20: Inject cross-thread file modification notifications (capped at 10)
		try {
			const FILE_NOTIF_CAP = 10;
			const threadFiles = db
				.query(
					"SELECT DISTINCT key FROM semantic_memory WHERE key LIKE '_internal.file_thread.%' AND deleted = 0",
				)
				.all() as Array<{ key: string }>;

			let fileNotifCount = 0;
			for (const { key } of threadFiles) {
				if (fileNotifCount >= FILE_NOTIF_CAP) break;
				const filePath = key.replace("_internal.file_thread.", "");
				const lastThread = getLastThreadForFile(db, filePath);
				if (lastThread && lastThread !== threadId) {
					const threadRow = db.query("SELECT title FROM threads WHERE id = ?").get(lastThread) as {
						title: string | null;
					} | null;
					const threadTitle = threadRow?.title || lastThread;
					volatileLines.push("");
					volatileLines.push(getFileThreadNotificationMessage(filePath, threadTitle));
					fileNotifCount++;
				}
			}
		} catch {
			// Non-fatal
		}

		// Inject active skill index (AC3.1, AC3.2)
		try {
			const activeSkills = db
				.query(
					"SELECT name, description FROM skills WHERE status = 'active' AND deleted = 0 ORDER BY last_activated_at DESC",
				)
				.all() as Array<{ name: string; description: string }>;

			if (activeSkills.length > 0) {
				volatileLines.push("");
				volatileLines.push(`SKILLS (${activeSkills.length} active):`);
				for (const s of activeSkills) {
					volatileLines.push(`  ${s.name} — ${s.description}`);
				}
			}
		} catch {
			// Non-fatal
		}

		// Inject operator retirement notifications (24h window) (AC3.6, AC3.7)
		try {
			const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
			const retiredByOperator = db
				.query(
					`SELECT name, retired_reason FROM skills
					 WHERE status = 'retired'
					   AND retired_by = 'operator'
					   AND modified_at > ?
					   AND deleted = 0`,
				)
				.all(cutoff24h) as Array<{ name: string; retired_reason: string | null }>;

			for (const s of retiredByOperator) {
				const reason = s.retired_reason ? `"${s.retired_reason}"` : "no reason given";
				volatileLines.push("");
				volatileLines.push(
					`[Skill notification] Skill '${s.name}' was retired by operator: ${reason}.`,
				);
			}
		} catch {
			// Non-fatal
		}

		// Inject inactive skill reference note (AC3.4)
		if (inactiveSkillRef) {
			volatileLines.push("");
			volatileLines.push(`Referenced skill '${inactiveSkillRef}' is not active.`);
		}

		// Capture full volatile content before adding to assembled
		allVolatileLines = [...volatileLines];
		enrichmentMessageIndex = assembled.length;
		assembled.push({
			role: "system",
			content: volatileLines.join("\n"),
		});
	}

	// Stage 5.5 (noHistory path): Inject enrichment as standalone system message for autonomous tasks
	if (noHistory) {
		enrichmentBaseline = computeBaseline(db, threadId, params.taskId, true);
		const { memoryDeltaLines: noHistDelta, taskDigestLines: noHistTasks } = buildVolatileEnrichment(
			db,
			enrichmentBaseline,
		);

		if (noHistDelta.length > 0 || noHistTasks.length > 0) {
			totalMemCount = (
				db.prepare("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0").get() as {
					c: number;
				}
			).c;

			const noHistMemChangedCount = noHistDelta.filter((l) => l.startsWith("- ")).length;
			let noHistMemHeader = `Memory: ${totalMemCount} entries`;
			if (noHistMemChangedCount > 0) {
				noHistMemHeader += ` (${noHistMemChangedCount} changed since your last run)`;
			}

			const enrichmentLines: string[] = [];
			enrichmentLines.push(noHistMemHeader);
			if (noHistDelta.length > 0) {
				enrichmentLines.push(...noHistDelta);
			}
			if (noHistTasks.length > 0) {
				enrichmentLines.push("");
				enrichmentLines.push(...noHistTasks);
			}

			enrichmentMessageIndex = assembled.length;
			assembled.push({ role: "system", content: enrichmentLines.join("\n") });
		}
	}

	// Stage 7: BUDGET_VALIDATION
	// Budget pressure check: reduce enrichment caps if headroom < 2,000 tokens
	if (enrichmentBaseline !== undefined && enrichmentMessageIndex >= 0) {
		const currentTotal = assembled.reduce((sum, msg) => {
			return sum + Math.ceil(estimateContentLength(msg.content) / 4);
		}, 0);
		const headroom = contextWindow - currentTotal;

		if (headroom < 2000) {
			const { memoryDeltaLines: shortDelta, taskDigestLines: shortDigest } =
				buildVolatileEnrichment(db, enrichmentBaseline, 3, 3);

			const shortMemChangedCount = shortDelta.filter((l) => l.startsWith("- ")).length;
			let shortMemHeader = `Memory: ${totalMemCount} entries`;
			if (shortMemChangedCount > 0) {
				shortMemHeader += !params.noHistory
					? ` (${shortMemChangedCount} changed since your last turn in this thread)`
					: ` (${shortMemChangedCount} changed since your last run)`;
			}

			// Build reduced enrichment lines
			const shortEnrichmentLines: string[] = ["", shortMemHeader];
			if (shortDelta.length > 0) {
				shortEnrichmentLines.push(...shortDelta);
			}
			if (shortDigest.length > 0) {
				shortEnrichmentLines.push("");
				shortEnrichmentLines.push(...shortDigest);
			}

			if (!params.noHistory && enrichmentStartIdx >= 0 && enrichmentEndIdx >= 0) {
				// Splice the reduced enrichment into the full volatile array, preserving
				// all post-enrichment content (cross-thread digest, file notifications, skill index, etc.)
				const rebuiltVolatile = [
					...allVolatileLines.slice(0, enrichmentStartIdx),
					...shortEnrichmentLines,
					...allVolatileLines.slice(enrichmentEndIdx),
				];
				if (enrichmentMessageIndex < assembled.length) {
					assembled[enrichmentMessageIndex] = {
						role: "system",
						content: rebuiltVolatile.join("\n"),
					};
				}
			} else if (params.noHistory) {
				// For noHistory path, standalone message — just replace with reduced
				const shortStandaloneLines: string[] = [shortMemHeader];
				if (shortDelta.length > 0) {
					shortStandaloneLines.push(...shortDelta);
				}
				if (shortDigest.length > 0) {
					shortStandaloneLines.push("");
					shortStandaloneLines.push(...shortDigest);
				}
				if (enrichmentMessageIndex < assembled.length) {
					assembled[enrichmentMessageIndex] = {
						role: "system",
						content: shortStandaloneLines.join("\n"),
					};
				}
			}
		}
	}

	// Approximate token count (rough estimate: 1 token per 4 characters)
	const totalTokens = assembled.reduce((sum, msg) => {
		return sum + Math.ceil(estimateContentLength(msg.content) / 4);
	}, 0);

	if (totalTokens > contextWindow) {
		// Truncate history from front
		const systemMessages = assembled.filter((m) => m.role === "system");
		const historyMessages = assembled.filter((m) => m.role !== "system");

		if (historyMessages.length > 0) {
			let sliceStart = Math.max(0, historyMessages.length - 10);

			// Bug #8: slicing may orphan a tool_result at the new start (its paired
			// tool_call was cut off). Advance past any leading non-user messages to
			// prevent "Expected toolResult blocks" and "conversation must start with a
			// user message" errors on Bedrock. tool_call/assistant at the head also
			// violate Bedrock's requirement that the first message must be from the user.
			while (sliceStart < historyMessages.length && historyMessages[sliceStart].role !== "user") {
				sliceStart++;
			}

			// If the forward scan exhausted all messages without finding a user (e.g. a
			// no-payload cron task that accumulated many tool_call/tool_result/assistant
			// cycles with no user message per run), fall back to the last user message
			// anywhere in the full history. This prevents returning an empty remaining
			// which causes Bedrock to error with "A conversation must start with a user
			// message."
			if (sliceStart >= historyMessages.length) {
				for (let i = historyMessages.length - 1; i >= 0; i--) {
					if (historyMessages[i].role === "user") {
						sliceStart = i;
						break;
					}
				}
			}

			const remaining = historyMessages.slice(sliceStart);
			return [...systemMessages, ...remaining];
		}
	}

	// Stage 8: METRIC_RECORDING
	// Deferred to Phase 8 when metrics.db is created

	return assembled;
}
