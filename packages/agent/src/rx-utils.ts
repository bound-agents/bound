import type { EventMap, TypedEventEmitter } from "@bound/shared";
import { Observable, type SchedulerLike, filter, interval, map, merge } from "rxjs";

export function fromEventBus<K extends keyof EventMap>(
	eventBus: TypedEventEmitter,
	event: K,
): Observable<EventMap[K]> {
	return new Observable<EventMap[K]>((subscriber) => {
		const listener = (data: EventMap[K]) => {
			subscriber.next(data);
		};
		eventBus.on(event, listener);
		return () => {
			eventBus.off(event, listener);
		};
	});
}

export function pollDb<T>(
	query: () => T | null,
	opts: {
		intervalMs: number;
		wakeup$?: Observable<unknown>;
		scheduler?: SchedulerLike;
	},
): Observable<T> {
	const tick$ = opts.scheduler
		? interval(opts.intervalMs, opts.scheduler)
		: interval(opts.intervalMs);

	const source$ = opts.wakeup$ ? merge(tick$, opts.wakeup$) : tick$;

	return source$.pipe(
		map(() => query()),
		filter((v): v is T => v !== null),
	);
}
