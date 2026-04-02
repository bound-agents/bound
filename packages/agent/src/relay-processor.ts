import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type AppContext,
	insertInbox,
	markDelivered,
	markProcessed,
	pruneRelayTables,
	readUndelivered,
	readUnprocessed,
	recordRelayCycle,
	writeOutbox,
} from "@bound/core";
import type { InferenceRequestPayload, StreamChunk, StreamChunkPayload } from "@bound/llm";
import type { ModelRouter } from "@bound/llm";
import type {
	CacheWarmPayload,
	ErrorPayload,
	EventBroadcastPayload,
	EventMap,
	IntakePayload,
	Logger,
	Message,
	PlatformDeliverPayload,
	ProcessPayload,
	PromptInvokePayload,
	RelayConfig,
	RelayInboxEntry,
	RelayOutboxEntry,
	ResourceReadPayload,
	ResultPayload,
	StatusForwardPayload,
	ToolCallPayload,
	TypedEventEmitter,
} from "@bound/shared";
import { RELAY_REQUEST_KINDS, RELAY_RESPONSE_KINDS } from "@bound/shared";
import { AgentLoop } from "./agent-loop.js";
import type { MCPClient } from "./mcp-client.js";
import type { AgentLoopConfig } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface IdempotencyCacheEntry {
	response: string;
	expiresAt: number;
}

/** Minimal interface for connector registry — avoids cross-package dep. */
interface ConnectorRegistry {
	getConnector(platform: string):
		| {
				getPlatformTools?(
					threadId: string,
					readFileFn?: (path: string) => Promise<Uint8Array>,
				): Map<
					string,
					{
						toolDefinition: {
							type: "function";
							function: { name: string; description: string; parameters: Record<string, unknown> };
						};
						execute: (input: Record<string, unknown>) => Promise<string>;
					}
				>;
		  }
		| undefined;
}

export class RelayProcessor {
	private stopped = false;
	private idempotencyCache = new Map<string, IdempotencyCacheEntry>();
	private pendingCancels = new Set<string>();
	private activeInferenceStreams = new Map<string, AbortController>();
	private readonly threadAffinityMap: Map<string, string>;
	private platformConnectorRegistry: ConnectorRegistry | null = null;
	private fileReader?: (path: string) => Promise<Uint8Array>;

	constructor(
		private db: Database,
		private siteId: string,
		private mcpClients: Map<string, MCPClient>,
		private modelRouter: ModelRouter | null,
		private keyringSiteIds: Set<string>,
		private logger: Logger,
		private eventBus: TypedEventEmitter,
		private appCtx: AppContext | null = null,
		private relayConfig?: RelayConfig,
		threadAffinityMap: Map<string, string> = new Map(),
		private agentLoopFactory?: (config: AgentLoopConfig) => AgentLoop,
	) {
		this.threadAffinityMap = threadAffinityMap;
	}

	/** Inject the agent loop factory after startup completes (avoids circular init order). */
	setAgentLoopFactory(factory: (config: AgentLoopConfig) => AgentLoop): void {
		this.agentLoopFactory = factory;
	}

	/** Inject the platform connector registry after startup completes (avoids circular init order). */
	setPlatformConnectorRegistry(registry: ConnectorRegistry): void {
		this.platformConnectorRegistry = registry;
	}

	/** Inject the file reader (e.g. ClusterFs.readFileBuffer) for virtual FS support in platform tools. */
	setFileReader(fn: (path: string) => Promise<Uint8Array>): void {
		this.fileReader = fn;
	}

	start(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): { stop: () => void } {
		this.stopped = false;
		let tickCount = 0;
		const PRUNE_EVERY_N_TICKS = Math.max(1, Math.round(60_000 / pollIntervalMs));
		const tick = async () => {
			if (this.stopped) return;
			try {
				await this.processPendingEntries();
				this.pruneIdempotencyCache();
				// Periodically prune old processed relay entries (~every 60s)
				if (++tickCount % PRUNE_EVERY_N_TICKS === 0) {
					pruneRelayTables(this.db);
				}
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
		// Local loopback: deliver self-targeted outbox entries in single-host mode.
		// In single-host setups (no sync hub configured), relay_outbox entries targeting
		// this host are never delivered via the sync relay phase. We handle them here:
		//   - REQUEST kinds (intake, process, etc.) → insert into relay_inbox for processing
		//   - RESPONSE kinds (result, error, stream_chunk, etc.) → just mark delivered; they
		//     are callbacks from a prior request and do not need re-processing on this host.
		const allSelfOutbox = readUndelivered(this.db, this.siteId);
		if (allSelfOutbox.length > 0) {
			const now = new Date().toISOString();
			const requestKindSet = new Set<string>(RELAY_REQUEST_KINDS);
			for (const entry of allSelfOutbox) {
				if (requestKindSet.has(entry.kind)) {
					insertInbox(this.db, {
						id: randomUUID(),
						source_site_id: entry.source_site_id ?? this.siteId,
						kind: entry.kind,
						ref_id: entry.id,
						idempotency_key: entry.idempotency_key,
						stream_id: entry.stream_id ?? null,
						payload: entry.payload,
						expires_at: entry.expires_at,
						received_at: now,
						processed: 0,
					});
				}
				// Response kinds are silently marked delivered — they are acknowledged by
				// being discarded (no cross-host requester to notify in single-host mode).
			}
			markDelivered(
				this.db,
				allSelfOutbox.map((e) => e.id),
			);
		}

		const entries = readUnprocessed(this.db);
		if (entries.length === 0) return;

		// First pass: collect cancels to check against pending requests
		for (const entry of entries) {
			if (entry.kind === "cancel" && entry.ref_id) {
				this.pendingCancels.add(entry.ref_id);
				// Immediately abort any active inference stream for this ref_id
				const abortController = this.activeInferenceStreams.get(entry.ref_id);
				if (abortController) {
					abortController.abort();
				}
				markProcessed(this.db, [entry.id]);
			}
		}

		// Second pass: process non-cancel entries
		for (const entry of entries) {
			if (entry.kind === "cancel") continue;
			await this.processEntry(entry);
		}
	}

	private static readonly RESPONSE_KIND_SET = new Set<string>(RELAY_RESPONSE_KINDS);

	private async processEntry(entry: RelayInboxEntry): Promise<void> {
		try {
			// Step 0: Skip response kinds (result, error, stream_chunk, etc.)
			// These are callbacks from prior requests — consumed by RELAY_WAIT
			// polling in the agent loop, not re-processed here. Without this
			// guard, "error" kind entries generate "Unknown request kind: error"
			// errors which amplify into an infinite loop (see March 28 incident).
			if (RelayProcessor.RESPONSE_KIND_SET.has(entry.kind)) {
				markProcessed(this.db, [entry.id]);
				return;
			}

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
					case "inference": {
						const inferencePayload = JSON.parse(entry.payload) as InferenceRequestPayload;
						// inference is handled asynchronously — executeInference() writes
						// stream_chunk/stream_end outbox entries directly and returns null
						this.executeInference(entry, inferencePayload).catch((err) => {
							this.logger.error("executeInference failed", { error: err, entryId: entry.id });
						});
						// Return null to skip the single writeResponse() call below
						response = null;
						break;
					}
					case "process": {
						const processPayload = JSON.parse(entry.payload) as ProcessPayload;
						// Fire-and-forget: executeProcess() runs the agent loop asynchronously
						this.executeProcess(entry, processPayload).catch((err) => {
							this.logger.error("executeProcess failed", { error: err, entryId: entry.id });
						});
						response = null; // Chunks written directly
						break;
					}
					case "status_forward": {
						const fwdPayload = JSON.parse(entry.payload) as StatusForwardPayload;
						// Emit locally so the web server can cache and serve it.
						this.eventBus.emit("status:forward", fwdPayload);
						response = null;
						break;
					}
					case "intake": {
						const payload = JSON.parse(entry.payload) as IntakePayload;
						const idempotencyKey = `intake:${payload.platform}:${payload.platform_event_id}`;

						// Dedup: check idempotency cache (same cache already used by other relay kinds)
						const cached2 = this.idempotencyCache.get(idempotencyKey);
						if (cached2 && cached2.expiresAt > Date.now()) {
							// Duplicate — silently discard
							response = null;
							break;
						}
						this.idempotencyCache.set(idempotencyKey, {
							response: "",
							expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
						});

						// Select routing target
						const targetSiteId = this.selectIntakeHost(payload.thread_id);
						if (!targetSiteId) {
							this.logger.warn("relay-processor", {
								msg: "intake: no eligible host found, dropping",
							});
							response = null;
							break;
						}

						// Write process signal to the selected host
						const processOutboxId = randomUUID();
						writeOutbox(this.db, {
							id: processOutboxId,
							source_site_id: entry.source_site_id,
							target_site_id: targetSiteId,
							kind: "process",
							ref_id: entry.id,
							idempotency_key: `process:${entry.id}`,
							stream_id: null,
							payload: JSON.stringify({
								thread_id: payload.thread_id,
								message_id: payload.message_id,
								user_id: payload.user_id,
								platform: payload.platform,
							} satisfies ProcessPayload),
							created_at: new Date().toISOString(),
							expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
						});

						this.eventBus.emit("sync:trigger", { reason: "intake-routed" });
						response = null;
						break;
					}

					case "platform_deliver": {
						const payload = JSON.parse(entry.payload) as PlatformDeliverPayload;
						this.eventBus.emit("platform:deliver", payload);
						response = null;
						break;
					}

					case "event_broadcast": {
						const payload = JSON.parse(entry.payload) as EventBroadcastPayload;
						// Fire the named event locally. Include __relay_event_depth field for relay tracking.
						this.eventBus.emit(
							payload.event_name as keyof EventMap,
							{
								...payload.event_payload,
								__relay_event_depth: payload.event_depth,
							} as never,
						);
						response = null;
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
		// Under the subcommand dispatch model:
		// payload.tool = server name (e.g., "github")
		// payload.args = { subcommand: "create_issue", ...toolArgs }
		// The subcommand is dispatched to the appropriate MCP server.

		const serverName = payload.tool;
		const client = this.mcpClients.get(serverName);
		if (!client) {
			throw new Error(`MCP server not found: ${serverName}`);
		}

		// Extract subcommand from args
		const subcommand = payload.args.subcommand;
		if (typeof subcommand !== "string" || subcommand.trim().length === 0) {
			throw new Error(`Missing or invalid subcommand in args for server: ${serverName}`);
		}

		// Strip subcommand from args before calling
		const { subcommand: _, ...toolArgs } = payload.args;

		const result = await client.callTool(subcommand, toolArgs);
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

	private writeStreamChunk(
		requestEntry: RelayInboxEntry,
		kind: "stream_chunk" | "stream_end",
		streamId: string,
		seq: number,
		chunks: StreamChunk[],
	): void {
		if (!requestEntry.source_site_id) return;
		const chunkPayload: StreamChunkPayload = { chunks, seq };
		const now = new Date();
		const outboxEntry: Omit<RelayOutboxEntry, "delivered"> = {
			id: randomUUID(),
			source_site_id: this.siteId,
			target_site_id: requestEntry.source_site_id,
			kind,
			ref_id: requestEntry.id,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify(chunkPayload),
			created_at: now.toISOString(),
			expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(), // 10 min expiry for chunks
		};
		writeOutbox(this.db, outboxEntry);
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
	 * Select the best host to process an intake message.
	 * Tiers (in order): thread affinity → model match → tool match → least-loaded fallback.
	 */
	private selectIntakeHost(threadId: string): string | null {
		// Tier 1: Thread affinity — use host that most recently processed this thread
		const affinityHost = this.threadAffinityMap.get(threadId);
		if (affinityHost) {
			try {
				const alive = this.db
					.query<{ site_id: string }, [string]>(
						"SELECT site_id FROM hosts WHERE site_id = ? AND deleted = 0",
					)
					.get(affinityHost);
				if (alive) return alive.site_id;
			} catch {
				// Table missing or other error — fall through
			}
			// Affinity host gone — fall through
		}

		// Tier 2: Model match — find a host that supports the model last used in this thread
		try {
			const lastModel = this.db
				.query<{ model_id: string | null }, [string]>(
					"SELECT model_id FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
				)
				.get(threadId);

			if (lastModel?.model_id) {
				const hosts = this.db
					.query<{ site_id: string; models: string }, []>(
						"SELECT site_id, models FROM hosts WHERE deleted = 0 AND models IS NOT NULL",
					)
					.all();
				for (const host of hosts) {
					const models = JSON.parse(host.models) as string[];
					if (models.includes(lastModel.model_id)) return host.site_id;
				}
			}
		} catch {
			// turns table missing or other error — fall through
		}

		// Tier 3: Tool match — find the host with the most tools matching this thread's tool usage.
		// Uses the tool_name column on messages (populated for role='tool' result messages).
		let threadTools: string[] = [];
		try {
			threadTools = this.db
				.query<{ tool_name: string }, [string]>(
					`SELECT DISTINCT tool_name
					 FROM messages
					 WHERE thread_id = ? AND role = 'tool' AND tool_name IS NOT NULL
					 LIMIT 50`,
				)
				.all(threadId)
				.map((r) => r.tool_name);
		} catch {
			// messages table missing or other error — fall through
		}

		if (threadTools.length > 0) {
			const hosts = this.db
				.query<{ site_id: string; mcp_tools: string | null }, []>(
					"SELECT site_id, mcp_tools FROM hosts WHERE deleted = 0",
				)
				.all();

			let bestHost: string | null = null;
			let bestScore = 0;
			for (const host of hosts) {
				if (!host.mcp_tools) continue;
				let hostToolNames: string[];
				try {
					hostToolNames = JSON.parse(host.mcp_tools);
				} catch {
					this.logger.warn(
						`selectIntakeHost Tier 3: Skipping host ${host.site_id} with corrupted mcp_tools`,
					);
					continue;
				}
				const score = threadTools.filter((t) => hostToolNames.includes(t)).length;
				if (score > bestScore) {
					bestScore = score;
					bestHost = host.site_id;
				}
			}
			if (bestHost) return bestHost;
		}

		// Tier 4: Least-loaded fallback — host with fewest pending relay_outbox entries
		const loaded = this.db
			.query<{ site_id: string; depth: number }, []>(
				`SELECT h.site_id, COUNT(o.id) AS depth
				 FROM hosts h
				 LEFT JOIN relay_outbox o ON o.target_site_id = h.site_id AND o.delivered = 0
				 WHERE h.deleted = 0
				 GROUP BY h.site_id
				 ORDER BY depth ASC
				 LIMIT 1`,
			)
			.get();
		return loaded?.site_id ?? null;
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

			// Step 2b: Skip inference kind (handled asynchronously by target's polling loop)
			// inference kind is handled asynchronously by the target's background polling loop,
			// not synchronously in the hub relay phase
			if (request.kind === "inference") {
				return []; // hub routes to inbox; target's RelayProcessor handles it
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

	private async executeInference(
		entry: RelayInboxEntry,
		payload: InferenceRequestPayload,
	): Promise<void> {
		const FLUSH_INTERVAL_MS = 200;
		const FLUSH_BUFFER_BYTES = 4096;

		// stream_id comes from the inbox entry (set by the requester in RELAY_STREAM)
		const streamId = entry.stream_id;
		if (!streamId) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: "Missing stream_id on inference request", retriable: false }),
			);
			return;
		}

		// Check model availability
		if (!this.modelRouter) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: "No model router configured on this host", retriable: false }),
			);
			return;
		}

		const backend = this.modelRouter.tryGetBackend(payload.model);
		if (!backend) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({
					error: `Model not available on this host: ${payload.model}`,
					retriable: false,
				}),
			);
			return;
		}

		// Resolve large prompt file ref if present (AC1.9)
		let messages = payload.messages;
		if (payload.messages_file_ref) {
			const fileRow = this.db
				.query("SELECT content FROM files WHERE path = ? AND deleted = 0")
				.get(payload.messages_file_ref) as { content: string } | null;
			if (!fileRow) {
				this.writeResponse(
					entry,
					"error",
					JSON.stringify({
						error: `Large prompt file not found: ${payload.messages_file_ref}`,
						retriable: false,
					}),
				);
				return;
			}
			try {
				messages = JSON.parse(fileRow.content);
			} catch {
				this.writeResponse(
					entry,
					"error",
					JSON.stringify({ error: "Failed to parse large prompt file", retriable: false }),
				);
				return;
			}
		}

		// AC4.3: Record relay cycle for inference request receipt
		try {
			recordRelayCycle(this.db, {
				direction: "inbound",
				peer_site_id: entry.source_site_id,
				kind: "inference",
				delivery_method: "sync",
				latency_ms: null, // not known yet at request start
				expired: false,
				success: true,
			});
		} catch {
			// Non-fatal
		}
		// Set up AbortController for cancel support (AC3.4)
		const abortController = new AbortController();
		this.activeInferenceStreams.set(entry.id, abortController);

		let seq = 0;
		let chunkBuffer: StreamChunk[] = [];
		let bufferBytes = 0;
		let lastFlushTime = Date.now();
		const inferenceStartTime = Date.now();

		const flush = (isFinal: boolean): void => {
			if (chunkBuffer.length === 0 && !isFinal) return;
			const kind = isFinal ? "stream_end" : "stream_chunk";
			this.writeStreamChunk(entry, kind, streamId, seq, [...chunkBuffer]);
			// Record relay cycle for each flush
			try {
				recordRelayCycle(this.db, {
					direction: "inbound",
					peer_site_id: entry.source_site_id,
					kind,
					delivery_method: "sync",
					latency_ms: Date.now() - inferenceStartTime,
					expired: false,
					success: true,
				});
			} catch {
				// Non-fatal
			}
			seq++;
			chunkBuffer = [];
			bufferBytes = 0;
			lastFlushTime = Date.now();
		};

		try {
			const chatStream = backend.chat({
				model: payload.model,
				messages,
				tools: payload.tools,
				system: payload.system,
				max_tokens: payload.max_tokens,
				temperature: payload.temperature,
				cache_breakpoints: payload.cache_breakpoints,
				signal: abortController.signal,
			});

			for await (const chunk of chatStream) {
				// AC3.4: Check abort signal (cancel from requester)
				if (abortController.signal.aborted) break;

				chunkBuffer.push(chunk);
				const chunkBytes = new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
				bufferBytes += chunkBytes;

				const elapsed = Date.now() - lastFlushTime;
				if (elapsed >= FLUSH_INTERVAL_MS || bufferBytes >= FLUSH_BUFFER_BYTES) {
					flush(false);
				}
			}

			if (abortController.signal.aborted) {
				// AC3.4: Write error response indicating cancellation
				this.writeResponse(
					entry,
					"error",
					JSON.stringify({ error: "cancelled by requester", retriable: false }),
				);
			} else {
				// Normal completion — final flush as stream_end (AC3.3)
				flush(true);
			}
		} catch (err) {
			this.writeResponse(entry, "error", JSON.stringify({ error: String(err), retriable: true }));
			try {
				recordRelayCycle(this.db, {
					direction: "inbound",
					peer_site_id: entry.source_site_id,
					kind: "inference",
					delivery_method: "sync",
					latency_ms: Date.now() - inferenceStartTime,
					expired: false,
					success: false,
				});
			} catch {
				// Non-fatal
			}
		} finally {
			this.activeInferenceStreams.delete(entry.id);
		}
	}

	private async executeProcess(entry: RelayInboxEntry, payload: ProcessPayload): Promise<void> {
		if (!this.modelRouter) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: "No model router configured", retriable: false }),
			);
			return;
		}

		// Look up user message
		const userMessage = this.db
			.query("SELECT * FROM messages WHERE id = ? AND thread_id = ? AND deleted = 0")
			.get(payload.message_id, payload.thread_id) as Message | null;

		if (!userMessage) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: `Message not found: ${payload.message_id}`, retriable: false }),
			);
			return;
		}

		// For the delegated AgentLoop, we need the full AppContext passed to RelayProcessor
		if (!this.appCtx) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({
					error: "AppContext not available for delegated loop execution",
					retriable: false,
				}),
			);
			return;
		}

		const delegatedCtx = this.appCtx;

		// Emit status_forward on each state change
		const emitStatusForward = (status: string, detail: string | null, tokens: number): void => {
			const fwdPayload: StatusForwardPayload = {
				thread_id: payload.thread_id,
				status,
				detail,
				tokens,
			};
			const outboxEntry = {
				id: randomUUID(),
				source_site_id: this.siteId,
				target_site_id: entry.source_site_id,
				kind: "status_forward" as const,
				ref_id: entry.id,
				idempotency_key: null,
				stream_id: null,
				payload: JSON.stringify(fwdPayload),
				created_at: new Date().toISOString(),
				expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
			};
			try {
				writeOutbox(this.db, outboxEntry);
				this.eventBus.emit("sync:trigger", { reason: "status-forward" });
			} catch {
				// Non-fatal
			}
		};

		emitStatusForward("thinking", null, 0);

		try {
			// Use the provided factory (which has sandbox + tools) when available.
			// Falls back to a sandbox-less loop for true cross-host delegation where
			// this host intentionally runs without the originating host's sandbox.
			const loopConfig: AgentLoopConfig = {
				threadId: payload.thread_id,
				userId: payload.user_id,
				taskId: `delegated-${entry.id}`,
			};

			// Inject platform tools when running in a platform context
			if (payload.platform && this.platformConnectorRegistry) {
				const connector = this.platformConnectorRegistry.getConnector(payload.platform);
				if (connector?.getPlatformTools) {
					const platformTools = connector.getPlatformTools(payload.thread_id, this.fileReader);
					loopConfig.platform = payload.platform;
					loopConfig.platformTools = platformTools;
				}
			}

			const agentLoop = this.agentLoopFactory
				? this.agentLoopFactory(loopConfig)
				: new AgentLoop(
						delegatedCtx,
						{
							/* sandbox not available — no tools in context */
						} as object,
						this.modelRouter,
						loopConfig,
					);

			const result = await agentLoop.run();
			emitStatusForward("idle", null, 0);

			if (result.error) {
				this.writeResponse(
					entry,
					"error",
					JSON.stringify({ error: result.error, retriable: false }),
				);
			} else {
				this.writeResponse(entry, "result", JSON.stringify({ success: true }));

				// Look up thread interface once — used for both platform-context typing-stop
				// and the legacy auto-deliver path.
				const thread = this.db
					.query<{ interface: string }, [string]>(
						"SELECT interface FROM threads WHERE id = ? AND deleted = 0 LIMIT 1",
					)
					.get(payload.thread_id);

				if (payload.platform) {
					// Platform-context process: agent calls discord_send_message explicitly.
					// Always emit platform:deliver with empty content to stop the typing
					// indicator, regardless of whether the agent produced any text.
					// deliver() calls stopTyping() before checking content, so an empty-
					// content emit stops typing without sending a Discord message.
					if (thread && thread.interface !== "web") {
						this.deliverPlatformPayload(entry, {
							platform: thread.interface,
							thread_id: payload.thread_id,
							message_id: payload.message_id,
							content: "",
						});
					}
				} else {
					// Non-platform context (legacy auto-deliver): deliver the last assistant
					// message text. Always emit platform:deliver even with empty content so the
					// connector can call stopTyping() — deliver() checks content length before
					// sending, so an empty emit stops typing without messaging the user.
					if (thread && thread.interface !== "web") {
						const lastAssistant = this.db
							.query<{ id: string; content: string }, [string]>(
								"SELECT id, content FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1",
							)
							.get(payload.thread_id);

						// Extract text content if available; default to "" for typing-stop-only emit.
						let textContent = "";
						const messageId = lastAssistant?.id ?? payload.message_id;
						if (lastAssistant) {
							textContent = lastAssistant.content;
							try {
								const parsed = JSON.parse(lastAssistant.content);
								if (Array.isArray(parsed)) {
									textContent = parsed
										.filter((b: { type: string; text?: string }) => b.type === "text")
										.map((b: { text?: string }) => b.text ?? "")
										.join("");
								}
							} catch {
								// already a plain string
							}
						}

						this.deliverPlatformPayload(entry, {
							platform: thread.interface,
							thread_id: payload.thread_id,
							message_id: messageId,
							content: textContent,
						});
					}
				}
			}
		} catch (err) {
			emitStatusForward("idle", null, 0);
			this.writeResponse(entry, "error", JSON.stringify({ error: String(err), retriable: false }));
			// Stop typing indicator even on failure — same empty-content mechanism as success path.
			if (payload.platform) {
				try {
					const errThread = this.db
						.query<{ interface: string }, [string]>(
							"SELECT interface FROM threads WHERE id = ? AND deleted = 0 LIMIT 1",
						)
						.get(payload.thread_id);
					if (errThread && errThread.interface !== "web") {
						this.deliverPlatformPayload(entry, {
							platform: errThread.interface,
							thread_id: payload.thread_id,
							message_id: payload.message_id,
							content: "",
						});
					}
				} catch {
					// ignore — already in error path
				}
			}
		}
	}

	/**
	 * Delivers a platform:deliver payload either locally (if this host has the
	 * platform connector) or via relay outbox to entry.source_site_id (the spoke
	 * that delegated the process relay to this host).
	 *
	 * This handles the cross-node scenario: hub executes the agent loop but the
	 * platform connector (e.g. Discord) lives only on the spoke. Without this
	 * routing the platform:deliver event fires on the hub's event bus where no
	 * connector is listening and the delivery is silently dropped.
	 */
	private deliverPlatformPayload(
		entry: RelayInboxEntry,
		deliverPayload: PlatformDeliverPayload,
	): void {
		// Local connector exists (or no registry configured — single-host / backward compat):
		// deliver on this node's event bus.
		if (
			!this.platformConnectorRegistry ||
			this.platformConnectorRegistry.getConnector(deliverPayload.platform)
		) {
			this.eventBus.emit("platform:deliver", deliverPayload);
			return;
		}

		// Registry is configured but this node doesn't have the connector —
		// route back to the node that delegated this loop.
		const targetSiteId = entry.source_site_id;
		if (!targetSiteId) {
			// No source to route back to (shouldn't happen in practice) — fall back locally.
			this.eventBus.emit("platform:deliver", deliverPayload);
			return;
		}

		const now = new Date();
		writeOutbox(this.db, {
			id: randomUUID(),
			source_site_id: this.siteId,
			target_site_id: targetSiteId,
			kind: "platform_deliver",
			ref_id: entry.id,
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify(deliverPayload),
			created_at: now.toISOString(),
			expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
		});
		this.eventBus.emit("sync:trigger", { reason: "platform-deliver-relay" });
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
