import type {
	BackendCapabilities,
	ChatParams,
	InferenceRequestPayload,
	LLMBackend,
	StreamChunk,
} from "@bound/llm";
import { NEVER, Observable } from "rxjs";
import type { EligibleHost } from "./relay-router";
import { createRelayStream$ } from "./relay-stream$";
import type { RelayStreamDeps } from "./relay-stream$";

export type RelayBackendDeps = RelayStreamDeps;

/**
 * Wraps an abort signal as an Observable that emits once when the signal
 * fires (or immediately, if already aborted). `createRelayStream$` consumes
 * this via `takeUntil` to tear the stream down and write a relay `cancel`.
 */
function abortSignalToObservable(signal?: AbortSignal): Observable<unknown> {
	if (!signal) return NEVER;
	return new Observable((subscriber) => {
		if (signal.aborted) {
			subscriber.next(undefined);
			return;
		}
		const onAbort = () => subscriber.next(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		return () => signal.removeEventListener("abort", onAbort);
	});
}

/**
 * Bridges an RxJS Observable into an AsyncIterable, buffering values that
 * arrive between `next()` pulls. Errors surface on the awaiting pull;
 * completion ends iteration. Unsubscribes on early break / throw.
 */
async function* observableToAsyncIterable<T>(source: Observable<T>): AsyncIterable<T> {
	const queue: T[] = [];
	let wake: (() => void) | null = null;
	let done = false;
	let error: unknown = null;

	const sub = source.subscribe({
		next: (value) => {
			queue.push(value);
			wake?.();
			wake = null;
		},
		error: (err) => {
			error = err;
			done = true;
			wake?.();
			wake = null;
		},
		complete: () => {
			done = true;
			wake?.();
			wake = null;
		},
	});

	try {
		while (true) {
			if (queue.length > 0) {
				yield queue.shift() as T;
				continue;
			}
			if (error) throw error;
			if (done) return;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	} finally {
		sub.unsubscribe();
	}
}

/**
 * An {@link LLMBackend} that satisfies a single `chat()` call by delegating
 * inference over the relay to an eligible remote host, instead of holding a
 * local model handle. Used by callers that need inference on a host with no
 * local backend (e.g. summary extraction on a hub-only spoke): acquisition is
 * the only thing that changes — the caller still consumes a `StreamChunk`
 * AsyncIterable exactly as it would from a direct backend.
 *
 * `modelId` is the logical alias (e.g. `"opus"`) carried in the relay
 * `InferenceRequestPayload.model`; the receiving host resolves it against its
 * own configured backends. This is the SEND side of the relay, so stamping the
 * alias here is correct and does not conflict with invariant #11 (which forbids
 * the RECEIVING relay-processor from passing `payload.model` to its local
 * `.chat()`).
 */
export function createRelayBackend(
	deps: RelayBackendDeps,
	hosts: EligibleHost[],
	modelId: string,
	timeoutMs: number,
): LLMBackend {
	return {
		chat(params: ChatParams): AsyncIterable<StreamChunk> {
			if (!params.threadId) {
				throw new Error("Relayed inference requires a Bound threadId");
			}
			// This relay path carries ad-hoc messages (e.g. loop-end summary
			// extraction), NOT a thread's assembled history — they don't correspond
			// to synced message rows, so there is no range to point at. Ship every
			// message as an inline segment (the all-inline degenerate of the single
			// segment wire format, R-UD3). nowMs is the send instant; with no range
			// segment to resolve, the consumer never uses it for re-annotation.
			const payload: InferenceRequestPayload = {
				threadId: params.threadId,
				model: modelId,
				segments: params.messages.map((message) => ({ kind: "inline" as const, message })),
				nowMs: Date.now(),
				timeout_ms: timeoutMs,
			};
			if (params.tools !== undefined) payload.tools = params.tools;
			if (params.system !== undefined) payload.system = params.system;
			if (params.max_tokens !== undefined) payload.max_tokens = params.max_tokens;
			if (params.temperature !== undefined) payload.temperature = params.temperature;
			if (params.thinking !== undefined) payload.thinking = params.thinking;
			if (params.effort !== undefined) payload.effort = params.effort;
			if (params.cache_ttl !== undefined) payload.cache_ttl = params.cache_ttl;

			const stream$ = createRelayStream$(
				deps,
				payload,
				hosts,
				abortSignalToObservable(params.signal),
				undefined,
				{ perHostTimeoutMs: timeoutMs },
			);
			return observableToAsyncIterable(stream$);
		},
		capabilities(): BackendCapabilities {
			// Permissive stub: the real capability surface belongs to whichever
			// remote backend services the request. We only assert that we stream.
			return {
				streaming: true,
				tool_use: false,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				extended_thinking: false,
				max_context: 0,
			};
		},
	};
}
