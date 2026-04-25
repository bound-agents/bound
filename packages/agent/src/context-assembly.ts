import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendCapabilities, ContentBlock, LLMMessage } from "@bound/llm";
import type { ContextDebugInfo, ContextSection, CrossThreadSource, Message } from "@bound/shared";
import { countContentTokens, countTokens, safeSlice } from "@bound/shared";
import { getCommandRegistry } from "./commands/registry";
import { getFileThreadNotificationMessage, getLastThreadForFile } from "./file-thread-tracker";
import { shedMemoryTiers } from "./memory-shedding.js";
import {
	type TieredEnrichment,
	buildCrossThreadDigest,
	buildVolatileEnrichment,
	computeBaseline,
} from "./summary-extraction.js";
import { TOOL_RESULT_OFFLOAD_THRESHOLD } from "./tool-result-offload";

/**
 * The cold path targets this fraction of contextWindow, leaving headroom for warm-path growth.
 * At 200k contextWindow, this leaves ~30k tokens (15%) for warm-path turns before triggering
 * high-water mark reassembly. With 10-15% underestimation by tiktoken, this also protects
 * against exceeding the model's true context limit.
 */
export const TRUNCATION_TARGET_RATIO = 0.85;

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
	/** Estimated token count for tool definitions (counted by caller since tools are at ChatParams level) */
	toolTokenEstimate?: number;
	/** When true, replaces old tool_result content (outside the recent window) with DB
	 *  retrieval pointers and injects the thread summary. Reduces context size while
	 *  keeping the compacted prefix deterministic and cache-friendly. */
	compactToolResults?: boolean;
	/** Number of recent messages to keep intact during compaction. Defaults to 20. */
	compactRecentWindow?: number;
	/** Optional system prompt addition from client connection. Appended to system suffix. */
	systemPromptAddition?: string;
}

export interface ContextAssemblyResult {
	messages: LLMMessage[];
	/** Stable system prompt (persona + orientation + skill body). Passed as the `system` param to drivers. */
	systemPrompt: string;
	debug: ContextDebugInfo;
	/** Volatile context token estimate for warm-path reuse */
	volatileTokenEstimate?: number;
}

export interface VolatileContext {
	/** Joined content string of all volatile context lines */
	content: string;
	/** Token estimate for the volatile context */
	tokenEstimate: number;
	/** Enrichment section start index for budget pressure rebuild */
	enrichmentStartIdx: number;
	/** Enrichment section end index for budget pressure rebuild */
	enrichmentEndIdx: number;
	/** Snapshot of all volatile lines for budget pressure splicing */
	allVolatileLines: string[];
	/** Memory delta lines for tier-aware shedding */
	memoryDeltaLines: string[];
	/** Task digest lines for tier-aware shedding */
	taskDigestLines: string[];
	/** Tiered enrichment structure for shedding */
	tiers?: TieredEnrichment;
	/** Cross-thread sources for debug */
	crossThreadSources?: CrossThreadSource[];
	/** Total memory count for header reconstruction */
	totalMemCount: number;
}

export function buildVolatileContext(params: {
	db: Database;
	threadId: string;
	taskId?: string;
	userId: string;
	siteId?: string;
	hostName?: string;
	currentModel?: string;
	relayInfo?: ContextParams["relayInfo"];
	platformContext?: ContextParams["platformContext"];
	systemPromptAddition?: string;
	/** Last user message text for relevance-aware memory boosting */
	userMessageText?: string;
	/** Thread summary for keyword seeding */
	threadSummary?: string;
	/** Referenced inactive skill name, if any */
	inactiveSkillRef?: string;
}): VolatileContext {
	const suffixLines: string[] = [];
	suffixLines.push(`User ID: ${params.userId}, Thread ID: ${params.threadId}`);

	// AC5.4: Model location when inference is relayed
	if (params.relayInfo) {
		suffixLines.push(
			`You are: ${params.relayInfo.model} (via ${params.relayInfo.provider} on host ${params.relayInfo.remoteHost}, relayed from ${params.relayInfo.localHost})`,
		);
	}

	// Platform silence semantics: user only sees what you explicitly send.
	if (params.platformContext) {
		const toolRef =
			params.platformContext.toolNames && params.platformContext.toolNames.length > 0
				? params.platformContext.toolNames.map((n) => `\`${n}\``).join(" or ")
				: "the platform send tool";
		suffixLines.push("");
		suffixLines.push(`## Platform Context: ${params.platformContext.platform}`);
		suffixLines.push(
			"The user of this conversation is on an external platform and cannot see your responses directly.",
		);
		suffixLines.push(
			`To send a message to the user, call ${toolRef}. If you do not call it, the user sees nothing (silence).`,
		);
		suffixLines.push(
			"Each call to the tool produces one separate message to the user. " +
				"Multiple calls are allowed and delivered in order.",
		);

		// Platform-specific formatting constraints
		if (
			params.platformContext.platform === "discord" ||
			params.platformContext.platform === "discord-interaction"
		) {
			suffixLines.push(
				"Discord formatting: **bold**, *italic*, __underline__, ~~strikethrough~~, " +
					"`inline code`, ```code blocks```, > block quotes, >>> multi-line quotes, " +
					"# ## ### headers, -# subtext, [masked links](url), ||spoilers||, " +
					"- bulleted lists (2-space indent to nest). " +
					"Tables do NOT render — use lists or code blocks instead. " +
					"Messages over 2000 characters are rejected; split long content across multiple calls.",
			);
		}
	}

	// Include current model name (moved out of orientation for cache stability)
	if (params.currentModel) {
		suffixLines.push(`Current Model: ${params.currentModel}`);
	}

	// Stage 5.5: VOLATILE ENRICHMENT (replaces raw memory dump)
	const enrichmentBaseline = computeBaseline(params.db, params.threadId, params.taskId, false);
	const {
		memoryDeltaLines,
		taskDigestLines,
		tiers: enrichmentTiers,
		graphCount,
		recencyCount,
	} = buildVolatileEnrichment(
		params.db,
		enrichmentBaseline,
		undefined,
		undefined,
		params.userMessageText,
		params.threadSummary,
	);

	// Query total memory count for the header line
	const totalMemCount = (
		params.db.prepare("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0").get() as {
			c: number;
		}
	).c;

	// Format and append enrichment, recording start/end indices
	const memChangedCount = memoryDeltaLines.filter((l) => l.startsWith("- ")).length;
	let memHeaderLine = `Memory: ${totalMemCount} entries`;
	if (graphCount !== undefined && graphCount > 0) {
		memHeaderLine += ` (${graphCount} via graph, ${recencyCount ?? 0} via recency)`;
	} else if (memChangedCount > 0) {
		memHeaderLine += ` (${memChangedCount} changed since your last turn in this thread)`;
	}

	// Record where enrichment section begins (in suffixLines)
	const enrichmentStartIdx = suffixLines.length;
	suffixLines.push("");
	suffixLines.push(memHeaderLine);
	if (memoryDeltaLines.length > 0) {
		suffixLines.push(...memoryDeltaLines);
	}
	if (taskDigestLines.length > 0) {
		suffixLines.push("");
		suffixLines.push(...taskDigestLines);
	}
	// Record where enrichment section ends
	const enrichmentEndIdx = suffixLines.length;

	// Include cross-thread digest
	let crossThreadSources: CrossThreadSource[] | undefined;
	const crossThreadResult = buildCrossThreadDigest(params.db, params.userId, params.threadId);
	if (crossThreadResult.text) {
		suffixLines.push("");
		suffixLines.push(crossThreadResult.text);
	}
	if (crossThreadResult.sources.length > 0) {
		crossThreadSources = crossThreadResult.sources;
	}

	// R-E20: Inject cross-thread file modification notifications (capped at 10)
	try {
		const FILE_NOTIF_CAP = 10;
		const threadFiles = params.db
			.query(
				"SELECT DISTINCT key FROM semantic_memory WHERE key LIKE '_internal.file_thread.%' AND deleted = 0",
			)
			.all() as Array<{ key: string }>;

		let fileNotifCount = 0;
		for (const { key } of threadFiles) {
			if (fileNotifCount >= FILE_NOTIF_CAP) break;
			const filePath = key.replace("_internal.file_thread.", "");
			const lastThread = getLastThreadForFile(params.db, filePath);
			if (lastThread && lastThread !== params.threadId) {
				const threadRow2 = params.db
					.query("SELECT title FROM threads WHERE id = ?")
					.get(lastThread) as {
					title: string | null;
				} | null;
				const threadTitle = threadRow2?.title || lastThread;
				suffixLines.push("");
				suffixLines.push(getFileThreadNotificationMessage(filePath, threadTitle));
				fileNotifCount++;
			}
		}
	} catch (_error) {
		// Non-fatal: file thread notification query failed
		// No logger available in this context
	}

	// Inject active skill index (AC3.1, AC3.2)
	try {
		const activeSkills = params.db
			.query(
				"SELECT name, description FROM skills WHERE status = 'active' AND deleted = 0 ORDER BY last_activated_at DESC",
			)
			.all() as Array<{ name: string; description: string }>;

		if (activeSkills.length > 0) {
			suffixLines.push("");
			suffixLines.push(`SKILLS (${activeSkills.length} active):`);
			for (const s of activeSkills) {
				suffixLines.push(`  ${s.name} — ${s.description}`);
			}
		}
	} catch (_error) {
		// Non-fatal: active skills query failed
		// No logger available in this context
	}

	// Inject operator retirement notifications (24h window) (AC3.6, AC3.7)
	try {
		const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const retiredByOperator = params.db
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
			suffixLines.push("");
			suffixLines.push(
				`[Skill notification] Skill '${s.name}' was retired by operator: ${reason}.`,
			);
		}
	} catch (_error) {
		// Non-fatal: retired skills query failed
		// No logger available in this context
	}

	// Inject advisory resolution notifications (24h window, capped at 5, deduped by title).
	// Closes the feedback loop so the agent knows when its advisories were acted on.
	if (params.siteId) {
		try {
			const ADVISORY_NOTIF_CAP = 5;
			const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
			const resolvedAdvisories = params.db
				.query(
					`SELECT title, status FROM advisories
					 WHERE created_by = ?
					   AND status IN ('approved', 'applied', 'dismissed')
					   AND resolved_at > ?
					   AND deleted = 0
					 ORDER BY resolved_at DESC`,
				)
				.all(params.siteId, cutoff24h) as Array<{ title: string; status: string }>;

			// Deduplicate by title — group identical titles and emit a counted line.
			const titleGroups = new Map<string, { status: string; count: number }>();
			for (const adv of resolvedAdvisories) {
				const existing = titleGroups.get(adv.title);
				if (existing) {
					existing.count++;
				} else {
					titleGroups.set(adv.title, { status: adv.status, count: 1 });
				}
			}

			let notifCount = 0;
			for (const [title, { status, count }] of titleGroups) {
				if (notifCount >= ADVISORY_NOTIF_CAP) break;
				const countStr = count > 1 ? ` (×${count})` : "";
				suffixLines.push("");
				suffixLines.push(
					`[Advisory notification] Advisory '${title}' was ${status} by operator${countStr}.`,
				);
				notifCount++;
			}
		} catch (_error) {
			// Non-fatal: resolved advisories query failed
			// No logger available in this context
		}
	}

	// Inject inactive skill reference note (AC3.4)
	if (params.inactiveSkillRef) {
		suffixLines.push("");
		suffixLines.push(`Referenced skill '${params.inactiveSkillRef}' is not active.`);
	}

	// Append systemPromptAddition if present (AC2.2)
	if (params.systemPromptAddition) {
		suffixLines.push("");
		suffixLines.push(params.systemPromptAddition);
	}

	// Capture full content for return
	const allVolatileLines = [...suffixLines];
	const content = suffixLines.join("\n");

	// Calculate token estimate
	const tokenEstimate = countTokens(content);

	return {
		content,
		tokenEstimate,
		enrichmentStartIdx,
		enrichmentEndIdx,
		allVolatileLines,
		memoryDeltaLines,
		taskDigestLines,
		tiers: enrichmentTiers,
		crossThreadSources,
		totalMemCount,
	};
}

/**
 * Estimates the character length of message content for token-budget purposes.
 * Handles both string content and ContentBlock[] content (produced by
 * substituteUnsupportedBlocks when the backend lacks vision/document support).
 * Text blocks contribute their text length; all other blocks contribute their
 * JSON-serialised length as a conservative approximation.
 * @deprecated Use countContentTokens() from @bound/shared for token counting.
 * This function returns character counts, not token counts.
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
		} catch (_error) {
			// persona.md exists but cannot be read — no logger available in this context
			// This is logged elsewhere if needed
			return null;
		}
	}

	personaCachePath = configDir;
	personaCache = null;
	return null;
}

/**
 * Formats a timestamp as a relative duration string for context annotations.
 * Returns e.g. "[5m ago]", "[2h ago]", "[3d ago]".
 * @deprecated Use formatTimestamp instead — relative timestamps bust prompt cache.
 */
export function formatRelativeTimestamp(isoTimestamp: string, now?: Date): string {
	const then = new Date(isoTimestamp).getTime();
	const nowMs = (now ?? new Date()).getTime();
	const diffMs = nowMs - then;

	if (diffMs < 0) return "[just now]";

	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return "[just now]";
	if (minutes < 60) return `[${minutes}m ago]`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `[${hours}h ago]`;

	const days = Math.floor(hours / 24);
	return `[${days}d ago]`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Formats a timestamp as an absolute short date for context annotations.
 * Cache-friendly: output is deterministic for a given input (never changes between turns).
 * Same-year: "[Apr 4, 14:30]". Different year: "[Jan 15 '25, 09:45]".
 */
export function formatTimestamp(isoTimestamp: string): string {
	const d = new Date(isoTimestamp);
	const month = MONTHS[d.getUTCMonth()];
	const day = d.getUTCDate();
	const hours = String(d.getUTCHours()).padStart(2, "0");
	const minutes = String(d.getUTCMinutes()).padStart(2, "0");

	const currentYear = new Date().getUTCFullYear();
	if (d.getUTCFullYear() !== currentYear) {
		const yearShort = String(d.getUTCFullYear()).slice(-2);
		return `[${month} ${day} '${yearShort}, ${hours}:${minutes}]`;
	}

	return `[${month} ${day}, ${hours}:${minutes}]`;
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

export function assembleContext(params: ContextParams): ContextAssemblyResult {
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

	// Debug tracking for ContextAssemblyResult
	const sections: ContextSection[] = [];
	let budgetPressure = false;
	let truncatedCount = 0;

	// Enrichment state — shared between Stage 6 volatile context and Stage 7 budget check
	let enrichmentBaseline: string | undefined;
	let enrichmentMessageIndex = -1;
	let enrichmentStartIdx = -1; // Index in volatileLines where enrichment section starts
	let enrichmentEndIdx = -1; // Index in volatileLines just after enrichment section ends
	let enrichmentTiers: TieredEnrichment | undefined; // Consumed in Phase 5 budget pressure tier-aware degradation
	let allVolatileLines: string[] = []; // Full volatile content for budget pressure rebuild
	let totalMemCount = 0;
	let taskDigestLinesSnapshot: string[] = []; // Captured from initial enrichment for budget pressure shedding

	// Stage 1: MESSAGE_RETRIEVAL
	// Cap loaded messages to avoid unbounded DB reads on massive threads.
	// Compacted messages are ~80 chars each, so 100 messages is plenty of
	// conversational structure even after compaction. Backward-fill truncation
	// (Stage 7) remains as a safety net if the loaded set still exceeds budget.
	const MESSAGE_LOAD_LIMIT = 100;
	const messages: Message[] = [];
	if (!noHistory) {
		const query = db.query(
			"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?",
		);
		const rows = query.all(threadId, MESSAGE_LOAD_LIMIT) as Message[];
		rows.reverse();
		messages.push(...rows);
	} else if (params.taskId) {
		// noHistory tasks still need the current run's injected messages (wakeup +
		// synthetic tool_call/tool_result). Load messages created at or after the
		// task's claimed_at timestamp to capture exactly this run's setup.
		const task = db.query("SELECT claimed_at FROM tasks WHERE id = ?").get(params.taskId) as {
			claimed_at: string | null;
		} | null;
		if (task?.claimed_at) {
			const rows = db
				.query(
					"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 AND created_at >= ? ORDER BY created_at ASC, rowid ASC",
				)
				.all(threadId, task.claimed_at) as Message[];
			messages.push(...rows);
		}
	}

	// Stage 1.5: RETROACTIVE_RESULT_TRUNCATION
	// Truncate oversized tool_result content in-memory (does not modify DB).
	// This is a second guard behind the agent-loop offloading: historical results
	// persisted before offloading was introduced still get capped here.
	for (const msg of messages) {
		if (msg.role === "tool_result" && msg.content.length > TOOL_RESULT_OFFLOAD_THRESHOLD) {
			const originalLength = msg.content.length;
			msg.content = `[Tool result truncated: ${originalLength} characters exceeded the ${TOOL_RESULT_OFFLOAD_THRESHOLD} char limit]
Original output was too large for the context window. If you need the full content, use: query "SELECT substr(content, 1, 2000) FROM messages WHERE id = '${msg.id}'"`;
		}
	}

	// Stage 1.7: HISTORY_COMPACTION
	// Replace old message content (outside the recent window) with DB retrieval
	// pointers. The agent can re-fetch full content via "query" if needed. Compaction
	// is deterministic (same message → same replacement), so the compacted prefix is
	// cache-friendly: assembleContext runs once per loop invocation, and the compacted
	// messages produce identical content across turns. This reduces context size
	// dramatically (e.g., 190k → 40k) while preserving conversational structure.
	// User messages and tool_call messages are kept intact; assistant and tool_result
	// messages are replaced with compact stubs.
	// Also injects the thread summary as a context anchor for compacted history.
	// The recent window preserves the last N messages intact (no tool_result
	// compaction, no thinking-block stripping). It's the agent's working memory
	// for the current turn.
	//
	// A fixed default of 20 is too large for small-context backends: on a 49K
	// window with dense tool-using threads, 20 uncompacted messages can easily
	// consume 15-20K tokens (tool_result payloads are often multi-KB each).
	// That leaves too little budget for system prompt + tools + compacted
	// history + enrichment.
	//
	// Scale with contextWindow: allot roughly one message per 2.5K tokens of
	// window, clamped to [4, 20]. So 49K → 19, 32K → 12, 16K → 6, 200K → 20
	// (still capped at the historical default — larger windows don't need
	// more recent working memory, they just tolerate it).
	if (params.compactToolResults && messages.length > 0) {
		const defaultRecentWindow = Math.max(4, Math.min(20, Math.floor(contextWindow / 2500)));
		const recentWindow = params.compactRecentWindow ?? defaultRecentWindow;
		const compactionBoundary = Math.max(0, messages.length - recentWindow);
		const COLD_COMPACTION_THRESHOLD = 500;

		// Inject thread summary if available
		const thread = db.query("SELECT summary FROM threads WHERE id = ?").get(threadId) as {
			summary: string | null;
		} | null;
		if (thread?.summary) {
			// Prepend a synthetic developer-role summary message.
			// It will be picked up naturally by later stages.
			messages.unshift({
				id: "__compaction_summary__",
				thread_id: threadId,
				role: "developer",
				content: `[Conversation context — ${compactionBoundary} earlier messages are compacted below as stubs. Use "query SELECT content FROM messages WHERE id='...'" to retrieve any specific message.]\n\n${thread.summary}`,
				model_id: null,
				tool_name: null,
				created_at: messages[0]?.created_at ?? new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: params.hostName ?? "localhost",
				deleted: 0,
			} as Message);
		}

		// Compact old tool results (everything before the recent window)
		// The boundary shifts by 1 if we prepended the summary message.
		// - tool_result: replace with pointer + short preview
		// - tool_call: strip `thinking` blocks; keep `tool_use` block(s) intact
		//   (tool_use is required for protocol-level tool_call/tool_result pairing;
		//   thinking blocks are the model's own reasoning and the model does not
		//   need to re-read its stale CoT on cold turns — the results are in
		//   tool_result). On dense task threads with extended-thinking models,
		//   this reclaims the single largest chunk of context.
		// - assistant: NOT compacted — the LLM mimics the compaction format,
		//   generating fake retrieval pointers instead of real responses
		// - user: kept intact (ground truth)
		const adjustedBoundary = thread?.summary ? compactionBoundary + 1 : compactionBoundary;
		for (let i = 0; i < adjustedBoundary; i++) {
			const msg = messages[i];
			if (msg.role === "tool_result" && msg.content.length > COLD_COMPACTION_THRESHOLD) {
				const originalLength = msg.content.length;
				const preview = safeSlice(msg.content, 0, 200).trimEnd();
				msg.content = `[Result truncated from context — ${originalLength} chars. Retrieve with: query SELECT content FROM messages WHERE id='${msg.id}']\n${preview}`;
			} else if (msg.role === "tool_call") {
				// tool_call content is stored as a JSON-serialised ContentBlock[].
				// Strip any `thinking` / `redacted_thinking` blocks, keep `tool_use`.
				// Only rewrite if the parse succeeds AND we actually dropped something;
				// otherwise leave the raw string alone (preserves non-JSON or
				// already-compact representations).
				try {
					const parsed = JSON.parse(msg.content);
					if (Array.isArray(parsed) && parsed.length > 0) {
						const kept = parsed.filter(
							(b: { type?: string }) =>
								b && b.type !== "thinking" && b.type !== "redacted_thinking",
						);
						if (kept.length > 0 && kept.length < parsed.length) {
							msg.content = JSON.stringify(kept);
						}
					}
				} catch {
					// Not JSON — leave as-is. Old rows may store plain strings.
				}
			}
		}
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
		} catch (_error) {
			// Ignore purge metadata parse errors — no logger available in this context
			// Malformed purge messages are silently skipped
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

				// Create a developer message with the purge summary
				messagesAfterPurge.push({
					id: `purge-summary-${groupIndex}`,
					thread_id: threadId,
					role: "developer",
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
		if (
			m.role === "system" &&
			!m.id.startsWith("purge-summary-") &&
			!m.id.startsWith("__compaction_")
		)
			return false;
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
			} catch (_error) {
				// Non-parseable tool_call content — fall back to unlimited scan
				// No logger available in this context
			}

			// Flag flips true once we scan past the next tool_call boundary while
			// still chasing straggler results for this tool_call's pending ids.
			let crossedToolCallBoundary = false;
			for (let j = i + 1; j < messagesFiltered.length; j++) {
				if (consumed.has(j)) continue;
				const jMsg = messagesFiltered[j];
				if (jMsg.role === "tool_call") {
					// Hit the next tool_call. Normally this closes our scan, BUT if
					// we still have unmatched tool_use_ids, a real tool_result for
					// one of them may be a "straggler" that landed AFTER the next
					// turn's tool_call (parallel tool racing: the agent loop
					// re-entered inference before the slow result came back). Keep
					// scanning past this next tool_call, but only to claim results
					// whose tool_name is in OUR pending set — we never steal results
					// that belong to the next tool_call.
					if (pendingToolUseIds.size === 0) {
						break;
					}
					crossedToolCallBoundary = true;
					continue;
				}
				if (jMsg.role === "tool_result") {
					if (crossedToolCallBoundary) {
						// After crossing a later tool_call, only claim results whose
						// tool_name is one of OUR outstanding pending ids.
						if (!jMsg.tool_name || !pendingToolUseIds.has(jMsg.tool_name)) {
							continue;
						}
					}
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
					// Don't reorder messages from past the next tool_call boundary —
					// they belong to a different turn. Only reorder system messages
					// between us and our results (the original adjacent-reorder case).
					if (crossedToolCallBoundary) {
						continue;
					}
					// Only reorder system messages, NOT assistant messages.
					// Assistant messages between tool_call and tool_result should stay
					// in place — Pass 2 will handle the structural repair. Moving
					// assistants before tool_calls corrupts conversation ordering.
					if (jMsg.role !== "assistant") {
						nonToolMessages.push(jMsg);
						nonToolIndices.push(j);
					}
					// If it IS an assistant, leave it in place — don't add to nonToolMessages
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
	// Track remaining expected tool_use_ids from the active tool_call.
	// Non-empty = tool pair is open and waiting for results.
	const activePendingIds = new Set<string>();
	// Boolean fallback for tool_calls whose content can't be parsed for IDs.
	// When true and activePendingIds is empty, the next tool_result still belongs
	// to this tool_call (legacy single-tool or malformed content).
	let inActiveToolCall = false;
	let lastToolId = "";
	let lastToolUseIds: string[] = []; // track IDs from the last tool_call for synthetic results
	let prevSanitizedRole: string | null = null;
	// Track the last synthetic tool_call injected for orphaned tool_results, so we
	// can extend it when consecutive orphans from the same multi-tool call appear.
	let lastSyntheticToolCall: Message | null = null;

	/** Extract tool_use IDs from a tool_call message's content */
	const extractToolUseIds = (content: string): string[] => {
		try {
			const blocks = JSON.parse(content);
			if (Array.isArray(blocks)) {
				return blocks
					.filter((b: { type?: string; id?: string }) => b.type === "tool_use" && b.id)
					.map((b: { id: string }) => b.id);
			}
		} catch {
			// Non-parseable content
		}
		return [];
	};

	/** Generate synthetic tool_result messages for each tool_use ID */
	const makeSyntheticResults = (
		prefix: string,
		toolUseIds: string[],
		errContent: string,
	): Message[] => {
		if (toolUseIds.length === 0) {
			// Fallback: single result with no tool_name (legacy behavior)
			return [
				{
					id: `${prefix}-${lastToolId}`,
					thread_id: threadId,
					role: "tool_result",
					content: errContent,
					model_id: null,
					tool_name: null,
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					host_origin: "local",
				},
			];
		}
		return toolUseIds.map((tuId, idx) => ({
			id: `${prefix}-${lastToolId}-${idx}`,
			thread_id: threadId,
			role: "tool_result",
			content: errContent,
			model_id: null,
			tool_name: tuId,
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			host_origin: "local",
		}));
	};

	/** Flush synthetic results for any remaining pending tool_use_ids */
	const flushPendingIds = (prefix: string, errContent: string): void => {
		if (activePendingIds.size > 0) {
			const remaining = [...activePendingIds];
			const results = makeSyntheticResults(prefix, remaining, errContent);
			for (const r of results) {
				sanitized.push(r);
			}
			activePendingIds.clear();
		}
	};

	for (const msg of reordered) {
		if (msg.role === "tool_call") {
			// Close any prior incomplete tool pair
			flushPendingIds("synthetic", "Tool execution was interrupted");
			inActiveToolCall = true;
			lastToolId = msg.id;
			lastToolUseIds = extractToolUseIds(msg.content);
			// Populate pending set — tool pair stays open until all IDs are matched
			activePendingIds.clear();
			for (const id of lastToolUseIds) activePendingIds.add(id);
			lastSyntheticToolCall = null;
			sanitized.push(msg);
			prevSanitizedRole = "tool_call";
		} else if (msg.role === "tool_result") {
			if (activePendingIds.size > 0 || inActiveToolCall) {
				// Part of active tool pair — remove matched ID from pending set
				if (msg.tool_name) activePendingIds.delete(msg.tool_name);
				inActiveToolCall = false; // first result received
				sanitized.push(msg);
				prevSanitizedRole = "tool_result";
			} else if (prevSanitizedRole === "tool_result") {
				if (lastSyntheticToolCall) {
					// Consecutive orphaned tool_result — extend the synthetic tool_call
					// with this result's tool_use_id so the Bedrock driver sees matching IDs.
					const toolUseId = msg.tool_name || `synthetic-tc-${msg.id}`;
					try {
						const blocks = JSON.parse(lastSyntheticToolCall.content);
						if (Array.isArray(blocks) && !blocks.some((b: { id?: string }) => b.id === toolUseId)) {
							blocks.push({ type: "tool_use", id: toolUseId, name: "unknown", input: {} });
							lastSyntheticToolCall.content = JSON.stringify(blocks);
						}
					} catch {
						// Non-parseable synthetic content — shouldn't happen
					}
				}
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
				const syntheticMsg: Message = {
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
				};
				lastSyntheticToolCall = syntheticMsg;
				sanitized.push(syntheticMsg);
				sanitized.push(msg);
				prevSanitizedRole = "tool_result";
			}
		} else {
			// Non-tool message — flush any remaining pending IDs first
			if (inActiveToolCall) {
				// Tool_call with no results at all — generate synthetics for ALL IDs
				const results = makeSyntheticResults(
					"synthetic",
					lastToolUseIds,
					"Tool execution was interrupted",
				);
				for (const r of results) {
					sanitized.push(r);
				}
				activePendingIds.clear();
				inActiveToolCall = false;
			} else {
				flushPendingIds("synthetic", "Tool execution was interrupted");
			}
			lastSyntheticToolCall = null;
			sanitized.push(msg);
			prevSanitizedRole = msg.role;
		}
	}

	// Close any unclosed tool pair (pending IDs remain)
	if (inActiveToolCall) {
		const results = makeSyntheticResults(
			"synthetic-close",
			lastToolUseIds,
			"Tool execution completed",
		);
		for (const r of results) {
			sanitized.push(r);
		}
	} else {
		flushPendingIds("synthetic-close", "Tool execution completed");
	}

	// Stage 4: MESSAGE_QUEUEING
	// Already handled by filtering - skip messages that were persisted during active tool-use

	// Stage 5: ANNOTATION
	// Convert Message to LLMMessage format with annotations
	// Also detect model switches between consecutive assistant messages per spec R-U11
	// Defense-in-depth: filter non-LLM roles in case any survived Stage 2.5
	const LLM_COMPATIBLE_ROLES = new Set([
		"user",
		"assistant",
		"system",
		"developer",
		"tool_call",
		"tool_result",
	]);

	// Build a map from tool_call message ID to the tool_use IDs contained within,
	// so we can propagate tool_use_id to the subsequent tool_result messages.
	// Also collect all known tool_use IDs so we can validate tool_result.tool_name
	// against actual IDs (tool_name may contain a tool name instead of an ID due
	// to historical data from before the toolCallId fix).
	const toolCallIdToToolUseId = new Map<string, string>();
	const knownToolUseIds = new Set<string>();
	for (const m of sanitized) {
		if (m.role === "tool_call") {
			try {
				const blocks = JSON.parse(m.content);
				if (Array.isArray(blocks)) {
					for (const block of blocks) {
						if (block.id) {
							knownToolUseIds.add(block.id);
						}
					}
					if (blocks.length > 0 && blocks[0].id) {
						toolCallIdToToolUseId.set(m.id, blocks[0].id);
					}
				}
			} catch (_error) {
				// Content may not be JSON (e.g. synthetic tool_call)
				// No logger available in this context
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
						role: "developer",
						content: `Model switched from ${lastAssistantModel} to ${m.model_id}`,
					});
					modelSwitchCount++;
				}
			}
			lastAssistantModel = m.model_id;
		}

		// Parse JSON ContentBlock[] strings back into arrays.
		// The DB stores image/document messages as JSON-serialized ContentBlock[].
		// Parse them here so Stage 5b substitution and drivers receive proper arrays.
		let annotatedContent: string | ContentBlock[] = m.content;
		if (
			typeof m.content === "string" &&
			(m.role === "user" || m.role === "assistant" || m.role === "tool_result")
		) {
			try {
				const parsed = JSON.parse(m.content);
				if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
					annotatedContent = parsed as ContentBlock[];
				}
			} catch (_error) {
				// Not JSON — keep as plain text string
				// No logger available in this context
			}
		}

		// Annotate user messages with absolute timestamps so the agent can
		// detect session boundaries and temporal gaps. Only user messages are
		// annotated — annotating assistant messages caused the LLM to echo
		// the timestamp format as its entire response (producing noise like
		// "[Apr 5, 07:25]" persisted as real assistant messages).
		// Uses absolute format (e.g. "[Apr 4, 14:30]") instead of relative
		// (e.g. "[5m ago]") to avoid busting the LLM prompt cache prefix.
		// Only annotate when the message is >= 1 minute old (no value for very recent).
		if (m.role === "user" && m.created_at) {
			const ageMs = Date.now() - new Date(m.created_at).getTime();
			if (ageMs >= 60_000 && typeof annotatedContent === "string") {
				const ts = formatTimestamp(m.created_at);
				annotatedContent = `${ts} ${annotatedContent}`;
			}
		}

		const msg: LLMMessage = {
			role: m.role as LLMMessage["role"],
			content: annotatedContent,
			model_id: m.model_id || undefined,
			host_origin: m.host_origin,
		};

		// Propagate tool_use_id for tool_result messages
		// In the DB, tool_name stores the tool_use_id for tool_result messages.
		// Validate that tool_name is an actual tool_use ID (not a tool name like
		// "retrieve_task" from historical data before the toolCallId fix).
		if (m.role === "tool_result") {
			const toolUseId =
				(m.tool_name && knownToolUseIds.has(m.tool_name) ? m.tool_name : null) ||
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
	// Build stable system prompt as a string (returned separately, not in messages array).
	// Drivers receive this via the `system` param, keeping it out of the message prefix.
	const systemParts: string[] = [
		"You are a helpful AI assistant. You have access to tools to help the user. " +
			"Be concise and direct in your responses.",
	];

	// Load and inject persona if it exists
	const persona = loadPersona(configDir);
	if (persona) {
		systemParts.push(persona);
	}

	// Stable orientation section: available commands, current model, host identity
	const registry = getCommandRegistry();
	const commandList = [...registry]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((c) => `  ${c.name} — ${c.description}`)
		.join("\n");
	const orientationLines: string[] = [
		"## Orientation",
		"",
		"### Available Commands",
		commandList,
		"",
		"Run `<cmd> --help` for details on any command.",
		"",
		`### Host Identity\nHost: ${hostName || "unknown"}\nSite ID: ${siteId || "unknown"}`,
	];
	systemParts.push(orientationLines.join("\n"));

	const assembled: LLMMessage[] = [];

	// Track part count before skill injection (for token tracking)
	const systemPartCountBeforeSkill = systemParts.length;

	// Track inactive skill reference for volatile context note (AC3.4)
	let inactiveSkillRef: string | undefined;

	// Inject task-referenced skill body into system prompt (AC3.3, AC3.5)
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
				} catch (_error) {
					// Malformed task payload — skip skill injection
					// No logger available in this context
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
							systemParts.push(skillMdRow.content);
						}
					} else {
						// Skill referenced but not active — note will appear in volatile context
						inactiveSkillRef = skillName;
					}
				}
			}
		} catch (_error) {
			// Non-fatal: skip skill body injection on any error
			// No logger available in this context
		}
	}

	// Build the final system prompt string
	const systemPrompt = systemParts.join("\n\n");

	// Track system section tokens (parts before skill injection)
	const systemTokens = systemParts
		.slice(0, systemPartCountBeforeSkill)
		.reduce((sum, part) => sum + countTokens(part), 0);
	sections.push({ name: "system", tokens: systemTokens });

	// Track skill section if a skill part was added
	if (systemParts.length > systemPartCountBeforeSkill) {
		const skillTokens = countTokens(systemParts[systemParts.length - 1]);
		if (skillTokens > 0) {
			sections.push({ name: "skill-context", tokens: skillTokens });
		}
	}

	// Add message history
	assembled.push(...finalAnnotated);

	// Track history section with role children
	const historyChildren: ContextSection[] = [];
	let userTokens = 0;
	let assistantTokens = 0;
	let toolResultTokens = 0;

	for (const msg of finalAnnotated) {
		const tokens = countContentTokens(msg.content);
		if (msg.role === "user") userTokens += tokens;
		else if (msg.role === "assistant" || msg.role === "tool_call") assistantTokens += tokens;
		else if (msg.role === "tool_result") toolResultTokens += tokens;
	}

	if (userTokens > 0) historyChildren.push({ name: "user", tokens: userTokens });
	if (assistantTokens > 0) historyChildren.push({ name: "assistant", tokens: assistantTokens });
	if (toolResultTokens > 0) historyChildren.push({ name: "tool_result", tokens: toolResultTokens });

	sections.push({
		name: "history",
		tokens: userTokens + assistantTokens + toolResultTokens,
		children: historyChildren.length > 0 ? historyChildren : undefined,
	});

	// Add volatile context — split into stable system message (cached) and varying suffix (uncached)
	// The suffix is returned separately so the LLM driver can place it after the cache boundary,
	// enabling cross-thread prompt cache reuse for cron tasks in the same 5-minute window.
	let crossThreadSources: CrossThreadSource[] | undefined;
	let suffixContent: string | undefined;
	if (!noHistory) {
		// --- VARYING SUFFIX: per-thread content that busts the cache ---
		// Extract latest user message for relevance-aware memory boosting
		const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
		const userMessageText = lastUserMsg?.content ?? undefined;
		// Query thread summary for broader keyword seeding
		const threadRow = db.prepare("SELECT summary FROM threads WHERE id = ?").get(threadId) as {
			summary: string | null;
		} | null;
		const threadSummary = threadRow?.summary ?? undefined;

		const volatileCtx = buildVolatileContext({
			db,
			threadId,
			taskId: params.taskId,
			userId,
			siteId,
			hostName,
			currentModel,
			relayInfo,
			platformContext,
			systemPromptAddition: params.systemPromptAddition,
			userMessageText,
			threadSummary,
			inactiveSkillRef,
		});

		// Append volatile context as developer message at tail
		assembled.push({ role: "developer", content: volatileCtx.content });

		suffixContent = volatileCtx.content;
		enrichmentBaseline = computeBaseline(db, threadId, params.taskId, false);
		enrichmentTiers = volatileCtx.tiers;
		crossThreadSources = volatileCtx.crossThreadSources;
		enrichmentStartIdx = volatileCtx.enrichmentStartIdx;
		enrichmentEndIdx = volatileCtx.enrichmentEndIdx;
		allVolatileLines = volatileCtx.allVolatileLines;
		totalMemCount = volatileCtx.totalMemCount;
		taskDigestLinesSnapshot = volatileCtx.taskDigestLines;

		// Track volatile section tokens (memory, task-digest, volatile-other)
		// These now live in the developer message but are still tracked for debug
		const memoryLines = volatileCtx.allVolatileLines.slice(
			volatileCtx.enrichmentStartIdx,
			volatileCtx.enrichmentEndIdx,
		);
		const memoryTokens = memoryLines.length > 0 ? countTokens(memoryLines.join("\n")) : 0;

		const taskDigestTokens =
			volatileCtx.taskDigestLines.length > 0
				? countTokens(volatileCtx.taskDigestLines.join("\n"))
				: 0;

		const totalVolatileTokens = volatileCtx.tokenEstimate;
		const volatileOtherTokens = totalVolatileTokens - memoryTokens - taskDigestTokens;

		if (memoryTokens > 0) sections.push({ name: "memory", tokens: memoryTokens });
		if (taskDigestTokens > 0) sections.push({ name: "task-digest", tokens: taskDigestTokens });
		if (volatileOtherTokens > 0)
			sections.push({ name: "volatile-other", tokens: volatileOtherTokens });
	}

	// Stage 5.5 (noHistory path): Inject enrichment as standalone system message for autonomous tasks
	if (noHistory) {
		enrichmentBaseline = computeBaseline(db, threadId, params.taskId, true);
		const {
			memoryDeltaLines: noHistDelta,
			taskDigestLines: noHistTasks,
			tiers: enrichmentTiersL2,
		} = buildVolatileEnrichment(db, enrichmentBaseline);
		enrichmentTiers = enrichmentTiersL2;
		taskDigestLinesSnapshot = noHistTasks;

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

			// Append systemPromptAddition if present (AC2.2 for noHistory path)
			if (params.systemPromptAddition) {
				enrichmentLines.push("");
				enrichmentLines.push(params.systemPromptAddition);
			}

			enrichmentMessageIndex = assembled.length;
			assembled.push({ role: "developer", content: enrichmentLines.join("\n") });

			// Track noHistory volatile section tokens (memory, task-digest)
			const noHistMemTokens = noHistDelta.length > 0 ? countTokens(noHistDelta.join("\n")) : 0;
			const noHistTaskTokens = noHistTasks.length > 0 ? countTokens(noHistTasks.join("\n")) : 0;

			if (noHistMemTokens > 0) sections.push({ name: "memory", tokens: noHistMemTokens });
			if (noHistTaskTokens > 0) sections.push({ name: "task-digest", tokens: noHistTaskTokens });
		}
	}

	// Track tools section (from ContextParams)
	const toolTokens = params.toolTokenEstimate ?? 0;
	if (toolTokens > 0) sections.push({ name: "tools", tokens: toolTokens });

	// Stage 7: BUDGET_VALIDATION
	// Budget pressure check: reduce enrichment caps if headroom < 2,000 tokens.
	// Use non-history token count (system msgs + tools) so that long threads
	// with truncation don't permanently trigger budget pressure. History overflow
	// is handled by truncation — budget pressure should only fire when the
	// fixed-size context (system prompt, volatile enrichment, tools) genuinely
	// crowds the window.

	// Helper to apply reduced enrichment to the assembled context or developer message
	const applyReducedEnrichment = (shortDelta: string[], shortDigest: string[]): void => {
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

		// Find and update the developer message at the tail
		let devIdx = -1;
		for (let i = assembled.length - 1; i >= 0; i--) {
			if (assembled[i].role === "developer") {
				devIdx = i;
				break;
			}
		}
		if (devIdx >= 0) {
			if (!params.noHistory && enrichmentStartIdx >= 0 && enrichmentEndIdx >= 0) {
				// Splice the reduced enrichment into the developer message, preserving
				// all post-enrichment content (cross-thread digest, file notifications, skill index, etc.)
				const rebuiltContent = [
					...allVolatileLines.slice(0, enrichmentStartIdx),
					...shortEnrichmentLines,
					...allVolatileLines.slice(enrichmentEndIdx),
				];
				assembled[devIdx] = { role: "developer", content: rebuiltContent.join("\n") };
			} else if (params.noHistory) {
				// For noHistory path, just replace with reduced
				const shortStandaloneLines: string[] = [shortMemHeader];
				if (shortDelta.length > 0) {
					shortStandaloneLines.push(...shortDelta);
				}
				if (shortDigest.length > 0) {
					shortStandaloneLines.push("");
					shortStandaloneLines.push(...shortDigest);
				}
				assembled[devIdx] = {
					role: "developer",
					content: shortStandaloneLines.join("\n"),
				};
			}
		}

		// Re-count memory and task-digest sections after budget pressure rebuild
		// Find and update the memory, task-digest, and volatile-other entries in sections
		const shortMemTokens = shortDelta.length > 0 ? countTokens(shortDelta.join("\n")) : 0;
		const shortTaskTokens = shortDigest.length > 0 ? countTokens(shortDigest.join("\n")) : 0;
		const preEnrichmentTokens =
			enrichmentStartIdx > 0
				? countTokens(allVolatileLines.slice(0, enrichmentStartIdx).join("\n"))
				: 0;
		const postEnrichmentTokens =
			enrichmentEndIdx < allVolatileLines.length
				? countTokens(allVolatileLines.slice(enrichmentEndIdx).join("\n"))
				: 0;
		const shortVolatileOtherTokens =
			!params.noHistory && enrichmentStartIdx >= 0 && enrichmentEndIdx >= 0
				? Math.max(0, preEnrichmentTokens + postEnrichmentTokens)
				: 0;

		// Update sections array to reflect new token counts
		for (let i = 0; i < sections.length; i++) {
			if (sections[i].name === "memory") {
				sections[i] = { ...sections[i], tokens: shortMemTokens };
			} else if (sections[i].name === "task-digest") {
				sections[i] = { ...sections[i], tokens: shortTaskTokens };
			} else if (sections[i].name === "volatile-other") {
				sections[i] = { ...sections[i], tokens: shortVolatileOtherTokens };
			}
		}
	};

	if (
		enrichmentBaseline !== undefined &&
		(suffixContent !== undefined || enrichmentMessageIndex >= 0)
	) {
		const systemTokens = assembled
			.filter((m) => m.role === "system")
			.reduce((sum, m) => sum + countContentTokens(m.content), 0);
		const suffixTokens = suffixContent ? countTokens(suffixContent) : 0;
		const nonHistoryTokens = systemTokens + suffixTokens + toolTokens;
		const headroom = contextWindow - nonHistoryTokens;

		if (headroom < 2000) {
			budgetPressure = true;

			if (enrichmentTiers) {
				// Tier-aware shedding (Phase 5) — operates on structured data, no DB call
				const shedResult = shedMemoryTiers(enrichmentTiers, taskDigestLinesSnapshot);
				// Note: shedResult.warning indicates L0+L1 alone exceed budget threshold (AC5.4).
				// No truncation occurs — operator visibility deferred to future logging layer.
				applyReducedEnrichment(shedResult.memoryDeltaLines, shedResult.taskDigestLines);
			} else {
				// Fallback: no tiers available (shouldn't happen after Phase 4, but defensive)
				const { memoryDeltaLines: shortDelta, taskDigestLines: shortDigest } =
					buildVolatileEnrichment(db, enrichmentBaseline, 3, 3);
				applyReducedEnrichment(shortDelta, shortDigest);
			}
		}
	}

	// Token count estimate via tiktoken cl100k_base encoding.
	// IMPORTANT: include every component the server will bill against the
	// context window — messages, system suffix, AND tool schemas. Omitting
	// tools here was the root cause of multi-K overshoots on small-context
	// backends: the gate saw ~content-only~ tokens, decided "fits", and
	// shipped a payload that exceeded the real limit by exactly the tool
	// schema size.
	const suffixTokensForBudget = suffixContent ? countTokens(suffixContent) : 0;
	const toolTokensForBudget = params.toolTokenEstimate ?? 0;
	const totalTokens =
		assembled.reduce((sum, msg) => {
			return sum + countContentTokens(msg.content);
		}, 0) +
		suffixTokensForBudget +
		toolTokensForBudget;

	if (totalTokens > contextWindow) {
		// Truncate history from front — token-aware backward fill.
		// Instead of keeping a hardcoded last-N messages, we fill from the end
		// until we hit the remaining token budget. This ensures recent conversations
		// survive even when bulky tool exchanges sit between them.
		//
		// CACHE-FRIENDLY HEADROOM: target 85% of contextWindow so that truncation
		// fires infrequently. Each truncation shifts the message prefix, breaking
		// Bedrock/Anthropic's automatic prefix caching. By leaving ~15% headroom,
		// the prefix stays stable for ~10-20 turns between truncations, enabling
		// 90%+ cache hit rates on long threads. Additionally, tiktoken cl100k_base
		// underestimates Claude's actual token count by ~10-15%, so the headroom
		// also prevents the actual context from exceeding the model's limit.
		const truncationTarget = Math.floor(contextWindow * TRUNCATION_TARGET_RATIO);

		const systemMessages = assembled.filter((m) => m.role === "system");
		const historyMessages = assembled.filter((m) => m.role !== "system");

		if (historyMessages.length > 0) {
			const systemTokens = systemMessages.reduce(
				(sum, m) => sum + countContentTokens(m.content),
				0,
			);
			const toolTokens = params.toolTokenEstimate ?? 0;
			const historyBudget = Math.max(0, truncationTarget - systemTokens - toolTokens);

			// Walk backwards from end, accumulating tokens until we exceed budget
			let accumulatedTokens = 0;
			let sliceStart = historyMessages.length; // start at end (include nothing)
			for (let i = historyMessages.length - 1; i >= 0; i--) {
				const msgTokens = countContentTokens(historyMessages[i].content);
				if (accumulatedTokens + msgTokens > historyBudget) break;
				accumulatedTokens += msgTokens;
				sliceStart = i;
			}

			// Floor: keep at least 2 messages so the agent has something to work with
			sliceStart = Math.min(sliceStart, Math.max(0, historyMessages.length - 2));

			// Advance past orphaned tool_result/tool_call/assistant at the boundary
			// to start at a clean user message when possible.
			const preAdvanceStart = sliceStart;
			while (sliceStart < historyMessages.length && historyMessages[sliceStart].role !== "user") {
				sliceStart++;
			}

			// Fallback: if no user found in forward scan (e.g. scheduled task threads
			// with only system wakeup + tool_call/tool_result/assistant cycles), try
			// the last user message, or fall back to the original budget-based start.
			// The Bedrock driver handles the user-message-first requirement itself.
			if (sliceStart >= historyMessages.length) {
				let foundUser = false;
				for (let i = historyMessages.length - 1; i >= 0; i--) {
					if (historyMessages[i].role === "user") {
						sliceStart = i;
						foundUser = true;
						break;
					}
				}
				// No user messages at all — restore budget-based start so we don't
				// discard all history. Bedrock driver prepends a placeholder user msg.
				if (!foundUser) {
					sliceStart = preAdvanceStart;
				}
			}

			const remaining = historyMessages.slice(sliceStart);
			truncatedCount = historyMessages.length - remaining.length;

			// Inject truncation marker so the agent knows context was lost
			const truncationMarker: LLMMessage[] = [];
			if (truncatedCount > 0) {
				// Count total messages in the thread for the marker
				const totalRow = params.db
					.prepare(
						"SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND role IN ('user','assistant','tool_call','tool_result')",
					)
					.get(params.threadId) as { count: number } | null;
				const totalInThread = totalRow?.count ?? historyMessages.length;

				// Include thread summary if available — preserves gist of truncated history
				const threadRow = params.db
					.prepare("SELECT summary FROM threads WHERE id = ?")
					.get(params.threadId) as { summary: string | null } | null;
				const summarySection = threadRow?.summary
					? `\n\nSummary of earlier conversation:\n${threadRow.summary}`
					: "";

				truncationMarker.push({
					role: "developer",
					content: `[Context note: ${truncatedCount} earlier messages in this conversation were truncated to fit the context window. This thread has ${totalInThread} total messages. You are seeing only the most recent portion. If you need to reference earlier context, you can use the query command to search the messages table, e.g.: query "SELECT role, substr(content, 1, 200), created_at FROM messages WHERE thread_id = '${params.threadId}' ORDER BY created_at DESC LIMIT 50"]${summarySection}`,
				});
			}

			const truncatedMessages = [...systemMessages, ...truncationMarker, ...remaining];

			// Recalculate history section tokens from the KEPT messages, not the
			// pre-truncation total. Without this, context_debug reports wildly inflated
			// token counts (e.g. 3M instead of 5k when thousands of messages were dropped).
			if (truncatedCount > 0) {
				let postTruncUserTokens = 0;
				let postTruncAssistantTokens = 0;
				let postTruncToolResultTokens = 0;
				for (const msg of remaining) {
					const tokens = countContentTokens(msg.content);
					if (msg.role === "user") postTruncUserTokens += tokens;
					else if (msg.role === "assistant" || msg.role === "tool_call")
						postTruncAssistantTokens += tokens;
					else if (msg.role === "tool_result") postTruncToolResultTokens += tokens;
				}

				const histIdx = sections.findIndex((s) => s.name === "history");
				if (histIdx >= 0) {
					const postTruncChildren: Array<{ name: string; tokens: number }> = [];
					if (postTruncUserTokens > 0)
						postTruncChildren.push({ name: "user", tokens: postTruncUserTokens });
					if (postTruncAssistantTokens > 0)
						postTruncChildren.push({ name: "assistant", tokens: postTruncAssistantTokens });
					if (postTruncToolResultTokens > 0)
						postTruncChildren.push({ name: "tool_result", tokens: postTruncToolResultTokens });

					sections[histIdx] = {
						name: "history",
						tokens: postTruncUserTokens + postTruncAssistantTokens + postTruncToolResultTokens,
						children: postTruncChildren.length > 0 ? postTruncChildren : undefined,
					};
				}
			}

			const totalEstimated = sections.reduce((sum, s) => sum + s.tokens, 0);

			return {
				messages: truncatedMessages,
				systemPrompt,
				...(suffixContent !== undefined
					? { volatileTokenEstimate: countTokens(suffixContent) }
					: {}),
				debug: {
					contextWindow: contextWindow,
					totalEstimated,
					model: params.currentModel ?? "unknown",
					sections,
					budgetPressure,
					truncated: truncatedCount,
					...(crossThreadSources ? { crossThreadSources } : {}),
				},
			};
		}
	}

	// Stage 8: METRIC_RECORDING
	// Deferred to Phase 8 when metrics.db is created

	const totalEstimated = sections.reduce((sum, s) => sum + s.tokens, 0);

	return {
		messages: assembled,
		systemPrompt,
		...(suffixContent !== undefined ? { volatileTokenEstimate: countTokens(suffixContent) } : {}),
		debug: {
			contextWindow: contextWindow,
			totalEstimated,
			model: params.currentModel ?? "unknown",
			sections,
			budgetPressure,
			truncated: truncatedCount,
			...(crossThreadSources ? { crossThreadSources } : {}),
		},
	};
}
