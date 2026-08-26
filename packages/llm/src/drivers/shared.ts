import { type Logger, counter, histogram } from "@bound/shared";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { type MapChunksOptions, mapChunks, mapError } from "../bridge";
import { createLoggingFetch } from "../fetch-logger";
import type { StreamChunk } from "../types";

const llmDriverAttempts = counter("bound.llm.driver.attempts", {
	description: "LLM driver stream attempts by outcome, provider, and model",
});
const llmDriverRetries = counter("bound.llm.driver.retries", {
	description: "LLM driver stream retries by reason, provider, and model",
});
const llmRequestDuration = histogram("bound.llm.request.duration", {
	description: "Physical LLM request duration",
	unit: "s",
});
const llmTimeToFirstToken = histogram("bound.llm.request.time_to_first_token", {
	description: "Physical LLM request time to first content token",
	unit: "s",
});
const llmUsageTokens = counter("bound.llm.usage.tokens", {
	description: "LLM usage tokens by token type, provider, and model",
});
const llmCost = counter("bound.llm.cost", {
	description: "Authoritative LLM request cost where supplied",
	unit: "USD",
});

type LlmDriverMetricName = "attempt" | "retry" | "duration" | "ttft" | "tokens" | "cost";
type LlmDriverMetricRecorder = (
	name: LlmDriverMetricName,
	value: number,
	attributes: Record<string, string>,
) => void;

let testMetricRecorder: LlmDriverMetricRecorder | undefined;

export function setLlmDriverMetricRecorderForTest(recorder?: LlmDriverMetricRecorder): void {
	testMetricRecorder = recorder;
}

function recordLlmDriverMetric(
	name: LlmDriverMetricName,
	value: number,
	attributes: Record<string, string>,
): void {
	testMetricRecorder?.(name, value, attributes);
	if (name === "attempt") llmDriverAttempts.add(value, attributes);
	else if (name === "retry") llmDriverRetries.add(value, attributes);
	else if (name === "duration") llmRequestDuration.record(value, attributes);
	else if (name === "ttft") llmTimeToFirstToken.record(value, attributes);
	else if (name === "tokens") llmUsageTokens.add(value, attributes);
	else llmCost.add(value, attributes);
}

export interface ProviderFetchConfig {
	fetch?: typeof fetch;
	logger?: Logger;
	connectTimeoutMs?: number;
}

export function resolveProviderFetch(
	providerName: string,
	config: ProviderFetchConfig,
): typeof fetch | undefined {
	return (
		config.fetch ??
		(config.logger
			? createLoggingFetch(config.logger, providerName, config.connectTimeoutMs)
			: undefined)
	);
}

export interface ProviderStreamParams {
	providerName: string;
	modelId?: string;
	stream: () => AsyncIterable<unknown>;
	map?: Omit<MapChunksOptions, "providerName">;
	/**
	 * Abort signal, consulted by the empty-completion retry so a cancelled turn
	 * is not re-issued. When omitted, retries proceed (the bounded count caps
	 * them regardless).
	 */
	signal?: AbortSignal;
}

export async function* mapProviderStream(params: ProviderStreamParams): AsyncIterable<StreamChunk> {
	try {
		yield* mapChunks(params.stream(), {
			...params.map,
			providerName: params.providerName,
		});
	} catch (err) {
		throw mapError(err, params.providerName);
	}
}

export async function* runProviderStream(params: ProviderStreamParams): AsyncIterable<StreamChunk> {
	yield { type: "heartbeat" };
	// Universal empty-completion retry: every driver routing through here gets
	// the same protection a dropped/empty stream needs, rather than each driver
	// hand-rolling it. A fully-empty turn (no thinking/text/tool) would
	// otherwise slip past the agent loop's degenerate-turn guard (which keys on
	// thinking) and record as a silent success. mapProviderStream re-invokes the
	// fresh `stream` thunk per attempt, so a re-issue is a clean new request.
	yield* withEmptyRetry(() => mapProviderStream(params), {
		maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
		isAborted: () => params.signal?.aborted ?? false,
		providerName: params.providerName,
		modelId: params.modelId,
	});
}

/** Default bound for {@link withEmptyRetry} re-issues. */
export const EMPTY_COMPLETION_MAX_RETRIES = 2;

/**
 * Wraps a streaming attempt with a bounded retry for *empty* completions — a
 * turn that finishes with `output_tokens === 0` and emitted no content. Two
 * providers produce these intermittently: Mantle GPT-5.x under the required
 * `store: false` (~12% at the bare endpoint), and the umans/Anthropic relay
 * path when a stream drops before emitting any chunk.
 *
 * The retry is safe because an empty turn yields ONLY a terminal `done` chunk
 * (no `text` / `thinking` / `tool_use_*`), so discarding that `done` and
 * re-issuing duplicates nothing the consumer has seen. The moment any
 * substantive chunk is yielded, `sawContent` latches and the turn can no
 * longer be retried — content already on the wire cannot be un-yielded, so a
 * streamed turn whose usage happens to round to 0 is passed through as-is.
 * Errors are not retried: `mapChunks` throws on error events, which propagates
 * out to the driver's existing `mapError` path.
 */
export function withEmptyRetry(
	runAttempt: () => AsyncIterable<StreamChunk>,
	opts: {
		maxRetries: number;
		isAborted: () => boolean;
		onRetry?: (attempt: number) => void;
		/** Stable backend label for bounded metric dimensions. */
		providerName?: string;
		/** Stable configured model identifier, when known at the driver call site. */
		modelId?: string;
	},
): AsyncIterable<StreamChunk> {
	// `async function*` bodies do not execute until their first `next()`. The
	// agent loop creates this stream under loop.turn, then its timeout wrapper
	// advances it later. Preserve that initiating context so the physical request
	// remains a child of the turn rather than becoming a new trace root.
	const parentContext = context.active();

	return bindAsyncIterable(
		parentContext,
		(async function* (): AsyncIterable<StreamChunk> {
			for (let attempt = 0; ; attempt++) {
				const startedAt = performance.now();
				const provider = opts.providerName ?? "unknown";
				const model = opts.modelId ?? "unknown";
				const dimensions = { provider, model };
				const tracer = trace.getTracer("bound.llm");
				const requestSpan = tracer.startSpan("llm.provider.request", {
					attributes: {
						"llm.provider": provider,
						"llm.model": model,
						"llm.retry": attempt,
					},
				});
				const requestContext = trace.setSpan(context.active(), requestSpan);
				const isLastAttempt = attempt >= opts.maxRetries;
				let sawContent = false;
				let retrying = false;
				let sawDone = false;
				let recordedTtft = false;
				let outcome = "incomplete";
				let iterator: AsyncIterator<StreamChunk> | undefined;
				try {
					iterator = context.with(requestContext, () => runAttempt()[Symbol.asyncIterator]());
					for (;;) {
						const next = await context.with(requestContext, () => iterator?.next());
						if (!next || next.done) break;
						const chunk = next.value;
						if (chunk.type === "done") {
							sawDone = true;
							const isEmpty = !sawContent && chunk.usage.output_tokens === 0;
							if (isEmpty && !isLastAttempt && !opts.isAborted()) {
								// Swallow this empty `done` and re-issue. Nothing substantive
								// was yielded, so the consumer never sees the discarded turn.
								requestSpan.addEvent("llm.retry", { "llm.retry.reason": "empty_completion" });
								requestSpan.setStatus({ code: SpanStatusCode.ERROR, message: "empty completion" });
								outcome = "retry";
								recordLlmDriverMetric("attempt", 1, { ...dimensions, outcome });
								recordLlmDriverMetric("retry", 1, { ...dimensions, reason: "empty_completion" });
								opts.onRetry?.(attempt + 1);
								retrying = true;
								break;
							}
							outcome = isEmpty ? "empty" : "success";
							recordLlmDriverMetric("attempt", 1, { ...dimensions, outcome });
							requestSpan.setAttribute("llm.outcome", outcome);
							for (const [type, value] of [
								["input", chunk.usage.input_tokens],
								["output", chunk.usage.output_tokens],
								["cache_write", chunk.usage.cache_write_tokens],
								["cache_read", chunk.usage.cache_read_tokens],
							] as const) {
								if (value !== null) recordLlmDriverMetric("tokens", value, { ...dimensions, type });
							}
							if (chunk.cost_usd !== undefined) {
								recordLlmDriverMetric("cost", chunk.cost_usd, dimensions);
							}
							requestSpan.setStatus({ code: SpanStatusCode.OK });
							yield chunk;
							return;
						}
						if (
							chunk.type === "text" ||
							chunk.type === "thinking" ||
							chunk.type === "tool_use_start" ||
							chunk.type === "tool_use_args" ||
							chunk.type === "tool_use_end"
						) {
							sawContent = true;
							if (!recordedTtft) {
								recordedTtft = true;
								recordLlmDriverMetric(
									"ttft",
									Math.max(0, performance.now() - startedAt) / 1000,
									dimensions,
								);
							}
						}
						yield chunk;
					}

					if (!retrying) {
						if (!sawDone) {
							outcome = opts.isAborted() ? "aborted" : "incomplete";
							recordLlmDriverMetric("attempt", 1, { ...dimensions, outcome });
							requestSpan.setAttribute("llm.outcome", outcome);
							requestSpan.setStatus({
								code: SpanStatusCode.ERROR,
								message:
									outcome === "aborted" ? "provider stream aborted" : "stream ended without done",
							});
						}
						return;
					}
				} catch (error) {
					requestSpan.recordException(error instanceof Error ? error : new Error(String(error)));
					outcome = "error";
					requestSpan.setAttribute("llm.outcome", outcome);
					requestSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: error instanceof Error ? error.message : "provider stream failed",
					});
					recordLlmDriverMetric("attempt", 1, { ...dimensions, outcome });
					throw error;
				} finally {
					if (retrying && iterator?.return) {
						await context.with(requestContext, () => iterator?.return?.());
					}
					recordLlmDriverMetric("duration", Math.max(0, performance.now() - startedAt) / 1000, {
						...dimensions,
						outcome,
					});
					requestSpan.end();
				}
			}
		})(),
	);
}

/**
 * Keeps an async generator's resumptions in the context active at stream
 * creation. This is deliberately iterator-scoped: it restores that context
 * only while advancing or closing this stream and does not alter its consumer.
 */
export function bindAsyncIterable<T>(
	parentContext: ReturnType<typeof context.active>,
	source: AsyncIterable<T>,
): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<T> {
			const iterator = source[Symbol.asyncIterator]();
			return {
				next: (value?: unknown) => context.with(parentContext, () => iterator.next(value)),
				return: async (value?: unknown): Promise<IteratorResult<T>> =>
					context.with(parentContext, async () => {
						if (iterator.return) return iterator.return(value);
						return { done: true, value: value as T };
					}),
				throw: async (error?: unknown): Promise<IteratorResult<T>> =>
					context.with(parentContext, async () => {
						if (iterator.throw) return iterator.throw(error);
						throw error;
					}),
			};
		},
	};
}
