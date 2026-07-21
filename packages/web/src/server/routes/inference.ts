import type { Database } from "bun:sqlite";
import { createFileRefResolver, createRelayInferenceStream, resolveModel } from "@bound/agent";
import type {
	InferenceRequestPayload,
	LLMMessage,
	ModelRouter,
	StreamChunk,
	ToolDefinition,
} from "@bound/llm";
import type { ContextSegment, Logger, TypedEventEmitter } from "@bound/shared";
import { createLogger } from "@bound/shared";
import { Hono } from "hono";

/**
 * POST /api/inference — stateless LLM inference over HTTP.
 *
 * Accepts a JSON body with `model` (optional — defaults to the router's
 * configured default), `messages`, and optional params (`system`, `tools`,
 * `max_tokens`, `temperature`, `thinking`, `effort`).
 *
 * Resolves the model via `resolveModel()`, which checks local backends first,
 * then remote hosts in the cluster. For local models, wraps `backend.chat()`
 * directly. For remote models (e.g. umans backends on the hub), relays the
 * inference request through the cluster's relay infrastructure
 * (`createRelayStream$`) — same path the agent loop uses.
 *
 * Streams `StreamChunk`s back as NDJSON (one JSON object per line).
 * Unauthenticated (same as all /api routes), protected by the DNS-rebinding
 * middleware (localhost only). Does NOT go through context assembly, tool
 * execution, or the agent loop — it's a thin wrapper for diagnostic/testing.
 */
export function createInferenceRoutes(
	db: Database,
	modelRouter: ModelRouter | null,
	eventBus: TypedEventEmitter,
	siteId: string,
	logger?: Logger,
) {
	const app = new Hono();
	const log = logger ?? createLogger("web", "inference");

	app.post("/", async (c) => {
		if (!modelRouter) {
			return c.json({ error: "No model router configured on this host" }, 503);
		}

		let body: {
			model?: string;
			messages: LLMMessage[];
			system?: string;
			tools?: ToolDefinition[];
			max_tokens?: number;
			temperature?: number;
			thinking?:
				| { type: "enabled"; budget_tokens: number }
				| { type: "adaptive"; display?: "omitted" | "summarized" };
			effort?: string;
		};

		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!Array.isArray(body.messages) || body.messages.length === 0) {
			return c.json(
				{ error: "Missing or invalid 'messages' field (must be a non-empty array)" },
				400,
			);
		}

		// resolveModel checks local backends first, then remote hosts.
		// Handles "default"/undefined → default model, same as the agent loop.
		const resolution = resolveModel(body.model || undefined, modelRouter, db, siteId);

		if (resolution.kind === "error") {
			const status = resolution.reason === "unknown-model" ? 404 : 503;
			return c.json(
				{
					error: `Model '${body.model || modelRouter.getDefaultId()}' unavailable: ${resolution.error}`,
					alternatives: resolution.alternatives,
					reason: resolution.reason,
				},
				status,
			);
		}

		// Build the appropriate stream based on resolution kind.
		let stream: AsyncIterable<StreamChunk>;

		if (resolution.kind === "local") {
			// Local: apply defaults from the resolution and call backend.chat() directly.
			const thinking = body.thinking ?? resolution.thinkingConfig;
			const effort = body.effort ?? resolution.effort;
			const maxOutputCap = resolution.maxOutputTokens;
			const max_tokens = body.max_tokens
				? maxOutputCap
					? Math.min(body.max_tokens, maxOutputCap)
					: body.max_tokens
				: maxOutputCap;

			stream = resolution.backend.chat({
				messages: body.messages,
				tools: body.tools,
				system: body.system,
				max_tokens,
				temperature: body.temperature,
				thinking,
				effort,
				cache_ttl: resolution.cacheTtl,
				resolveFileRef: createFileRefResolver(db),
				signal: c.req.raw.signal,
			});
		} else {
			// Remote: relay through the cluster to a host that has this model.
			// The hub's relay processor resolves the model locally and applies
			// its own defaults (thinking, effort, max_tokens, cache_ttl).
			const segments: ContextSegment[] = body.messages.map((msg) => ({
				kind: "inline",
				message: msg,
			}));
			const payload: InferenceRequestPayload = {
				model: resolution.modelId,
				segments,
				nowMs: Date.now(),
				tools: body.tools,
				system: body.system,
				max_tokens: body.max_tokens,
				temperature: body.temperature,
				thinking: body.thinking,
				effort: body.effort,
				timeout_ms: 300_000,
			};

			log.info("INFERENCE_RELAY: starting", {
				model: resolution.modelId,
				hosts: resolution.hosts.map((h) => h.host_name),
			});

			stream = createRelayInferenceStream(
				{ db, eventBus, siteId, logger: log },
				payload,
				resolution.hosts,
				c.req.raw.signal,
			);
		}

		const encoder = new TextEncoder();
		const readable = new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					for await (const chunk of stream) {
						controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
					}
				} catch (err) {
					const errorChunk: StreamChunk = {
						type: "error",
						error: err instanceof Error ? err.message : String(err),
					};
					controller.enqueue(encoder.encode(`${JSON.stringify(errorChunk)}\n`));
				}
				controller.close();
			},
		});

		return new Response(readable, {
			headers: {
				"Content-Type": "application/x-ndjson",
				"Cache-Control": "no-cache",
			},
		});
	});

	return app;
}
