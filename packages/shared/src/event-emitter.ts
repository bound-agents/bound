import { EventEmitter } from "node:events";
import type { EventMap } from "./events.js";

export class TypedEventEmitter {
	private emitter = new EventEmitter();

	emit<K extends keyof EventMap>(event: K, data: EventMap[K]): boolean {
		return this.emitter.emit(event as string, data);
	}

	on<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): this {
		this.emitter.on(event as string, listener);
		return this;
	}

	off<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): this {
		this.emitter.off(event as string, listener);
		return this;
	}

	once<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): this {
		this.emitter.once(event as string, listener);
		return this;
	}
}
