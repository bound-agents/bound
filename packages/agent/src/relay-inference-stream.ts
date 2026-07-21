import { Subject } from "rxjs";

import type { InferenceRequestPayload, StreamChunk } from "@bound/llm";

import type { EligibleHost } from "./relay-router";
import { type RelayStreamDeps, createRelayStream$ } from "./relay-stream$";

/**
 * Wraps `createRelayStream$` (Observable) as an async generator, so callers
 * that don't use rxjs directly (e.g. the web `/api/inference` route) can
 * consume relay inference as a plain async iterable.
 *
 * Internally bridges Observable→AsyncIterable the same way
 * `bound-agent-loop.observableToAsyncIterable` does.
 */
export async function* createRelayInferenceStream(
	deps: RelayStreamDeps,
	payload: InferenceRequestPayload,
	hosts: EligibleHost[],
	signal?: AbortSignal,
): AsyncGenerator<StreamChunk, void, unknown> {
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

	const queue: StreamChunk[] = [];
	let completed = false;
	let streamError: unknown;
	let wake: (() => void) | undefined;

	const subscription = stream$.subscribe({
		next(value: StreamChunk) {
			queue.push(value);
			wake?.();
			wake = undefined;
		},
		error(err: unknown) {
			streamError = err;
			completed = true;
			wake?.();
			wake = undefined;
		},
		complete() {
			completed = true;
			wake?.();
			wake = undefined;
		},
	});

	try {
		while (!completed || queue.length > 0) {
			if (queue.length > 0) {
				yield queue.shift() as StreamChunk;
				continue;
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
			if (streamError !== undefined) throw streamError;
		}
	} finally {
		subscription.unsubscribe();
		aborted$.complete();
	}
}
