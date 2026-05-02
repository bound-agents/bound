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

	it("should sort by next_run_at descending as primary sort", () => {
		const tasks: Task[] = [
			{
				id: "sooner",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: null,
			},
			{
				id: "later",
				status: "failed",
				next_run_at: "2026-04-14T15:00:00Z",
				last_run_at: null,
			},
			{
				id: "middle",
				status: "running",
				next_run_at: "2026-04-14T12:00:00Z",
				last_run_at: null,
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].id).toBe("later");
		expect(sorted[1].id).toBe("middle");
		expect(sorted[2].id).toBe("sooner");
	});

	it("should sort null next_run_at to end", () => {
		const tasks: Task[] = [
			{
				id: "no-next",
				status: "completed",
				next_run_at: null,
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "has-next",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: null,
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].id).toBe("has-next");
		expect(sorted[1].id).toBe("no-next");
	});

	it("should sort by status weight as secondary when next_run_at matches", () => {
		const sameTime = "2026-04-14T10:00:00Z";
		const tasks: Task[] = [
			{
				id: "pending-task",
				status: "pending",
				next_run_at: sameTime,
				last_run_at: null,
			},
			{
				id: "running-task",
				status: "running",
				next_run_at: sameTime,
				last_run_at: null,
			},
			{
				id: "failed-task",
				status: "failed",
				next_run_at: sameTime,
				last_run_at: null,
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].id).toBe("running-task");
		expect(sorted[1].id).toBe("failed-task");
		expect(sorted[2].id).toBe("pending-task");
	});

	it("should sort by last_run_at descending as tertiary", () => {
		const sameTime = "2026-04-14T10:00:00Z";
		const tasks: Task[] = [
			{
				id: "older",
				status: "pending",
				next_run_at: sameTime,
				last_run_at: "2026-04-13T08:00:00Z",
			},
			{
				id: "newer",
				status: "pending",
				next_run_at: sameTime,
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].id).toBe("newer");
		expect(sorted[1].id).toBe("older");
	});

	it("should sort running tasks before failed tasks at same next_run_at", () => {
		const sameTime = "2026-04-14T10:00:00Z";
		const tasks: Task[] = [
			{
				id: "1",
				status: "failed",
				next_run_at: sameTime,
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "2",
				status: "running",
				next_run_at: sameTime,
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].status).toBe("running");
		expect(sorted[1].status).toBe("failed");
	});

	it("should sort cancelled and completed (null next_run_at) by status weight", () => {
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
				next_run_at: "2026-04-14T12:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "1",
				status: "running",
				next_run_at: "2026-04-14T15:00:00Z",
				last_run_at: "2026-04-13T10:00:00Z",
			},
		];

		const original = [...tasks];
		const sorted = sortTasks(tasks);

		expect(sorted).not.toBe(tasks);
		expect(tasks).toEqual(original);
		expect(sorted[0].id).toBe("1");
	});

	it("should sort tasks with next_run_at above completed tasks without", () => {
		const tasks: Task[] = [
			{
				id: "completed-old",
				status: "completed",
				next_run_at: null,
				last_run_at: "2026-04-13T10:00:00Z",
			},
			{
				id: "heartbeat-upcoming",
				status: "pending",
				next_run_at: "2026-04-14T10:00:00Z",
				last_run_at: "2026-04-14T07:00:00Z",
			},
		];

		const sorted = sortTasks(tasks);

		expect(sorted[0].id).toBe("heartbeat-upcoming");
		expect(sorted[1].id).toBe("completed-old");
	});
});
