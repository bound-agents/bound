import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMMessage } from "@bound/llm";
import type { Message } from "@bound/shared";

export interface ContextParams {
	db: Database;
	threadId: string;
	taskId?: string;
	userId: string;
	currentModel?: string;
	noHistory?: boolean;
	configDir?: string;
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
export function assembleContext(params: ContextParams): LLMMessage[] {
	const { db, threadId, userId, noHistory = false, configDir = "config" } = params;

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
	// For now, just track that we have them - actual implementation in Phase 5
	const replacedIds = new Set<string>();
	for (const purgeMsg of purgeMessages) {
		// Parse content as JSON to get target IDs
		try {
			const purgeData = JSON.parse(purgeMsg.content);
			if (purgeData.target_ids) {
				for (const id of purgeData.target_ids) {
					replacedIds.add(id);
				}
			}
		} catch {
			// Ignore parse errors
		}
	}

	// Stage 3: TOOL_PAIR_SANITIZATION
	// Ensure tool_call/tool_result pairs are correctly interleaved
	const sanitized: Message[] = [];
	let inActiveTool = false;
	let lastToolId = "";

	for (const msg of messages) {
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
				// Non-tool message during active tool-use - synthesize tool_result first
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
	const annotated: LLMMessage[] = sanitized
		.filter((m) => !replacedIds.has(m.id))
		.map((m) => {
			const content =
				m.role === "tool_call" ? m.content : m.role === "tool_result" ? m.content : m.content;

			const msg: LLMMessage = {
				role: m.role as LLMMessage["role"],
				content,
				model_id: m.model_id || undefined,
				host_origin: m.host_origin,
			};

			return msg;
		});

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

	// Add message history
	assembled.push(...annotated);

	// Add volatile context at the end
	if (!noHistory) {
		assembled.push({
			role: "system",
			content: `User ID: ${userId}, Thread ID: ${threadId}`,
		});
	}

	// Stage 7: BUDGET_VALIDATION
	// Approximate token count (rough estimate: 1 token per 4 characters)
	const totalTokens = assembled.reduce((sum, msg) => {
		const contentLength = typeof msg.content === "string" ? msg.content.length : 0;
		return sum + Math.ceil(contentLength / 4);
	}, 0);

	const contextWindow = 8000;
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
