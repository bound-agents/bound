import { describe, expect, it } from "bun:test";
import { STATUS_WEIGHT, sortTasks } from "../task-sort";

interface Task {
	id: string;
	status: "running" | "failed" | "pending" | "claimed" | "cancelled" | "completed";
	next_run_at: string | null;
	last_run_at: string | null;
}

describe("sortTasks", () => {
	it("should export STATUS_WEIGHT map", () => {
		expect(STATUS_WEIGHT).toBeDefined();
		expect(STATUS_WEIGHT.running).toBe(0);
		expect(STATUS_WEIGHT.failed).toBe(1);
		expect(STATUS_WEIGHT.pending).toBe(2);
		expect(STATUS_WEIGHT.claimed).toBe(2);
		expect(STATUS_WEIGHT.cancelled).toBe(3);
		expect(STATUS_WEIGHT.completed).toBe(4);
	});

	it("should sort running tasks before failed tasks", () => {
		const tasks: Task[] = [
			{
				id: "1",
				status: "failed",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "2",
				status: "running",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].status).toBe("running");
		expect(sorted[1].status).toBe("failed");
	});

	it("should sort failed tasks before pending tasks", () => {
		const tasks: Task[] = [
			{
				id: "1",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "2",
				status: "failed",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].status).toBe("failed");
		expect(sorted[1].status).toBe("pending");
	});

	it("should sort pending tasks before cancelled tasks", () => {
		const tasks: Task[] = [
			{
				id: "1",
				status: "cancelled",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "2",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].status).toBe("pending");
		expect(sorted[1].status).toBe("cancelled");
	});

	it("should sort cancelled tasks before completed tasks", () => {
		const tasks: Task[] = [
			{
				id: "1",
				status: "completed",
				next_run_at: null,
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "2",
				status: "cancelled",
				next_run_at: null,
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].status).toBe("cancelled");
		expect(sorted[1].status).toBe("completed");
	});

	it("should sort by next_run_at ascending within same status group", () => {
		const tasks: Task[] = [
			{
				id: "1",
				status: "pending",
				next_run_at: "2026-04-14T15:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "2",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "3",
				status: "pending",
				next_run_at: "2026-04-14T12:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].id).toBe("2"); // 10:00
		expect(sorted[1].id).toBe("3"); // 12:00
		expect(sorted[2].id).toBe("1"); // 15:00
	});

	it("should sort null next_run_at to end within same status group", () => {
		const tasks: Task[] = [
			{
				id: "1",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "2",
				status: "pending",
				next_run_at: null,
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "3",
				status: "pending",
				next_run_at: "2026-04-14T12:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].id).toBe("1"); // 10:00
		expect(sorted[1].id).toBe("3"); // 12:00
		expect(sorted[2].id).toBe("2"); // null
	});

	it("should use last_run_at as tertiary sort (descending)", () => {
		const tasks: Task[] = [
			{
				id: "1",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T08:00:00Z",
			},
			{
				id: "2",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		// Same next_run_at, so sorted by last_run_at descending
		expect(sorted[0].id).toBe("2"); // 10:00
		expect(sorted[1].id).toBe("1"); // 08:00
	});

	it("should handle claimed status like pending", () => {
		const tasks: Task[] = [
			{
				id: "1",
				status: "failed",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "2",
				status: "claimed",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].status).toBe("failed");
		expect(sorted[1].status).toBe("claimed");
	});

	it("should return new array without mutating input", () => {
		const tasks: Task[] = [
			{
				id: "2",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "1",
				status: "running",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const original = [...tasks];
		const sorted = sortTasks(tasks);

		expect(sorted).not.toBe(tasks);
		expect(tasks).toEqual(original);
		expect(sorted[0].id).toBe("1");
	});
});
