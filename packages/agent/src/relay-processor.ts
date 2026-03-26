import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { markProcessed, readUnprocessed, recordRelayCycle, writeOutbox } from "@bound/core";
import type {
	CacheWarmPayload,
	ErrorPayload,
	Logger,
	PromptInvokePayload,
	RelayConfig,
	RelayInboxEntry,
	RelayOutboxEntry,
	ResourceReadPayload,
	ResultPayload,
	ToolCallPayload,
} from "@bound/shared";
import type { InferenceRequestPayload, StreamChunk, StreamChunkPayload } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { MCPClient } from "./mcp-client.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface IdempotencyCacheEntry {
	response: string;
	expiresAt: number;
}

export class RelayProcessor {
	private stopped = false;
	private idempotencyCache = new Map<string, IdempotencyCacheEntry>();
	private pendingCancels = new Set<string>();
	private activeInferenceStreams = new Map<string, AbortController>();

	constructor(
		private db: Database,
		private siteId: string,
		private mcpClients: Map<string, MCPClient>,
		private modelRouter: ModelRouter | null,
		private keyringSiteIds: Set<string>,
		private logger: Logger,
		private relayConfig?: RelayConfig,
	) {}

	start(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): { stop: () => void } {
		this.stopped = false;
		const tick = async () => {
			if (this.stopped) return;
			try {
				await this.processPendingEntries();
				this.pruneIdempotencyCache();
			} catch (error) {
				this.logger.error("Relay processor tick failed", { error });
			}
			if (!this.stopped) {
				setTimeout(tick, pollIntervalMs);
			}
		};
		setTimeout(tick, pollIntervalMs);
		return {
			stop: () => {
				this.stopped = true;
			},
		};
	}

	private async processPendingEntries(): Promise<void> {
		const entries = readUnprocessed(this.db);
		if (entries.length === 0) return;

		// First pass: collect cancels to check against pending requests
		for (const entry of entries) {
			if (entry.kind === "cancel" && entry.ref_id) {
				this.pendingCancels.add(entry.ref_id);
				markProcessed(this.db, [entry.id]);
			}
		}

		// Second pass: process non-cancel entries
		for (const entry of entries) {
			if (entry.kind === "cancel") continue;
			await this.processEntry(entry);
		}
	}

	private async processEntry(entry: RelayInboxEntry): Promise<void> {
		try {
			// Step 1: Validate requester (keyring check)
			if (!this.keyringSiteIds.has(entry.source_site_id)) {
				this.writeResponse(
					entry,
					"error",
					JSON.stringify({
						error: `Unknown source site: ${entry.source_site_id}`,
						retriable: false,
					} as ErrorPayload),
				);
				markProcessed(this.db, [entry.id]);
				return;
			}

			// Step 2: Check expiry (AC9.2)
			const now = new Date();
			if (new Date(entry.expires_at) < now) {
				// Discard without execution
				markProcessed(this.db, [entry.id]);
				return;
			}

			// Step 3: Check cancel (AC7.3)
			if (this.pendingCancels.has(entry.id)) {
				// Skip execution, just mark as processed
				markProcessed(this.db, [entry.id]);
				this.pendingCancels.delete(entry.id);
				return;
			}

			// Step 4: Idempotency check (AC5.1, AC5.3)
			if (entry.idempotency_key) {
				const cached = this.idempotencyCache.get(entry.idempotency_key);
				if (cached && cached.expiresAt > Date.now()) {
					// Cache hit - return cached response
					this.writeResponse(entry, "result", cached.response);
					markProcessed(this.db, [entry.id]);
					return;
				}
				// Cache expired or not found, proceed with execution
				if (cached) {
					this.idempotencyCache.delete(entry.idempotency_key);
				}
			}

			// Step 5: Execute based on kind
			const executionStartTime = Date.now();
			let response: string | null;
			try {
				switch (entry.kind) {
					case "tool_call": {
						const payload = JSON.parse(entry.payload) as ToolCallPayload;
						response = await this.executeToolCall(payload);
						break;
					}
					case "resource_read": {
						const payload = JSON.parse(entry.payload) as ResourceReadPayload;
						response = await this.executeResourceRead(payload);
						break;
					}
					case "prompt_invoke": {
						const payload = JSON.parse(entry.payload) as PromptInvokePayload;
						response = await this.executePromptInvoke(payload);
						break;
					}
					case "cache_warm": {
						const payload = JSON.parse(entry.payload) as CacheWarmPayload;
						response = await this.executeCacheWarm(entry, payload);
						break;
					}
					default:
						throw new Error(`Unknown request kind: ${entry.kind}`);
				}
			} catch (executionError) {
				// Step 5b: Handle execution errors
				const errorResponse: ErrorPayload = {
					error: String(executionError),
					retriable: true,
				};
				response = JSON.stringify(errorResponse);
				this.writeResponse(entry, "error", response);
				markProcessed(this.db, [entry.id]);
				// Record relay cycle for error
				const executionMs = Date.now() - executionStartTime;
				try {
					recordRelayCycle(this.db, {
						direction: "inbound",
						peer_site_id: entry.source_site_id,
						kind: entry.kind,
						delivery_method: "sync",
						latency_ms: executionMs,
						expired: false,
						success: false,
					});
				} catch {
					// Non-fatal if metrics recording fails
				}
				return;
			}

			// Step 6: Write response (null means handler already wrote chunks)
			if (response !== null) {
				this.writeResponse(entry, "result", response);
			}

			// Step 7: Cache result if idempotency key is set (AC5.1)
			if (entry.idempotency_key && response !== null) {
				this.idempotencyCache.set(entry.idempotency_key, {
					response,
					expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
				});
			}

			// Step 8: Mark processed
			markProcessed(this.db, [entry.id]);

			// Step 9: Record relay cycle metrics
			const executionMs = Date.now() - executionStartTime;
			try {
				recordRelayCycle(this.db, {
					direction: "inbound",
					peer_site_id: entry.source_site_id,
					kind: entry.kind,
					delivery_method: "sync",
					latency_ms: executionMs,
					expired: false,
					success: true,
				});
			} catch {
				// Non-fatal if metrics recording fails
			}
		} catch (error) {
			this.logger.error("Error processing relay entry", { error, entryId: entry.id });
			markProcessed(this.db, [entry.id]);
		}
	}

	private async executeToolCall(payload: ToolCallPayload): Promise<string> {
		// Find the MCP client that has this tool
		// Tool names are formatted as "serverName-toolName"
		const parts = payload.tool.split("-");
		if (parts.length < 2) {
			throw new Error(`Invalid tool name format: ${payload.tool}`);
		}

		// Try to find matching client by iterating and checking listTools
		let toolFound: MCPClient | null = null;
		for (const client of this.mcpClients.values()) {
			try {
				const tools = await client.listTools();
				if (tools.some((t) => t.name === payload.tool)) {
					toolFound = client;
					break;
				}
			} catch {
				// Skip this client if listTools fails
			}
		}

		if (!toolFound) {
			throw new Error(`Tool not found: ${payload.tool}`);
		}

		const result = await toolFound.callTool(payload.tool, payload.args);
		const resultPayload: ResultPayload = {
			stdout: result.content,
			stderr: result.isError ? result.content : "",
			exit_code: result.isError ? 1 : 0,
			execution_ms: 0,
		};
		return JSON.stringify(resultPayload);
	}

	private async executeResourceRead(payload: ResourceReadPayload): Promise<string> {
		// Try to find a client that can read this resource
		// Iterate through clients and try readResource
		let lastError: Error | null = null;
		for (const client of this.mcpClients.values()) {
			try {
				const resource = await client.readResource(payload.resource_uri);
				const resultPayload: ResultPayload = {
					stdout: resource.content,
					stderr: "",
					exit_code: 0,
					execution_ms: 0,
				};
				return JSON.stringify(resultPayload);
			} catch (error) {
				lastError = error as Error;
			}
		}

		throw lastError || new Error(`Could not read resource: ${payload.resource_uri}`);
	}

	private async executePromptInvoke(payload: PromptInvokePayload): Promise<string> {
		// Prompt names typically include server prefix (e.g., "server-name:prompt-name")
		// Try each client
		let lastError: Error | null = null;
		for (const client of this.mcpClients.values()) {
			try {
				const result = await client.invokePrompt(
					payload.prompt_name,
					payload.prompt_args as Record<string, string>,
				);
				const resultPayload: ResultPayload = {
					stdout: result.messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
					stderr: "",
					exit_code: 0,
					execution_ms: 0,
				};
				return JSON.stringify(resultPayload);
			} catch (error) {
				lastError = error as Error;
			}
		}

		throw lastError || new Error(`Could not invoke prompt: ${payload.prompt_name}`);
	}

	private async executeCacheWarm(
		entry: RelayInboxEntry | RelayOutboxEntry,
		payload: CacheWarmPayload,
	): Promise<string | null> {
		// Read files from paths and return content
		// If combined response exceeds max_payload_bytes, split into per-file results
		const maxPayloadBytes = this.relayConfig?.max_payload_bytes ?? 1024 * 1024;
		const fileContents: Array<{ path: string; content: string }> = [];

		for (const path of payload.paths) {
			try {
				const content = readFileSync(path, "utf-8");
				fileContents.push({ path, content });
			} catch (error) {
				fileContents.push({ path, content: `[Error reading ${path}: ${String(error)}]` });
			}
		}

		// Check if we need to split based on payload size
		const combinedContent = fileContents.map((fc) => fc.content).join("\n---FILE_SEPARATOR---\n");
		const combinedPayload: ResultPayload = {
			stdout: combinedContent,
			stderr: "",
			exit_code: 0,
			execution_ms: 0,
		};
		const combinedSize = JSON.stringify(combinedPayload).length;

		// If combined response is within limit, return as single response
		if (combinedSize <= maxPayloadBytes) {
			return JSON.stringify(combinedPayload);
		}

		// Otherwise, split into per-file responses and write them separately
		// Each response has the same ref_id, final chunk marked with complete:true
		for (let i = 0; i < fileContents.length; i++) {
			const fc = fileContents[i];
			const isLastChunk = i === fileContents.length - 1;
			const resultPayload: ResultPayload & { complete?: boolean } = {
				stdout: fc.content,
				stderr: "",
				exit_code: 0,
				execution_ms: 0,
				complete: isLastChunk,
			};
			const responseStr = JSON.stringify(resultPayload);

			// Write each chunk to outbox
			this.writeResponse(entry, "result", responseStr);
		}

		// All chunks already written to outbox — signal caller to skip writeResponse
		return null;
	}

	private writeResponse(
		requestEntry: RelayInboxEntry | RelayOutboxEntry,
		kind: "result" | "error",
		payload: string,
	): void {
		const now = new Date();
		const targetSiteId = requestEntry.source_site_id;
		if (!targetSiteId) {
			throw new Error("Request entry has no source_site_id");
		}
		writeOutbox(this.db, {
			id: randomUUID(),
			source_site_id: this.siteId,
			target_site_id: targetSiteId,
			kind,
			ref_id: requestEntry.id,
			idempotency_key: null,
			stream_id: requestEntry.stream_id ?? null,
			payload,
			created_at: now.toISOString(),
			expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
		});
	}

	private pruneIdempotencyCache(): void {
		const now = Date.now();
		for (const [key, value] of this.idempotencyCache) {
			if (value.expiresAt <= now) {
				this.idempotencyCache.delete(key);
			}
		}
	}

	/**
	 * Execute a relay request immediately and return results without writing to outbox.
	 * Used for hub-local execution to return results in the same sync response.
	 * Applies the same validation and execution pipeline as processEntry().
	 */
	public async executeImmediate(
		request: RelayOutboxEntry,
		_hubSiteId: string,
	): Promise<RelayInboxEntry[]> {
		const results: RelayInboxEntry[] = [];

		try {
			// Step 1: Validate requester (keyring check)
			if (request.source_site_id && !this.keyringSiteIds.has(request.source_site_id)) {
				const errorResponse: ErrorPayload = {
					error: `Unknown source site: ${request.source_site_id}`,
					retriable: false,
				};
				results.push(this.createResultEntry(request, "error", JSON.stringify(errorResponse)));
				return results;
			}

			// Step 2: Check expiry (AC9.2)
			const now = new Date();
			if (new Date(request.expires_at) < now) {
				// Discard without returning anything
				return results;
			}

			// Step 3: Check cancel (AC7.3)
			if (this.pendingCancels.has(request.id)) {
				// Skip execution, return nothing
				this.pendingCancels.delete(request.id);
				return results;
			}

			// Step 4: Idempotency check (AC5.1, AC5.3)
			if (request.idempotency_key) {
				const cached = this.idempotencyCache.get(request.idempotency_key);
				if (cached && cached.expiresAt > Date.now()) {
					// Cache hit - return cached response
					results.push(this.createResultEntry(request, "result", cached.response));
					return results;
				}
				// Cache expired or not found, proceed with execution
				if (cached) {
					this.idempotencyCache.delete(request.idempotency_key);
				}
			}

			// Step 5: Execute based on kind
			let response: string | null;
			try {
				switch (request.kind) {
					case "tool_call": {
						const payload = JSON.parse(request.payload) as ToolCallPayload;
						response = await this.executeToolCall(payload);
						break;
					}
					case "resource_read": {
						const payload = JSON.parse(request.payload) as ResourceReadPayload;
						response = await this.executeResourceRead(payload);
						break;
					}
					case "prompt_invoke": {
						const payload = JSON.parse(request.payload) as PromptInvokePayload;
						response = await this.executePromptInvoke(payload);
						break;
					}
					case "cache_warm": {
						const payload = JSON.parse(request.payload) as CacheWarmPayload;
						response = await this.executeCacheWarm(request, payload);
						break;
					}
					default:
						throw new Error(`Unknown request kind: ${request.kind}`);
				}
			} catch (executionError) {
				// Step 5b: Handle execution errors
				const errorResponse: ErrorPayload = {
					error: String(executionError),
					retriable: true,
				};
				response = JSON.stringify(errorResponse);
				results.push(this.createResultEntry(request, "error", response));
				return results;
			}

			// Step 6: Return result (null means chunks were written directly to outbox)
			if (response !== null) {
				results.push(this.createResultEntry(request, "result", response));
			}

			// Step 7: Cache result if idempotency key is set (AC5.1)
			if (request.idempotency_key && response !== null) {
				this.idempotencyCache.set(request.idempotency_key, {
					response,
					expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
				});
			}

			return results;
		} catch (error) {
			this.logger.error("Error executing immediate relay request", { error, entryId: request.id });
			const errorResponse: ErrorPayload = {
				error: String(error),
				retriable: true,
			};
			results.push(this.createResultEntry(request, "error", JSON.stringify(errorResponse)));
			return results;
		}
	}

	private createResultEntry(
		requestEntry: RelayInboxEntry | RelayOutboxEntry,
		kind: "result" | "error",
		payload: string,
	): RelayInboxEntry {
		return {
			id: randomUUID(),
			source_site_id: this.siteId,
			kind,
			ref_id: requestEntry.id,
			idempotency_key: null,
			stream_id: requestEntry.stream_id ?? null,
			payload,
			expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
			received_at: new Date().toISOString(),
			processed: 0,
		};
	}
}
