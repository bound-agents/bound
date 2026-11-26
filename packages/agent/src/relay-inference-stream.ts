import { Subject } from "rxjs";

import type { InferenceRequestPayload, StreamChunk } from "@bound/llm";

import type { EligibleHost } from "./relay-router";
import { type RelayStreamDeps, createRelayStream$ } from "./relay-stream$";
import { observableToAsyncIterable } from "./rx-async-iterable";

/**
 * Wraps `createRelayStream$` (Observable) as an async generator, so callers
 * that don't use rxjs directly (e.g. the web `/api/inference` route) can
 * consume relay inference as a plain async iterable.
 */
export async function* createRelayInferenceStream(
	deps: RelayStreamDeps,
	payload: InferenceRequestPayload,
	hosts: EligibleHost[],
	signal?: AbortSignal,
): AsyncGenerator<StreamChunk, void, unknown> {
	if (hosts.length === 0) return;
	const aborted$ = new Subject<void>();
	if (signal) {
		if (signal.aborted) {
			aborted$.next();
			aborted$.complete();
		} else {
			signal.addEventListener(
				"abort",
				() => {
					aborted$.next();
					aborted$.complete();
				},
				{ once: true },
			);
		}
	}

	const stream$ = createRelayStream$(deps, payload, hosts, aborted$);

	try {
		yield* observableToAsyncIterable(stream$);
	} finally {
		aborted$.complete();
	}
}
