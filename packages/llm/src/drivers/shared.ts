import type { Logger } from "@bound/shared";
import { type MapChunksOptions, mapChunks, mapError } from "../bridge";
import { createLoggingFetch } from "../fetch-logger";
import type { StreamChunk } from "../types";

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
export async function* withEmptyRetry(
	runAttempt: () => AsyncIterable<StreamChunk>,
	opts: {
		maxRetries: number;
		isAborted: () => boolean;
		onRetry?: (attempt: number) => void;
	},
): AsyncIterable<StreamChunk> {
	for (let attempt = 0; ; attempt++) {
		const isLastAttempt = attempt >= opts.maxRetries;
		let sawContent = false;
		let retrying = false;

		for await (const chunk of runAttempt()) {
			if (chunk.type === "done") {
				const isEmpty = !sawContent && chunk.usage.output_tokens === 0;
				if (isEmpty && !isLastAttempt && !opts.isAborted()) {
					// Swallow this empty `done` and re-issue. Nothing substantive
					// was yielded, so the consumer never sees the discarded turn.
					opts.onRetry?.(attempt + 1);
					retrying = true;
					break;
				}
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
			}
			yield chunk;
		}

		// Stream ended without a `done` and we are not retrying (e.g. aborted
		// mid-flight): nothing more to emit.
		if (!retrying) return;
	}
}
