import {
	type BackendCapabilities,
	type ChatParams,
	DEFAULT_BACKEND_CAPABILITIES,
	type DriverFallbackSupport,
	type InferenceRequestPayload,
	type LLMBackend,
	type StreamChunk,
} from "@bound/llm";
import { NEVER, Observable } from "rxjs";
import type { EligibleHost } from "./relay-router";
import { type RelayStreamDeps, createRelayStream$ } from "./relay-stream$";
import { observableToAsyncIterable } from "./rx-async-iterable";

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
			if (params.fallback_policy !== undefined) payload.fallback_policy = params.fallback_policy;
			if (params.fallback_models !== undefined) payload.fallback_models = params.fallback_models;

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
			// The real capability surface belongs to whichever remote backend
			// services the request; the carrier only asserts that it streams.
			return { ...DEFAULT_BACKEND_CAPABILITIES, streaming: true, system_prompt: true };
		},
		fallbackSupport(): DriverFallbackSupport {
			// Permissive stub: the relay carrier itself does no server-side fallback
			// or credit redemption — that happens on whichever remote backend actually
			// services the request. Advertise no fallback protocol here so the loop
			// host treats a relayed refusal as a plain loop-host-router fallback.
			return {
				server_side_auto: false,
				publishes_allowed_targets: false,
				supports_fallback_credit: false,
			};
		},
	};
}
