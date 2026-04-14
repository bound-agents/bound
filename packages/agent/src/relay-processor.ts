import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type AppContext,
	type ThreadExecutor,
	acknowledgeBatch,
	claimPending,
	enqueueMessage,
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
	EventMap,
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
import {
	RELAY_REQUEST_KINDS,
	RELAY_RESPONSE_KINDS,
	type RelayRequestKind,
	eventBroadcastPayloadSchema,
	hostMcpToolsSchema,
	hostModelsSchema,
	inferenceRequestPayloadSchema,
	intakePayloadSchema,
	parseJsonSafe,
	parseJsonUntyped,
	platformDeliverPayloadSchema,
	processPayloadSchema,
} from "@bound/shared";
import { AgentLoop } from "./agent-loop.js";
import type { MCPClient } from "./mcp-client.js";
import { resolveModel } from "./model-resolution.js";
import type { AgentLoopConfig } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Handler for a relay request kind. Returns a response string (written as a
 * "result" relay response) or null (handler wrote responses directly, e.g.
 * fire-and-forget kinds like process/inference).
 */
type RelayEntryHandler = (entry: RelayInboxEntry) => Promise<string | null>;

/**
 * All request kinds that processEntry dispatches to handlers.
 * cancel is excluded — it's handled in the first pass of processPendingEntries
 * (needs to run before other entries to abort in-flight work).
 */
type HandledRequestKind = Exclude<RelayRequestKind, "cancel">;

/**
 * Thrown by handlers when payload parsing fails and the handler has already
 * written an error response + marked the entry as processed. processEntry's
 * catch block recognizes this and skips its normal error handling.
 */
class PayloadParseError extends Error {
	constructor() {
		super("Payload parse error (already handled)");
		this.name = "PayloadParseError";
	}
}

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
	private threadExecutor: ThreadExecutor | null = null;

	/**
	 * Typed handler map — every HandledRequestKind MUST have an entry.
	 * Adding a new kind to RELAY_KIND_REGISTRY with dispatch "sync" or "async"
	 * without adding a handler here is a compile error.
	 */
	private readonly handlerMap: Record<HandledRequestKind, RelayEntryHandler> = {
		tool_call: (entry) =>
			this.handleParsedPayload(entry, parseJsonUntyped, (p) =>
				this.executeToolCall(p as ToolCallPayload),
			),
		resource_read: (entry) =>
			this.handleParsedPayload(entry, parseJsonUntyped, (p) =>
				this.executeResourceRead(p as ResourceReadPayload),
			),
		prompt_invoke: (entry) =>
			this.handleParsedPayload(entry, parseJsonUntyped, (p) =>
				this.executePromptInvoke(p as PromptInvokePayload),
			),
		cache_warm: (entry) =>
			this.handleParsedPayload(entry, parseJsonUntyped, (p) =>
				this.executeCacheWarm(entry, p as CacheWarmPayload),
			),
		inference: (entry) => this.handleInference(entry),
		process: (entry) => this.handleProcess(entry),
		intake: (entry) => this.handleIntake(entry),
		platform_deliver: (entry) => this.handlePlatformDeliver(entry),
		event_broadcast: (entry) => this.handleEventBroadcast(entry),
	};

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

	/** Inject the thread executor for dispatch queue integration (avoids circular init order). */
	setThreadExecutor(executor: ThreadExecutor): void {
		this.threadExecutor = executor;
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

			// Step 5: Execute via typed handler map
			const executionStartTime = Date.now();
			let response: string | null;
			try {
				const handler = this.handlerMap[entry.kind as HandledRequestKind];
				if (!handler) {
					// Unknown relay kind at runtime (e.g., from a newer node version
					// during rolling upgrade). Log and skip.
					this.logger.warn("Unknown relay kind", { kind: entry.kind });
					markProcessed(this.db, [entry.id]);
					return;
				}
				response = await handler(entry);
			} catch (executionError) {
				// PayloadParseError: handler already wrote error response and marked
				// processed — just record metrics and return.
				if (executionError instanceof PayloadParseError) {
					return;
				}
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
				} catch (error) {
					this.logger.warn("Failed to record relay metrics", {
						kind: entry.kind,
						direction: "inbound",
						error: error instanceof Error ? error.message : String(error),
					});
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
			} catch (error) {
				this.logger.warn("Failed to record relay metrics", {
					kind: entry.kind,
					direction: "inbound",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} catch (error) {
			this.logger.error("Error processing relay entry", { error, entryId: entry.id });
			markProcessed(this.db, [entry.id]);
		}
	}

	// --- Handler helpers ---

	/**
	 * Common parse-then-execute pattern for simple request kinds.
	 * Parses the payload, logs and returns an error response on failure,
	 * or calls the executor and returns its result.
	 */
	private async handleParsedPayload(
		entry: RelayInboxEntry,
		// biome-ignore lint/suspicious/noExplicitAny: parse functions have varying signatures
		parseFn: (payload: string, label: string) => { ok: boolean; value?: any; error?: string },
		executor: (parsed: unknown) => Promise<string | null>,
	): Promise<string | null> {
		const payloadResult = parseFn(entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: `Invalid payload: ${payloadResult.error}`, retriable: false }),
			);
			markProcessed(this.db, [entry.id]);
			// Return a sentinel that tells processEntry to skip its normal
			// response/cache/markProcessed logic — we already handled it.
			throw new PayloadParseError();
		}
		return executor(payloadResult.value);
	}

	private async handleInference(entry: RelayInboxEntry): Promise<null> {
		const payloadResult = parseJsonSafe(inferenceRequestPayloadSchema, entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: `Invalid payload: ${payloadResult.error}`, retriable: false }),
			);
			markProcessed(this.db, [entry.id]);
			throw new PayloadParseError();
		}
		this.executeInference(entry, payloadResult.value as InferenceRequestPayload).catch((err) => {
			this.logger.error("executeInference failed", { error: err, entryId: entry.id });
		});
		return null;
	}

	private async handleProcess(entry: RelayInboxEntry): Promise<null> {
		const payloadResult = parseJsonSafe(processPayloadSchema, entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: `Invalid payload: ${payloadResult.error}`, retriable: false }),
			);
			markProcessed(this.db, [entry.id]);
			throw new PayloadParseError();
		}
		this.executeProcess(entry, payloadResult.value).catch((err) => {
			this.logger.error("executeProcess failed", { error: err, entryId: entry.id });
		});
		return null;
	}

	private async handleIntake(entry: RelayInboxEntry): Promise<null> {
		const payloadResult = parseJsonSafe(intakePayloadSchema, entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			markProcessed(this.db, [entry.id]);
			throw new PayloadParseError();
		}
		const payload = payloadResult.value;
		this.logger.info("[relay] Intake received", {
			platform: payload.platform,
			threadId: payload.thread_id,
			messageId: payload.message_id,
			source: entry.source_site_id,
		});
		const idempotencyKey = `intake:${payload.platform}:${payload.platform_event_id}`;

		// Dedup: check idempotency cache
		const cached = this.idempotencyCache.get(idempotencyKey);
		if (cached && cached.expiresAt > Date.now()) {
			return null; // Duplicate — silently discard
		}
		this.idempotencyCache.set(idempotencyKey, {
			response: "",
			expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
		});

		// Platform affinity is handled inside selectIntakeHost (Tier 0)
		const targetSiteId = this.selectIntakeHost(payload.thread_id, payload.platform ?? undefined);
		if (!targetSiteId) {
			this.logger.warn("relay-processor", { msg: "intake: no eligible host found, dropping" });
			return null;
		}

		this.logger.info("[relay] Intake routed", {
			platform: payload.platform,
			threadId: payload.thread_id,
			targetSiteId,
			isLocal: targetSiteId === this.siteId,
		});

		writeOutbox(this.db, {
			id: randomUUID(),
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
		return null;
	}

	private async handlePlatformDeliver(entry: RelayInboxEntry): Promise<null> {
		const payloadResult = parseJsonSafe(platformDeliverPayloadSchema, entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			markProcessed(this.db, [entry.id]);
			throw new PayloadParseError();
		}
		this.eventBus.emit("platform:deliver", payloadResult.value as PlatformDeliverPayload);
		return null;
	}

	private async handleEventBroadcast(entry: RelayInboxEntry): Promise<null> {
		const payloadResult = parseJsonSafe(eventBroadcastPayloadSchema, entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			markProcessed(this.db, [entry.id]);
			throw new PayloadParseError();
		}
		const payload = payloadResult.value;
		this.eventBus.emit(
			payload.event_name as keyof EventMap,
			{ ...payload.event_payload, __relay_event_depth: payload.event_depth } as never,
		);
		return null;
	}

	private async executeToolCall(payload: ToolCallPayload): Promise<string> {
		// Under the subcommand dispatch model:
		// payload.tool = server name (e.g., "github")
		// payload.args = { subcommand: "create_issue", ...toolArgs }
		// The subcommand is dispatched to the appropriate MCP server.

		const serverName = payload.tool;
		this.logger.info("[relay] Tool call executing", {
			server: serverName,
			subcommand: payload.args.subcommand,
		});
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
	 * Look up which host runs a given platform connector by querying the synced
	 * hosts.platforms column. Returns the site_id or null if no host advertises
	 * that platform. This is the single source of truth for cross-host platform
	 * routing — all intake, process, and deliver paths call this instead of
	 * checking the in-process connector registry.
	 */
	private findPlatformHost(platform: string): string | null {
		try {
			const rows = this.db
				.query<{ site_id: string; platforms: string }, []>(
					"SELECT site_id, platforms FROM hosts WHERE deleted = 0 AND platforms IS NOT NULL",
				)
				.all();
			for (const row of rows) {
				try {
					const platforms = JSON.parse(row.platforms) as string[];
					if (Array.isArray(platforms) && platforms.includes(platform)) {
						return row.site_id;
					}
				} catch {
					// Corrupted JSON — skip this host
				}
			}
		} catch {
			// Table missing or other DB error — fall through
		}
		return null;
	}

	/**
	 * Select the best host to process an intake message.
	 * Tiers (in order): platform affinity → thread affinity → model match → tool match → least-loaded fallback.
	 */
	private selectIntakeHost(threadId: string, platform?: string): string | null {
		// Tier 0: Platform affinity — if the intake specifies a platform, route to
		// the host that advertises it so platform tools are available locally.
		if (platform) {
			const platformHost = this.findPlatformHost(platform);
			if (platformHost) return platformHost;
		}

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
					const modelsResult = parseJsonSafe(hostModelsSchema, host.models, "Tier 2 models");
					if (!modelsResult.ok) {
						this.logger.warn(
							`selectIntakeHost Tier 2: Skipping host ${host.site_id} with corrupted models`,
							{ error: modelsResult.error },
						);
						continue;
					}
					const models = modelsResult.value;
					// Check if any model entry matches (handle both string[] and HostModelEntry[] formats)
					const hasMatch = models.some((m) =>
						typeof m === "string" ? m === lastModel.model_id : m.id === lastModel.model_id,
					);
					if (hasMatch) return host.site_id;
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
				const toolsResult = parseJsonSafe(hostMcpToolsSchema, host.mcp_tools, "Tier 3 mcp_tools");
				if (!toolsResult.ok) {
					this.logger.warn(
						`selectIntakeHost Tier 3: Skipping host ${host.site_id} with corrupted mcp_tools`,
						{ error: toolsResult.error },
					);
					continue;
				}
				const hostToolNames = toolsResult.value;
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
						const payloadResult = parseJsonUntyped(request.payload, request.kind);
						if (!payloadResult.ok) {
							const errorResponse: ErrorPayload = {
								error: `Invalid payload: ${payloadResult.error}`,
								retriable: false,
							};
							results.push(this.createResultEntry(request, "error", JSON.stringify(errorResponse)));
							return results;
						}
						response = await this.executeToolCall(payloadResult.value as ToolCallPayload);
						break;
					}
					case "resource_read": {
						const payloadResult = parseJsonUntyped(request.payload, request.kind);
						if (!payloadResult.ok) {
							const errorResponse: ErrorPayload = {
								error: `Invalid payload: ${payloadResult.error}`,
								retriable: false,
							};
							results.push(this.createResultEntry(request, "error", JSON.stringify(errorResponse)));
							return results;
						}
						response = await this.executeResourceRead(payloadResult.value as ResourceReadPayload);
						break;
					}
					case "prompt_invoke": {
						const payloadResult = parseJsonUntyped(request.payload, request.kind);
						if (!payloadResult.ok) {
							const errorResponse: ErrorPayload = {
								error: `Invalid payload: ${payloadResult.error}`,
								retriable: false,
							};
							results.push(this.createResultEntry(request, "error", JSON.stringify(errorResponse)));
							return results;
						}
						response = await this.executePromptInvoke(payloadResult.value as PromptInvokePayload);
						break;
					}
					case "cache_warm": {
						const payloadResult = parseJsonUntyped(request.payload, request.kind);
						if (!payloadResult.ok) {
							const errorResponse: ErrorPayload = {
								error: `Invalid payload: ${payloadResult.error}`,
								retriable: false,
							};
							results.push(this.createResultEntry(request, "error", JSON.stringify(errorResponse)));
							return results;
						}
						response = await this.executeCacheWarm(
							request,
							payloadResult.value as CacheWarmPayload,
						);
						break;
					}
					default: {
						const errorResponse: ErrorPayload = {
							error: `Unknown request kind: ${request.kind}`,
							retriable: false,
						};
						results.push(this.createResultEntry(request, "error", JSON.stringify(errorResponse)));
						return results;
					}
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
		this.logger.info("[relay] Inference started", {
			model: payload.model,
			source: entry.source_site_id,
			streamId: entry.stream_id,
			messageCount: payload.messages?.length ?? 0,
			hasTools: !!payload.tools?.length,
		});
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
		} catch (error) {
			this.logger.warn("Failed to record relay metrics", {
				kind: "inference",
				direction: "inbound",
				error: error instanceof Error ? error.message : String(error),
			});
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
			this.logger.info("[relay] Inference flush", {
				kind,
				seq,
				chunks: chunkBuffer.length,
				bytes: bufferBytes,
				streamId,
				elapsedMs: Date.now() - inferenceStartTime,
			});
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
			} catch (error) {
				this.logger.warn("Failed to record relay metrics", {
					kind,
					direction: "inbound",
					error: error instanceof Error ? error.message : String(error),
				});
			}
			seq++;
			chunkBuffer = [];
			bufferBytes = 0;
			lastFlushTime = Date.now();
			// Trigger sync immediately so chunks reach the requester without waiting
			// for the next scheduled sync cycle (up to 60s delay otherwise).
			this.eventBus?.emit("sync:trigger", { reason: "inference-stream-flush" });
		};

		try {
			// Do not pass payload.model to chat() — it's a logical ID (e.g., "opus")
			// that the model router already resolved to this backend. The backend has
			// its own configured model identifier (e.g., the full Bedrock ARN).
			// Passing the alias would override the ARN and cause Bedrock to reject it.
			const chatStream = backend.chat({
				messages,
				tools: payload.tools,
				system: payload.system,
				system_suffix: payload.system_suffix,
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
			} catch (error) {
				this.logger.warn("Failed to record relay metrics", {
					kind: "inference",
					direction: "inbound",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			this.activeInferenceStreams.delete(entry.id);
		}
	}

	private async executeProcess(entry: RelayInboxEntry, payload: ProcessPayload): Promise<void> {
		this.logger.info("[relay] Process delegation started", {
			threadId: payload.thread_id,
			messageId: payload.message_id,
			platform: payload.platform ?? null,
			source: entry.source_site_id,
		});
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
			} catch (error) {
				this.logger.warn("Failed to write status forward outbox entry", {
					threadId: payload.thread_id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};

		emitStatusForward("thinking", null, 0);

		// When a ThreadExecutor is available, enqueue the message into the dispatch
		// queue and delegate to the executor. This prevents N concurrent inferences
		// when N rapid Discord messages arrive for the same thread.
		if (this.threadExecutor) {
			enqueueMessage(this.db, payload.message_id, payload.thread_id);

			await this.threadExecutor.execute(
				payload.thread_id,
				// runFn: claim → run agent loop → acknowledge
				async (shouldYield) => {
					const claimed = claimPending(this.db, payload.thread_id, this.siteId);
					if (claimed.length === 0) return {};

					const claimedIds = claimed.map((e) => e.message_id);

					try {
						const result = await this.runDelegatedLoop(entry, payload, delegatedCtx, shouldYield);

						if (result.yielded) {
							return { yielded: true };
						}

						acknowledgeBatch(this.db, claimedIds);
						return result;
					} catch (error) {
						try {
							acknowledgeBatch(this.db, claimedIds);
						} catch (ackError) {
							this.logger.warn("Failed to acknowledge batch after error", {
								claimedIds: claimedIds.length,
								error: ackError instanceof Error ? ackError.message : String(ackError),
							});
						}
						throw error;
					}
				},
				// onComplete: finalize relay response and platform delivery
				async (result) => {
					this.finalizeProcess(entry, payload, result);
				},
			);

			emitStatusForward("idle", null, 0);
			return;
		}

		// Fallback: no executor available (backward compat for tests or standalone relay).
		try {
			const result = await this.runDelegatedLoop(entry, payload, delegatedCtx);
			this.finalizeProcess(entry, payload, result);
			emitStatusForward("idle", null, 0);
		} catch (err) {
			emitStatusForward("idle", null, 0);
			this.writeResponse(entry, "error", JSON.stringify({ error: String(err), retriable: false }));
			this.stopTypingOnError(entry, payload);
		}
	}

	/**
	 * Run a delegated agent loop. Extracted from executeProcess so both the
	 * executor-backed and fallback paths can share the same inference logic.
	 */
	private async runDelegatedLoop(
		entry: RelayInboxEntry,
		payload: ProcessPayload,
		delegatedCtx: AppContext,
		shouldYield?: () => boolean,
	): Promise<Record<string, unknown>> {
		// Resolve thread's preferred model: check the last message with a model_id
		// so /model slash command preferences and model continuity are respected.
		let threadModelId: string | undefined;
		if (this.modelRouter) {
			const lastThreadModel = this.db
				.prepare(
					`SELECT model_id FROM messages
					 WHERE thread_id = ? AND model_id IS NOT NULL
					   AND role IN ('assistant', 'tool_call', 'system')
					 ORDER BY created_at DESC LIMIT 1`,
				)
				.get(payload.thread_id) as { model_id: string } | null;
			if (lastThreadModel?.model_id) {
				const resolution = resolveModel(
					lastThreadModel.model_id,
					this.modelRouter,
					this.db,
					this.siteId,
				);
				if (resolution.kind !== "error") {
					threadModelId = lastThreadModel.model_id;
				} else {
					this.logger.warn("[relay] Thread model unavailable, using node default", {
						threadId: payload.thread_id,
						threadModel: lastThreadModel.model_id,
						reason: resolution.error,
					});
				}
			}
		}

		const loopConfig: AgentLoopConfig = {
			threadId: payload.thread_id,
			userId: payload.user_id,
			taskId: `delegated-${entry.id}`,
			modelId: threadModelId,
			shouldYield,
		};

		if (payload.platform && this.platformConnectorRegistry) {
			const connector = this.platformConnectorRegistry.getConnector(payload.platform);
			if (connector?.getPlatformTools) {
				const platformTools = connector.getPlatformTools(payload.thread_id, this.fileReader);
				loopConfig.platform = payload.platform;
				loopConfig.platformTools = platformTools;
				this.logger.info("[relay] Platform tools injected", {
					platform: payload.platform,
					threadId: payload.thread_id,
					toolCount: platformTools.size,
					tools: Array.from(platformTools.keys()),
				});
			}
		}

		const agentLoop = this.agentLoopFactory
			? this.agentLoopFactory(loopConfig)
			: new AgentLoop(
					delegatedCtx,
					{
						/* sandbox not available — no tools in context */
					} as object,
					// biome-ignore lint/style/noNonNullAssertion: modelRouter checked before entering executeProcess
					this.modelRouter!,
					loopConfig,
				);

		const result = await agentLoop.run();
		return {
			yielded: result.yielded,
			error: result.error,
			messagesCreated: result.messagesCreated,
		};
	}

	/**
	 * Finalize a process relay: write the response and deliver to platform.
	 */
	private finalizeProcess(
		entry: RelayInboxEntry,
		payload: ProcessPayload,
		result: Record<string, unknown>,
	): void {
		if (result.error) {
			this.writeResponse(entry, "error", JSON.stringify({ error: result.error, retriable: false }));
			return;
		}

		this.writeResponse(entry, "result", JSON.stringify({ success: true }));

		const thread = this.db
			.query<{ interface: string }, [string]>(
				"SELECT interface FROM threads WHERE id = ? AND deleted = 0 LIMIT 1",
			)
			.get(payload.thread_id);

		if (payload.platform) {
			if (thread && thread.interface !== "web") {
				this.deliverPlatformPayload(entry, {
					platform: thread.interface,
					thread_id: payload.thread_id,
					message_id: payload.message_id,
					content: "",
				});
			}
		} else {
			if (thread && thread.interface !== "web") {
				const lastAssistant = this.db
					.query<{ id: string; content: string }, [string]>(
						"SELECT id, content FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1",
					)
					.get(payload.thread_id);

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

	/**
	 * Stop the typing indicator on error — emits platform:deliver with empty content.
	 */
	private stopTypingOnError(entry: RelayInboxEntry, payload: ProcessPayload): void {
		if (!payload.platform) return;
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
		} catch (error) {
			this.logger.warn("Failed to stop typing indicator on error", {
				platform: payload.platform,
				threadId: payload.thread_id,
				error: error instanceof Error ? error.message : String(error),
			});
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
		// Fast path: this node has the connector locally — emit on event bus.
		if (this.platformConnectorRegistry?.getConnector(deliverPayload.platform)) {
			this.eventBus.emit("platform:deliver", deliverPayload);
			return;
		}

		// No connector registry at all → single-host mode / backward compat.
		// Emit locally so the event bus can still route to any listeners.
		if (!this.platformConnectorRegistry) {
			this.eventBus.emit("platform:deliver", deliverPayload);
			return;
		}

		// Registry exists but doesn't have this platform — look up which remote
		// host advertises it via the synced hosts.platforms column.
		const platformHost = this.findPlatformHost(deliverPayload.platform);
		const targetSiteId = platformHost ?? entry.source_site_id;
		if (!targetSiteId || targetSiteId === this.siteId) {
			// No remote host found — emit locally as last resort.
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
