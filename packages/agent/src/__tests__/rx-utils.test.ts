import { beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { fromEventBus } from "../rx-utils.js";

describe("rx-utils", () => {
	describe("fromEventBus", () => {
		let emitter: TypedEventEmitter;

		beforeEach(() => {
			emitter = new TypedEventEmitter();
		});

		it("emits event data when eventBus fires the subscribed event", (done) => {
			const results: string[] = [];

			const subscription = fromEventBus(emitter, "task:triggered").subscribe({
				next: (data) => {
					results.push(data.task_id);
				},
			});

			emitter.emit("task:triggered", { task_id: "task-1", trigger: "manual" });
			emitter.emit("task:triggered", { task_id: "task-2", trigger: "manual" });

			setTimeout(() => {
				expect(results).toEqual(["task-1", "task-2"]);
				subscription.unsubscribe();
				done();
			}, 10);
		});

		it("does not emit for unrelated events", (done) => {
			const results: unknown[] = [];
			const subscription = fromEventBus(emitter, "task:triggered").subscribe({
				next: (data) => {
					results.push(data);
				},
			});

			emitter.emit("file:changed", {
				path: "/test",
				operation: "created",
			});

			emitter.emit("task:triggered", { task_id: "task-1", trigger: "manual" });

			setTimeout(() => {
				expect(results.length).toBe(1);
				expect(results[0]).toEqual({ task_id: "task-1", trigger: "manual" });
				subscription.unsubscribe();
				done();
			}, 10);
		});

		it("stops receiving after unsubscribe (verifies .off() teardown)", (done) => {
			const results: string[] = [];

			const subscription = fromEventBus(emitter, "task:triggered").subscribe({
				next: (data) => {
					results.push(data.task_id);
				},
			});

			emitter.emit("task:triggered", { task_id: "task-1", trigger: "manual" });

			subscription.unsubscribe();

			emitter.emit("task:triggered", { task_id: "task-2", trigger: "manual" });

			setTimeout(() => {
				expect(results).toEqual(["task-1"]);
				done();
			}, 10);
		});

		it("multiple subscribers each receive events independently", (done) => {
			const results1: string[] = [];
			const results2: string[] = [];

			const sub1 = fromEventBus(emitter, "task:triggered").subscribe({
				next: (data) => {
					results1.push(data.task_id);
				},
			});

			const sub2 = fromEventBus(emitter, "task:triggered").subscribe({
				next: (data) => {
					results2.push(data.task_id);
				},
			});

			emitter.emit("task:triggered", { task_id: "task-1", trigger: "manual" });
			emitter.emit("task:triggered", { task_id: "task-2", trigger: "manual" });

			setTimeout(() => {
				expect(results1).toEqual(["task-1", "task-2"]);
				expect(results2).toEqual(["task-1", "task-2"]);
				sub1.unsubscribe();
				sub2.unsubscribe();
				done();
			}, 10);
		});
	});
});
