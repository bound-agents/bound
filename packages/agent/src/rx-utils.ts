import type { EventMap, TypedEventEmitter } from "@bound/shared";
import { Observable } from "rxjs";

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
