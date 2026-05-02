import { beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { Subject } from "rxjs";
import { take } from "rxjs/operators";
import { TestScheduler } from "rxjs/testing";
import { fromEventBus, pollDb } from "../rx-utils.js";

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

	describe("pollDb", () => {
		it("emits non-null query results on each interval tick", (done) => {
			const results: string[] = [];

			let callCount = 0;
			const query = () => {
				callCount++;
				return callCount <= 2 ? `result-${callCount}` : null;
			};

			pollDb(query, { intervalMs: 10 })
				.pipe(take(2))
				.subscribe({
					next: (value) => {
						results.push(value);
					},
					complete: () => {
						expect(results).toEqual(["result-1", "result-2"]);
						done();
					},
				});
		});

		it("filters out null results — query returning null should not produce emissions", (done) => {
			const results: string[] = [];

			let callCount = 0;
			const query = () => {
				callCount++;
				if (callCount === 1 || callCount === 4) return `result-${callCount}`;
				return null;
			};

			pollDb(query, { intervalMs: 10 })
				.pipe(take(2))
				.subscribe({
					next: (value) => {
						results.push(value);
					},
					complete: () => {
						expect(results).toEqual(["result-1", "result-4"]);
						done();
					},
				});
		});

		it("wakeup observable triggers immediate poll outside the interval schedule", (done) => {
			const results: string[] = [];
			let callCount = 0;
			const query = () => {
				callCount++;
				return callCount <= 3 ? `result-${callCount}` : null;
			};

			const wakeup$ = new Subject();

			pollDb(query, { intervalMs: 50, wakeup$ })
				.pipe(take(3))
				.subscribe({
					next: (value) => {
						results.push(value);
					},
					complete: () => {
						expect(results.length).toBeGreaterThanOrEqual(2);
						expect(results[0]).toBe("result-1");
						done();
					},
				});

			// Trigger wakeup immediately
			wakeup$.next(null);
		});

		it("both interval and wakeup emissions are merged — values from either source appear in output", (done) => {
			const results: string[] = [];
			let callCount = 0;
			const query = () => {
				callCount++;
				return callCount <= 2 ? `result-${callCount}` : null;
			};

			const wakeup$ = new Subject();

			pollDb(query, { intervalMs: 50, wakeup$ })
				.pipe(take(2))
				.subscribe({
					next: (value) => {
						results.push(value);
					},
					complete: () => {
						expect(results.length).toBe(2);
						expect(results[0]).toBe("result-1");
						expect(results[1]).toBe("result-2");
						done();
					},
				});

			// Trigger wakeup immediately
			wakeup$.next(null);
		});

		it("scheduler injection works — interval respects the provided scheduler", (done) => {
			const scheduler = new TestScheduler((actual, expected) => {
				expect(actual).toEqual(expected);
			});

			scheduler.run(() => {
				let callCount = 0;
				const query = () => {
					callCount++;
					return callCount <= 2 ? `result-${callCount}` : null;
				};

				const result$ = pollDb(query, { intervalMs: 10, scheduler }).pipe(take(2));

				// Verify scheduler is used by collecting emissions in virtual time
				const values: string[] = [];
				const subscription = result$.subscribe({
					next: (v) => values.push(v),
					complete: () => {
						expect(values).toEqual(["result-1", "result-2"]);
						subscription.unsubscribe();
						done();
					},
				});
			});
		});
	});
});
