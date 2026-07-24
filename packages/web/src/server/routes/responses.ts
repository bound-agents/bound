import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { createFileRefResolver, createRelayInferenceStream, resolveModel } from "@bound/agent";
import type {
	ContentBlock,
	InferenceRequestPayload,
	LLMMessage,
	ModelRouter,
	StreamChunk,
	ToolDefinition,
} from "@bound/llm";
import type { ContextSegment, Logger, TypedEventEmitter } from "@bound/shared";
import { createLogger } from "@bound/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

/**
 * POST /v1/responses — OpenAI Responses-API-compatible inference over HTTP.
 *
 * Speaks the OpenAI Responses wire format at both boundaries so arbitrary
 * applications (OpenAI SDKs, LangChain's Responses adapter, etc.) can point at
 * a bound host and drive any model the cluster can resolve — local backends
 * directly, remote cluster models via the relay, same path the agent loop
 * uses. It does NOT go through context assembly, tool execution, or the agent
 * loop: it's a thin translation shim over `resolveModel()` + `backend.chat()`.
 *
 * REQUEST (subset of the Responses schema that maps onto bound's inputs):
 *   - `model` (optional → router default)
 *   - `input`: string, OR an array of message items
 *       ({ role, content }, content string or a parts array of
 *        { type: "input_text" | "output_text" | "text", text }).
 *   - `instructions` → system prompt
 *   - `tools`: Responses-flat function tools
 *       ({ type: "function", name, description?, parameters }) → ToolDefinition
 *   - `reasoning.effort` → effort
 *   - `max_output_tokens` → max_tokens
 *   - `temperature`
 *   - `stream`: boolean — SSE event stream when true, single JSON Response when false.
 * Unrecognized fields are ignored (forward-compatible with richer clients).
 *
 * AUTH: none. Localhost-only via the Host-header (DNS-rebinding) middleware,
 * same as every other route. A bearer token, if the client sends one, is
 * accepted and ignored so OpenAI SDKs that require an API key still work.
 *
 * STREAM (stream:true) — SSE events matching the Responses streaming contract,
 * each `event: <type>` + `data: <json>` with a monotonic `sequence_number`:
 *   response.created → response.in_progress
 *   → (text)          output_item.added → content_part.added
 *                     → response.output_text.delta* → response.output_text.done
 *                     → content_part.done → output_item.done
 *   → (tool call)     output_item.added(function_call)
 *                     → response.function_call_arguments.delta*
 *                     → response.function_call_arguments.done → output_item.done
 *   → response.completed  (or response.failed on a stream error)
 *
 * NON-STREAM (stream:false | omitted) — a single `Response` object with a
 * fully-populated `output` array and `usage`.
 */
export function createResponsesRoutes(
	db: Database,
	modelRouter: ModelRouter | null,
	eventBus: TypedEventEmitter,
	siteId: string,
	logger?: Logger,
) {
	const app = new Hono();
	const log = logger ?? createLogger("web", "responses");

	app.post("/", async (c) => {
		if (!modelRouter) {
			return c.json(errorObject("No model router configured on this host", "server_error"), 503);
		}

		let body: ResponsesRequestBody;
		try {
			body = await c.req.json();
		} catch {
			return c.json(errorObject("Invalid JSON body", "invalid_request_error"), 400);
		}

		// Stateless endpoint: no server-side response store, so server-side
		// conversation chaining can't be honored. A client that opted into it
		// (previous_response_id / conversation) must instead re-send full history
		// in `input` under store:false — the default pattern for Codex and OpenCode.
		// Reject explicitly rather than silently dropping prior-turn context.
		if (body.previous_response_id || body.conversation) {
			return c.json(
				errorObject(
					"This endpoint is stateless: server-side conversation state (previous_response_id / conversation) is not supported. Send the full conversation in 'input' instead.",
					"invalid_request_error",
				),
				400,
			);
		}

		let messages: LLMMessage[];
		try {
			messages = inputToMessages(body.input);
		} catch (err) {
			return c.json(
				errorObject(
					err instanceof Error ? err.message : "Invalid 'input' field",
					"invalid_request_error",
				),
				400,
			);
		}
		if (messages.length === 0) {
			return c.json(errorObject("Missing or empty 'input' field", "invalid_request_error"), 400);
		}

		const system = body.instructions;
		const tools = responsesToolsToDefinitions(body.tools);
		const effort = body.reasoning?.effort;
		const requestedMaxTokens = body.max_output_tokens;
		const temperature = body.temperature;
		// Echoed back on the Response object / final event so strict SDK parsers
		// (which mark these non-optional) don't reject. tool_choice defaults to
		// "auto"; we don't yet forward it to the driver (follow-up), so echo the
		// requested value if present, else the default. parallel_tool_calls is
		// likewise not yet forwarded; echo the request or the API default (true).
		const echo: ResponseEcho = {
			tools: body.tools ?? [],
			toolChoice: body.tool_choice ?? "auto",
			parallelToolCalls: body.parallel_tool_calls ?? true,
		};

		// resolveModel checks local backends first, then remote hosts.
		// Handles "default"/undefined → default model, same as the agent loop.
		const resolution = resolveModel(body.model || undefined, modelRouter, db, siteId);
		if (resolution.kind === "error") {
			const status = resolution.reason === "unknown-model" ? 404 : 503;
			return c.json(
				errorObject(
					`Model '${body.model || modelRouter.getDefaultId()}' unavailable: ${resolution.error}`,
					resolution.reason === "unknown-model" ? "invalid_request_error" : "server_error",
				),
				status,
			);
		}

		const modelId = resolution.modelId;

		let stream: AsyncIterable<StreamChunk>;
		if (resolution.kind === "local") {
			const thinking = resolution.thinkingConfig;
			const localEffort = effort ?? resolution.effort;
			const maxOutputCap = resolution.maxOutputTokens;
			const max_tokens = requestedMaxTokens
				? maxOutputCap
					? Math.min(requestedMaxTokens, maxOutputCap)
					: requestedMaxTokens
				: maxOutputCap;

			stream = resolution.backend.chat({
				messages,
				tools,
				system,
				max_tokens,
				temperature,
				thinking,
				effort: localEffort,
				cache_ttl: resolution.cacheTtl,
				resolveFileRef: createFileRefResolver(db),
				signal: c.req.raw.signal,
			});
		} else {
			// Remote: relay through the cluster to a host that has this model.
			const segments: ContextSegment[] = messages.map((msg) => ({
				kind: "inline",
				message: msg,
			}));
			const payload: InferenceRequestPayload = {
				model: modelId,
				segments,
				nowMs: Date.now(),
				tools,
				system,
				max_tokens: requestedMaxTokens,
				temperature,
				effort,
				timeout_ms: 300_000,
			};
			log.info("RESPONSES_RELAY: starting", {
				model: modelId,
				hosts: resolution.hosts.map((h) => h.host_name),
			});
			stream = createRelayInferenceStream(
				{ db, eventBus, siteId, logger: log },
				payload,
				resolution.hosts,
				c.req.raw.signal,
			);
		}

		if (body.stream) {
			return streamSSE(c, async (sse) => {
				const emitter = new SseEmitter(sse, modelId, echo);
				await emitter.run(stream);
			});
		}

		// Non-streaming: collect the full stream, then serialize one Response object.
		try {
			const collected = await collectResponse(stream, modelId, echo);
			return c.json(collected);
		} catch (err) {
			return c.json(
				errorObject(err instanceof Error ? err.message : String(err), "server_error"),
				502,
			);
		}
	});

	return app;
}

// ── Request types ────────────────────────────────────────────────────────

interface ResponsesRequestBody {
	model?: string;
	input?: ResponsesInput;
	instructions?: string;
	tools?: ResponsesTool[];
	reasoning?: { effort?: string };
	max_output_tokens?: number;
	temperature?: number;
	stream?: boolean;
	top_p?: number;
	tool_choice?: unknown;
	parallel_tool_calls?: boolean;
	// Stateless endpoint rejects these (see route body).
	previous_response_id?: string;
	conversation?: unknown;
}

type ResponsesInput = string | ResponsesInputItem[];

interface ResponsesInputItem {
	role?: "user" | "assistant" | "system" | "developer";
	content?: string | ResponsesContentPart[];
	type?: string;
}

interface ResponsesContentPart {
	type?: string;
	// input_text / output_text / text
	text?: string;
	// input_image: a `data:<mime>;base64,<...>` URL or an http(s) URL.
	image_url?: string | { url?: string; detail?: string };
	// input_file: `file_data` is a `data:<mime>;base64,<...>` URL; `filename`
	// names it. file_id / file_url reference an external store we don't have.
	file_data?: string;
	filename?: string;
	file_id?: string;
	file_url?: string;
}

interface ResponsesTool {
	type?: string;
	name?: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

// ── Request translation ──────────────────────────────────────────────────

/**
 * Translate a Responses `input` into bound `LLMMessage[]`. A bare string is a
 * single user turn. An item array maps each `{ role, content }` — content is
 * either a string (→ text) or a parts array. Text parts (input_text /
 * output_text / text) become text; `input_image` and `input_file` parts with
 * inline `data:` payloads become image / document ContentBlocks. Parts that
 * reference an external store (file_id / file_url / an http image_url) are
 * dropped with a text placeholder, since this endpoint is stateless and has no
 * files store behind it.
 */
function inputToMessages(input: ResponsesInput | undefined): LLMMessage[] {
	if (input === undefined) return [];
	if (typeof input === "string") {
		return input.length > 0 ? [{ role: "user", content: input }] : [];
	}
	if (!Array.isArray(input)) {
		throw new Error("'input' must be a string or an array of message items");
	}
	const messages: LLMMessage[] = [];
	for (const item of input) {
		const role = mapInputRole(item.role);
		const content = partsToContent(item.content);
		// Empty when the item carried no renderable text or media.
		if (typeof content === "string") {
			if (content.length === 0) continue;
		} else if (content.length === 0) {
			continue;
		}
		messages.push({ role, content });
	}
	return messages;
}

function mapInputRole(role: ResponsesInputItem["role"]): LLMMessage["role"] {
	switch (role) {
		case "assistant":
			return "assistant";
		case "system":
		case "developer":
			// bound forbids role:"system" in messages; carry as developer, which
			// the bridge folds into system context at its natural position.
			return "developer";
		default:
			return "user";
	}
}

/**
 * Translate a Responses content field into bound message content. A string
 * passes through as a text message. A parts array is folded into a
 * ContentBlock[] preserving order; when every part is text the blocks collapse
 * back to a single string so the common (text-only) path stays a plain string
 * message — the shape the bridge and every downstream test already expect.
 */
function partsToContent(content: ResponsesInputItem["content"]): string | ContentBlock[] {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const blocks: ContentBlock[] = [];
	for (const part of content) {
		const type = part.type ?? "";
		if (type === "input_image" || (type === "" && part.image_url !== undefined)) {
			const block = imagePartToBlock(part);
			if (block) blocks.push(block);
			else
				blocks.push({
					type: "text",
					text: "[image omitted: only inline data: URLs are supported]",
				});
			continue;
		}
		if (type === "input_file" || (type === "" && part.file_data !== undefined)) {
			const block = filePartToBlock(part);
			if (block) blocks.push(block);
			else
				blocks.push({
					type: "text",
					text: "[file omitted: only inline file_data data: URLs are supported]",
				});
			continue;
		}
		// input_text / output_text / text, or any part carrying a `.text`.
		if (typeof part.text === "string" && part.text.length > 0) {
			blocks.push({ type: "text", text: part.text });
		}
	}

	// Collapse the all-text case to a plain string.
	if (blocks.every((b) => b.type === "text")) {
		const joined = blocks.map((b) => (b as { text: string }).text).join("");
		return joined;
	}
	return blocks;
}

/** Extract the URL out of an image_url part (string form or object form). */
function imageUrlOf(part: ResponsesContentPart): string | undefined {
	if (typeof part.image_url === "string") return part.image_url;
	if (part.image_url && typeof part.image_url === "object") return part.image_url.url;
	return undefined;
}

/**
 * Parse a `data:<mediatype>;base64,<payload>` URL into its media type and
 * base64 payload. Returns null for non-data URLs (http(s), file_url) or any
 * non-base64 data URL — the caller emits a placeholder for those.
 */
function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
	if (!url.startsWith("data:")) return null;
	const comma = url.indexOf(",");
	if (comma === -1) return null;
	const header = url.slice(5, comma); // between "data:" and ","
	const payload = url.slice(comma + 1);
	if (!header.includes(";base64")) return null;
	const mediaType = header.slice(0, header.indexOf(";")) || "application/octet-stream";
	return { mediaType, base64: payload };
}

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * input_image → image ContentBlock, only for inline `data:` base64 URLs. The
 * ContentBlock image source constrains media_type to the four AI-SDK image
 * types; a data URL outside that set (or a file_id / http image_url) returns
 * null so the caller can placeholder it.
 */
function imagePartToBlock(part: ResponsesContentPart): ContentBlock | null {
	const url = imageUrlOf(part);
	if (!url) return null;
	const parsed = parseDataUrl(url);
	if (!parsed) return null;
	if (!IMAGE_MEDIA_TYPES.has(parsed.mediaType)) return null;
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: parsed.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
			data: parsed.base64,
		},
	};
}

/**
 * input_file → document ContentBlock, only for inline `file_data` base64 data
 * URLs. Documents take an open IANA media_type string. file_id / file_url
 * reference an external store we don't have → null.
 */
function filePartToBlock(part: ResponsesContentPart): ContentBlock | null {
	if (typeof part.file_data !== "string") return null;
	const parsed = parseDataUrl(part.file_data);
	if (!parsed) return null;
	return {
		type: "document",
		source: {
			type: "base64",
			media_type: parsed.mediaType,
			data: parsed.base64,
		},
		...(part.filename && { filename: part.filename }),
	};
}

/**
 * Responses flattens function tools to `{ type:"function", name, description,
 * parameters }` — no nesting under a `function` key (that's the older Chat
 * Completions shape). bound's ToolDefinition nests, so lift each here.
 */
function responsesToolsToDefinitions(
	tools: ResponsesTool[] | undefined,
): ToolDefinition[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	const out: ToolDefinition[] = [];
	for (const t of tools) {
		if (t.type && t.type !== "function") continue; // ignore non-function tools
		if (!t.name) continue;
		out.push({
			type: "function",
			function: {
				name: t.name,
				description: t.description ?? "",
				parameters: t.parameters ?? { type: "object", properties: {} },
			},
		});
	}
	return out.length > 0 ? out : undefined;
}

// ── Output assembly (shared by streaming + non-streaming) ──────────────────

interface AssembledToolCall {
	id: string;
	callId: string;
	name: string;
	argsJson: string;
}

interface UsageOut {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	cache_read_tokens: number;
}

/**
 * Request fields echoed back onto the Response object / final event. The
 * OpenAI SDK marks `tools`, `tool_choice`, and `parallel_tool_calls` as
 * non-optional on the Response model, so a strict parser rejects a response
 * that omits them. We don't yet forward tool_choice / parallel_tool_calls to
 * the driver (that's the driver-spanning follow-up), so these are pure echoes.
 */
interface ResponseEcho {
	tools: unknown[];
	toolChoice: unknown;
	parallelToolCalls: boolean;
}

/**
 * Shape a UsageOut into the ResponseUsage object the SDK expects, including the
 * required `input_tokens_details` / `output_tokens_details` sub-objects (their
 * fields are non-optional on the SDK model). We don't track reasoning-token or
 * cache-write splits here, so those report 0.
 */
function usageToResponsesShape(usage: UsageOut): Record<string, unknown> {
	return {
		input_tokens: usage.input_tokens,
		input_tokens_details: {
			cached_tokens: usage.cache_read_tokens,
			cache_write_tokens: 0,
		},
		output_tokens: usage.output_tokens,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: usage.total_tokens,
	};
}

const FINISH_TO_STATUS: Record<string, string> = {
	stop: "completed",
	"tool-calls": "completed",
	length: "incomplete",
	"content-filter": "incomplete",
	other: "completed",
	unknown: "completed",
};

/**
 * Fold a StreamChunk sequence into the Responses `output` array shape used by
 * both the non-streaming Response object and the final `response.completed`
 * event. Text becomes a `message` item with an `output_text` content part;
 * each tool call becomes a `function_call` item.
 */
function assembleOutput(chunks: StreamChunk[]): {
	text: string;
	toolCalls: AssembledToolCall[];
	usage: UsageOut;
	finishReason: string | null;
} {
	let text = "";
	const argsById = new Map<string, string>();
	const nameById = new Map<string, string>();
	const order: string[] = [];
	let usage: UsageOut = {
		input_tokens: 0,
		output_tokens: 0,
		total_tokens: 0,
		cache_read_tokens: 0,
	};
	let finishReason: string | null = null;

	for (const chunk of chunks) {
		switch (chunk.type) {
			case "text":
				text += chunk.content;
				break;
			case "tool_use_start":
				argsById.set(chunk.id, "");
				nameById.set(chunk.id, chunk.name);
				order.push(chunk.id);
				break;
			case "tool_use_args":
				argsById.set(chunk.id, (argsById.get(chunk.id) ?? "") + chunk.partial_json);
				break;
			case "tool_use_end":
				break;
			case "done":
				usage = {
					input_tokens: chunk.usage.input_tokens,
					output_tokens: chunk.usage.output_tokens,
					total_tokens: chunk.usage.input_tokens + chunk.usage.output_tokens,
					cache_read_tokens: chunk.usage.cache_read_tokens ?? 0,
				};
				finishReason = chunk.finish_reason ?? null;
				break;
			case "error":
				throw new Error(chunk.error);
			default:
				break;
		}
	}

	const toolCalls: AssembledToolCall[] = order.map((id) => ({
		id: `fc_${id}`,
		callId: id,
		name: nameById.get(id) ?? "",
		argsJson: argsById.get(id) ?? "",
	}));

	return { text, toolCalls, usage, finishReason };
}

function buildOutputItems(text: string, toolCalls: AssembledToolCall[]): unknown[] {
	const items: unknown[] = [];
	if (text.length > 0) {
		items.push({
			type: "message",
			id: `msg_${randomUUID().replace(/-/g, "")}`,
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text, annotations: [] }],
		});
	}
	for (const tc of toolCalls) {
		items.push({
			type: "function_call",
			id: tc.id,
			status: "completed",
			call_id: tc.callId,
			name: tc.name,
			arguments: tc.argsJson,
		});
	}
	return items;
}

async function collectResponse(
	stream: AsyncIterable<StreamChunk>,
	modelId: string,
	echo: ResponseEcho,
): Promise<Record<string, unknown>> {
	const chunks: StreamChunk[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const { text, toolCalls, usage, finishReason } = assembleOutput(chunks);
	const status = finishReason ? (FINISH_TO_STATUS[finishReason] ?? "completed") : "completed";
	return {
		id: `resp_${randomUUID().replace(/-/g, "")}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status,
		model: modelId,
		output: buildOutputItems(text, toolCalls),
		tools: echo.tools,
		tool_choice: echo.toolChoice,
		parallel_tool_calls: echo.parallelToolCalls,
		usage: usageToResponsesShape(usage),
	};
}

// ── Streaming translation ──────────────────────────────────────────────────

type SseWriter = {
	writeSSE(msg: { event?: string; data: string; id?: string }): Promise<void>;
};

/**
 * Translates a StreamChunk stream into the Responses SSE event protocol. Holds
 * the per-response id and a monotonic sequence counter; opens exactly one text
 * item lazily on the first text delta and one function_call item per tool id,
 * closing each in order before `response.completed`.
 */
class SseEmitter {
	private seq = 0;
	private readonly responseId = `resp_${randomUUID().replace(/-/g, "")}`;
	private outputIndex = 0;

	// Text-item state.
	private textItemId: string | null = null;
	private textOpened = false;
	private text = "";

	// Tool-call state, keyed by the internal chunk id.
	private toolState = new Map<
		string,
		{ itemId: string; callId: string; name: string; args: string; outputIndex: number }
	>();

	private usage: UsageOut = {
		input_tokens: 0,
		output_tokens: 0,
		total_tokens: 0,
		cache_read_tokens: 0,
	};
	private finishReason: string | null = null;

	constructor(
		private readonly sse: SseWriter,
		private readonly modelId: string,
		private readonly echo: ResponseEcho,
	) {}

	private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
		await this.sse.writeSSE({
			event: type,
			data: JSON.stringify({ type, sequence_number: this.seq++, ...payload }),
		});
	}

	private responseEnvelope(status: string): Record<string, unknown> {
		return {
			id: this.responseId,
			object: "response",
			created_at: Math.floor(Date.now() / 1000),
			status,
			model: this.modelId,
			output: [],
			tools: this.echo.tools,
			tool_choice: this.echo.toolChoice,
			parallel_tool_calls: this.echo.parallelToolCalls,
			usage: null,
		};
	}

	async run(stream: AsyncIterable<StreamChunk>): Promise<void> {
		await this.emit("response.created", { response: this.responseEnvelope("in_progress") });
		await this.emit("response.in_progress", { response: this.responseEnvelope("in_progress") });

		try {
			for await (const chunk of stream) {
				await this.handleChunk(chunk);
			}
		} catch (err) {
			await this.closeOpenItems();
			await this.emit("response.failed", {
				response: {
					...this.responseEnvelope("failed"),
					error: {
						code: "server_error",
						message: err instanceof Error ? err.message : String(err),
					},
				},
			});
			return;
		}

		await this.closeOpenItems();

		const status = this.finishReason
			? (FINISH_TO_STATUS[this.finishReason] ?? "completed")
			: "completed";
		const toolCalls: AssembledToolCall[] = [...this.toolState.values()].map((t) => ({
			id: t.itemId,
			callId: t.callId,
			name: t.name,
			argsJson: t.args,
		}));
		await this.emit("response.completed", {
			response: {
				...this.responseEnvelope(status),
				output: buildOutputItems(this.text, toolCalls),
				usage: usageToResponsesShape(this.usage),
			},
		});
	}

	private async handleChunk(chunk: StreamChunk): Promise<void> {
		switch (chunk.type) {
			case "text":
				await this.handleText(chunk.content);
				break;
			case "tool_use_start":
				await this.openToolItem(chunk.id, chunk.name);
				break;
			case "tool_use_args":
				await this.handleToolArgs(chunk.id, chunk.partial_json);
				break;
			case "tool_use_end":
				await this.closeToolItem(chunk.id);
				break;
			case "done":
				this.usage = {
					input_tokens: chunk.usage.input_tokens,
					output_tokens: chunk.usage.output_tokens,
					total_tokens: chunk.usage.input_tokens + chunk.usage.output_tokens,
					cache_read_tokens: chunk.usage.cache_read_tokens ?? 0,
				};
				this.finishReason = chunk.finish_reason ?? null;
				break;
			case "error":
				throw new Error(chunk.error);
			default:
				// thinking / heartbeat: not surfaced on the Responses text channel.
				break;
		}
	}

	private async handleText(delta: string): Promise<void> {
		if (delta.length === 0) return;
		if (!this.textOpened) {
			this.textItemId = `msg_${randomUUID().replace(/-/g, "")}`;
			this.textOpened = true;
			await this.emit("response.output_item.added", {
				output_index: this.outputIndex,
				item: {
					type: "message",
					id: this.textItemId,
					status: "in_progress",
					role: "assistant",
					content: [],
				},
			});
			await this.emit("response.content_part.added", {
				item_id: this.textItemId,
				output_index: this.outputIndex,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			});
		}
		this.text += delta;
		await this.emit("response.output_text.delta", {
			item_id: this.textItemId,
			output_index: this.outputIndex,
			content_index: 0,
			delta,
		});
	}

	private async closeTextItem(): Promise<void> {
		if (!this.textOpened || this.textItemId === null) return;
		await this.emit("response.output_text.done", {
			item_id: this.textItemId,
			output_index: this.outputIndex,
			content_index: 0,
			text: this.text,
		});
		await this.emit("response.content_part.done", {
			item_id: this.textItemId,
			output_index: this.outputIndex,
			content_index: 0,
			part: { type: "output_text", text: this.text, annotations: [] },
		});
		await this.emit("response.output_item.done", {
			output_index: this.outputIndex,
			item: {
				type: "message",
				id: this.textItemId,
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: this.text, annotations: [] }],
			},
		});
		this.textOpened = false;
		this.outputIndex++;
	}

	private async openToolItem(id: string, name: string): Promise<void> {
		// Close the text item first so output indices stay ordered.
		await this.closeTextItem();
		if (this.toolState.has(id)) return;
		const itemId = `fc_${id}`;
		const outputIndex = this.outputIndex++;
		this.toolState.set(id, { itemId, callId: id, name, args: "", outputIndex });
		await this.emit("response.output_item.added", {
			output_index: outputIndex,
			item: {
				type: "function_call",
				id: itemId,
				status: "in_progress",
				call_id: id,
				name,
				arguments: "",
			},
		});
	}

	private async handleToolArgs(id: string, partial: string): Promise<void> {
		const state = this.toolState.get(id);
		if (!state) return;
		state.args += partial;
		await this.emit("response.function_call_arguments.delta", {
			item_id: state.itemId,
			output_index: state.outputIndex,
			delta: partial,
		});
	}

	private async closeToolItem(id: string): Promise<void> {
		const state = this.toolState.get(id);
		if (!state) return;
		await this.emit("response.function_call_arguments.done", {
			item_id: state.itemId,
			output_index: state.outputIndex,
			arguments: state.args,
		});
		await this.emit("response.output_item.done", {
			output_index: state.outputIndex,
			item: {
				type: "function_call",
				id: state.itemId,
				status: "completed",
				call_id: state.callId,
				name: state.name,
				arguments: state.args,
			},
		});
	}

	/**
	 * Close any item still open at stream end (text with no explicit end, or a
	 * tool item whose tool_use_end never arrived). Tool items already closed by
	 * `closeToolItem` are idempotent here because their done-events already
	 * fired; we only need the text item.
	 */
	private async closeOpenItems(): Promise<void> {
		await this.closeTextItem();
	}
}

// ── Error object ────────────────────────────────────────────────────────

function errorObject(message: string, type: string): Record<string, unknown> {
	return { error: { message, type, param: null, code: null } };
}

// Silence unused-import lint for ContentBlock (kept for the media-part
// extension point in partsToText).
void (undefined as unknown as ContentBlock);
