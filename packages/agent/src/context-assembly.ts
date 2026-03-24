import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMMessage } from "@bound/llm";
import type { Message } from "@bound/shared";
import { getFileThreadNotificationMessage, getLastThreadForFile } from "./file-thread-tracker";
import { buildCrossThreadDigest } from "./summary-extraction.js";

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
// Static list of available built-in commands with brief descriptions
const AVAILABLE_COMMANDS = [
	{ name: "query", description: "Execute a SELECT query against the database" },
	{ name: "memorize", description: "Store a key-value memory entry" },
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
	} = params;

	// Stage 1: MESSAGE_RETRIEVAL
	const messages: Message[] = [];
	if (!noHistory) {
		const query = db.query(
			"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
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
			// Look ahead for the matching tool_result
			let matchIdx = -1;
			const interleaved: Message[] = [];
			const interleavedIndices: number[] = [];

			for (let j = i + 1; j < messagesFiltered.length; j++) {
				if (consumed.has(j)) continue;
				if (messagesFiltered[j].role === "tool_result") {
					matchIdx = j;
					break;
				}
				if (messagesFiltered[j].role === "tool_call") {
					// Another tool_call before finding tool_result - stop looking
					break;
				}
				// Non-tool message between tool_call and tool_result
				interleaved.push(messagesFiltered[j]);
				interleavedIndices.push(j);
			}

			if (matchIdx !== -1) {
				// Move interleaved messages before the tool_call
				for (const m of interleaved) {
					reordered.push(m);
				}
				for (const idx of interleavedIndices) {
					consumed.add(idx);
				}
				consumed.add(matchIdx);
				// Push tool_call immediately followed by tool_result
				reordered.push(msg);
				reordered.push(messagesFiltered[matchIdx]);
			} else {
				// No matching tool_result found - push tool_call as-is (handled in pass 2)
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

	for (const msg of reordered) {
		if (msg.role === "tool_call") {
			inActiveTool = true;
			lastToolId = msg.id;
			sanitized.push(msg);
		} else if (msg.role === "tool_result") {
			if (inActiveTool) {
				sanitized.push(msg);
				inActiveTool = false;
			} else {
				// Orphaned tool_result - inject synthetic tool_call first
				sanitized.push({
					id: `synthetic-${msg.id}`,
					thread_id: threadId,
					role: "tool_call",
					content: '{"tool_name":"unknown","input":{}}',
					model_id: null,
					tool_name: "unknown",
					created_at: msg.created_at,
					modified_at: msg.modified_at,
					host_origin: msg.host_origin,
				});
				sanitized.push(msg);
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
			}
			sanitized.push(msg);
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

		// Check for model switch on assistant messages
		if (m.role === "assistant" && m.model_id) {
			if (lastAssistantModel && lastAssistantModel !== m.model_id) {
				// Inject model switch notification
				annotated.push({
					role: "system",
					content: `Model switched from ${lastAssistantModel} to ${m.model_id}`,
				});
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

	// Add message history
	assembled.push(...annotated);

	// Add volatile context at the end per spec R-U30
	if (!noHistory) {
		const volatileLines: string[] = [];
		volatileLines.push(`User ID: ${userId}, Thread ID: ${threadId}`);

		// Include current model name
		if (currentModel) {
			volatileLines.push(`Current Model: ${currentModel}`);
		}

		// Include semantic memory entries
		const semanticMemories = db
			.query(
				"SELECT key, value FROM semantic_memory WHERE deleted = 0 ORDER BY modified_at DESC LIMIT 10",
			)
			.all() as Array<{ key: string; value: string }>;

		if (semanticMemories.length > 0) {
			volatileLines.push("");
			volatileLines.push("Semantic Memory:");
			for (const mem of semanticMemories) {
				volatileLines.push(`  ${mem.key}: ${mem.value}`);
			}
		}

		// Include cross-thread digest
		const crossThreadDigest = buildCrossThreadDigest(db, userId);
		if (crossThreadDigest) {
			volatileLines.push("");
			volatileLines.push(crossThreadDigest);
		}

		// R-E20: Inject cross-thread file modification notifications
		try {
			const threadFiles = db
				.query(
					"SELECT DISTINCT key FROM semantic_memory WHERE key LIKE '_internal.file_thread.%' AND deleted = 0",
				)
				.all() as Array<{ key: string }>;

			for (const { key } of threadFiles) {
				const filePath = key.replace("_internal.file_thread.", "");
				const lastThread = getLastThreadForFile(db, filePath);
				if (lastThread && lastThread !== threadId) {
					const threadRow = db.query("SELECT title FROM threads WHERE id = ?").get(lastThread) as {
						title: string | null;
					} | null;
					const threadTitle = threadRow?.title || lastThread;
					volatileLines.push("");
					volatileLines.push(getFileThreadNotificationMessage(filePath, threadTitle));
				}
			}
		} catch {
			// Non-fatal
		}

		assembled.push({
			role: "system",
			content: volatileLines.join("\n"),
		});
	}

	// Stage 7: BUDGET_VALIDATION
	// Approximate token count (rough estimate: 1 token per 4 characters)
	const totalTokens = assembled.reduce((sum, msg) => {
		const contentLength = typeof msg.content === "string" ? msg.content.length : 0;
		return sum + Math.ceil(contentLength / 4);
	}, 0);

	if (totalTokens > contextWindow) {
		// Truncate history from front
		const systemMessages = assembled.filter((m) => m.role === "system");
		const historyMessages = assembled.filter((m) => m.role !== "system");

		if (historyMessages.length > 0) {
			const remaining = historyMessages.slice(Math.max(0, historyMessages.length - 10));
			return [...systemMessages, ...remaining];
		}
	}

	// Stage 8: METRIC_RECORDING
	// Deferred to Phase 8 when metrics.db is created

	return assembled;
}
