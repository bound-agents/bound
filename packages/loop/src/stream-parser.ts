import type { LLMFinishReason, StreamChunk } from "@bound/llm";

export interface ParsedToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	argsJson: string;
	/** True when the tool_use args JSON failed to parse, usually due to output truncation. */
	truncated?: boolean;
}

export interface ParsedResponse {
	textContent: string;
	thinking: string | null;
	thinkingSignature: string | null;
	thinkingRedactedData: string | null;
	thinkingEncryptedContent: string | null;
	toolCalls: ParsedToolCall[];
	finishReason: LLMFinishReason | null;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheWriteTokens: number | null;
		cacheReadTokens: number | null;
		usageEstimated: boolean;
	};
	costUsdFromHub: number | null;
}

export interface StreamParserLogger {
	warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface ParseResponseChunksOptions {
	logger?: StreamParserLogger;
	duplicateIdFactory?: (originalId: string) => string;
}

function defaultDuplicateIdFactory(originalId: string): string {
	return `${originalId}-dedup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function parseResponseChunks(
	chunks: StreamChunk[],
	options: ParseResponseChunksOptions = {},
): ParsedResponse {
	const logger = options.logger;
	const duplicateIdFactory = options.duplicateIdFactory ?? defaultDuplicateIdFactory;
	const seenIds = new Set<string>();
	const idRemap = new Map<string, string>();
	const remappedChunks = chunks.map((chunk) => {
		if (chunk.type === "tool_use_start") {
			if (seenIds.has(chunk.id)) {
				const newId = duplicateIdFactory(chunk.id);
				logger?.warn("[agent-loop] Duplicate tool-use ID detected in turn, reassigning", {
					originalId: chunk.id,
					newId,
				});
				idRemap.set(chunk.id, newId);
				seenIds.add(newId);
				return { ...chunk, id: newId };
			}
			seenIds.add(chunk.id);
		} else if (chunk.type === "tool_use_args" || chunk.type === "tool_use_end") {
			const remappedId = idRemap.get(chunk.id);
			if (remappedId) {
				return { ...chunk, id: remappedId };
			}
		}
		return chunk;
	});

	let textContent = "";
	let thinkingContent = "";
	let thinkingSignature: string | null = null;
	let thinkingRedactedData: string | null = null;
	let thinkingEncryptedContent: string | null = null;
	const toolCalls: ParsedToolCall[] = [];
	const argsAccumulator = new Map<string, string>();
	const nameMap = new Map<string, string>();
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheWriteTokens: number | null = null;
	let cacheReadTokens: number | null = null;
	let usageEstimated = false;
	let costUsdFromHub: number | null = null;
	let finishReason: LLMFinishReason | null = null;

	for (const chunk of remappedChunks) {
		switch (chunk.type) {
			case "text":
				textContent += chunk.content;
				break;
			case "thinking":
				thinkingContent += chunk.content;
				if (chunk.signature) thinkingSignature = chunk.signature;
				if (chunk.redacted_data) thinkingRedactedData = chunk.redacted_data;
				if (chunk.reasoning_encrypted_content) {
					thinkingEncryptedContent = chunk.reasoning_encrypted_content;
				}
				break;
			case "tool_use_start":
				argsAccumulator.set(chunk.id, "");
				nameMap.set(chunk.id, chunk.name);
				break;
			case "tool_use_args": {
				const existing = argsAccumulator.get(chunk.id) ?? "";
				argsAccumulator.set(chunk.id, existing + chunk.partial_json);
				break;
			}
			case "tool_use_end": {
				const rawArgs = argsAccumulator.get(chunk.id);
				const fullArgsJson = rawArgs && rawArgs.length > 0 ? rawArgs : "{}";
				const name = nameMap.get(chunk.id) ?? chunk.id;
				let input: Record<string, unknown> = {};
				let truncated = false;
				try {
					input = JSON.parse(fullArgsJson);
				} catch {
					truncated = true;
					logger?.warn(
						`[agent-loop] Failed to parse tool_use args for "${name}" (id=${chunk.id}), ` +
							`args length=${fullArgsJson.length}. Output likely truncated by max_tokens limit.`,
					);
				}
				toolCalls.push({
					id: chunk.id,
					name,
					input,
					argsJson: fullArgsJson,
					truncated,
				});
				break;
			}
			case "done":
				inputTokens = chunk.usage.input_tokens;
				outputTokens = chunk.usage.output_tokens;
				cacheWriteTokens = chunk.usage.cache_write_tokens;
				cacheReadTokens = chunk.usage.cache_read_tokens;
				usageEstimated = chunk.usage.estimated;
				costUsdFromHub = chunk.cost_usd ?? null;
				finishReason = chunk.finish_reason ?? null;
				break;
			case "error":
				logger?.warn("[agent-loop] Stream error chunk in response", {
					error: chunk.error,
				});
				break;
			case "heartbeat":
				break;
			default: {
				const _exhaustive: never = chunk;
				void _exhaustive;
			}
		}
	}

	return {
		textContent,
		thinking: thinkingContent || null,
		thinkingSignature,
		thinkingRedactedData,
		thinkingEncryptedContent,
		toolCalls: dropSupersededToolCallDrafts(toolCalls),
		finishReason,
		usage: {
			inputTokens,
			outputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			usageEstimated,
		},
		costUsdFromHub,
	};
}

export function dropSupersededToolCallDrafts<T extends ParsedToolCall>(calls: T[]): T[] {
	if (calls.length < 2) return calls;

	// Drafts can only supersede calls with the same tool name. Grouping avoids
	// comparing unrelated calls: tool-heavy turns with distinct names used to
	// pay O(n²) here after every streamed response.
	const callsByTool = new Map<string, Array<{ call: T; index: number }>>();
	const emptyCountsByTool = new Map<string, number>();
	for (let index = 0; index < calls.length; index++) {
		const call = calls[index];
		const group = callsByTool.get(call.name);
		if (group) group.push({ call, index });
		else callsByTool.set(call.name, [{ call, index }]);
		if (isEmptyObjectCall(call)) {
			emptyCountsByTool.set(call.name, (emptyCountsByTool.get(call.name) ?? 0) + 1);
		}
	}

	const keep = calls.map(() => true);
	for (const [name, group] of callsByTool) {
		const emptySameToolCount = emptyCountsByTool.get(name) ?? 0;
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				if (isSupersededToolCallDraft(group[i].call, group[j].call, emptySameToolCount)) {
					keep[group[i].index] = false;
					break;
				}
			}
		}
	}
	return calls.filter((_, index) => keep[index]);
}

function isSupersededToolCallDraft(
	earlier: ParsedToolCall,
	later: ParsedToolCall,
	emptySameToolCount: number,
): boolean {
	if (earlier.name !== later.name) return false;
	if (later.truncated) return false;

	const earlierArgs = earlier.argsJson.trim();
	const laterArgs = later.argsJson.trim();
	if (earlier.truncated && (earlierArgs === "" || laterArgs.startsWith(earlierArgs))) {
		return true;
	}

	return emptySameToolCount > 1 && isEmptyObjectCall(earlier) && !isEmptyObjectCall(later);
}

function isEmptyObjectCall(call: ParsedToolCall): boolean {
	return !call.truncated && call.argsJson.trim() === "{}" && Object.keys(call.input).length === 0;
}
