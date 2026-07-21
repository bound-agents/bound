import type { Database } from "bun:sqlite";
import { createFileRefResolver } from "@bound/agent";
import type { LLMMessage, ModelRouter, StreamChunk, ToolDefinition } from "@bound/llm";
import { Hono } from "hono";

/**
 * POST /api/inference — stateless LLM inference over HTTP.
 *
 * Accepts a JSON body with `model`, `messages`, and optional params (`system`,
 * `tools`, `max_tokens`, `temperature`, `thinking`, `effort`). Resolves the
 * backend via the in-process ModelRouter, applies per-model defaults (thinking,
 * effort, max_tokens, cache_ttl), and streams `StreamChunk`s back as NDJSON
 * (one JSON object per line).
 *
 * This endpoint is unauthenticated (same as all /api routes) and protected by
 * the DNS-rebinding middleware (localhost only). It does NOT go through context
 * assembly, tool execution, or the agent loop — it's a thin wrapper around
 * `backend.chat()` for diagnostic and testing purposes.
 *
 * For remote (hub-backed) models, run this endpoint on the hub and POST to
 * the hub's web URL.
 */
export function createInferenceRoutes(db: Database, modelRouter: ModelRouter | null) {
	const app = new Hono();

	app.post("/", async (c) => {
		if (!modelRouter) {
			return c.json({ error: "No model router configured on this host" }, 503);
		}

		let body: {
			model: string;
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

		// Default to the router's configured default when model is omitted or empty.
		const model =
			body.model && typeof body.model === "string" ? body.model : modelRouter.getDefaultId();
		if (!Array.isArray(body.messages) || body.messages.length === 0) {
			return c.json(
				{ error: "Missing or invalid 'messages' field (must be a non-empty array)" },
				400,
			);
		}

		const backend = modelRouter.tryGetBackend(model);
		if (!backend) {
			const available = modelRouter
				.listEligible()
				.map((b) => b.id)
				.join(", ");
			return c.json(
				{ error: `Model '${model}' not available on this host. Available: ${available}` },
				404,
			);
		}

		// Apply defaults from the router — same pattern as relay-processor.executeInference.
		const thinking = body.thinking ?? modelRouter.getThinkingConfig(model);
		const effort = body.effort ?? modelRouter.getEffort(model);
		const localMaxOutputTokens = modelRouter.getMaxOutputTokens(model);
		const max_tokens = body.max_tokens
			? localMaxOutputTokens
				? Math.min(body.max_tokens, localMaxOutputTokens)
				: body.max_tokens
			: localMaxOutputTokens;
		const cache_ttl = modelRouter.getCacheTtl(model);

		const chatStream = backend.chat({
			messages: body.messages,
			tools: body.tools,
			system: body.system,
			max_tokens,
			temperature: body.temperature,
			thinking,
			effort,
			cache_ttl,
			resolveFileRef: createFileRefResolver(db),
			signal: c.req.raw.signal,
		});

		const encoder = new TextEncoder();
		const readable = new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					for await (const chunk of chatStream) {
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
