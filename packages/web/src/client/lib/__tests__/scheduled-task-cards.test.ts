import { describe, expect, it } from "bun:test";
import { extractScheduledTaskRefs } from "../scheduled-task-cards";

const UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const UUID2 = "11111111-2222-3333-4444-555555555555";

describe("extractScheduledTaskRefs", () => {
	it("returns a ref for a successful schedule call", () => {
		const refs = extractScheduledTaskRefs(
			[{ id: "tu1", name: "task", input: { action: "schedule" } }],
			{ tu1: { content: UUID } },
		);
		expect(refs).toEqual([{ toolUseId: "tu1", taskId: UUID }]);
	});

	it("trims whitespace around the task id", () => {
		const refs = extractScheduledTaskRefs(
			[{ id: "tu1", name: "task", input: { action: "schedule" } }],
			{ tu1: { content: `\n${UUID}\n` } },
		);
		expect(refs[0]?.taskId).toBe(UUID);
	});

	it("skips non-task tool calls", () => {
		const refs = extractScheduledTaskRefs(
			[{ id: "tu1", name: "query", input: { sql: "SELECT 1" } }],
			{ tu1: { content: UUID } },
		);
		expect(refs).toEqual([]);
	});

	it("skips task updates (no new thread is spawned)", () => {
		const refs = extractScheduledTaskRefs(
			[{ id: "tu1", name: "task", input: { action: "update", task_id: UUID } }],
			{ tu1: { content: `Updated task ${UUID} (model_hint)` } },
		);
		expect(refs).toEqual([]);
	});

	it("skips calls still awaiting a result", () => {
		const refs = extractScheduledTaskRefs(
			[{ id: "tu1", name: "task", input: { action: "schedule" } }],
			{},
		);
		expect(refs).toEqual([]);
	});

	it("skips failed schedule calls (non-zero exit)", () => {
		const refs = extractScheduledTaskRefs(
			[{ id: "tu1", name: "task", input: { action: "schedule" } }],
			{ tu1: { content: "Error: bad cron", exit_code: 1 } },
		);
		expect(refs).toEqual([]);
	});

	it("skips results whose content is not a bare task UUID", () => {
		const refs = extractScheduledTaskRefs(
			[{ id: "tu1", name: "task", input: { action: "schedule" } }],
			{ tu1: { content: "scheduled successfully" } },
		);
		expect(refs).toEqual([]);
	});

	it("handles a malformed (non-object) input without throwing", () => {
		const refs = extractScheduledTaskRefs(
			[
				{ id: "tu1", name: "task", input: null },
				{ id: "tu2", name: "task", input: "schedule" },
			],
			{ tu1: { content: UUID }, tu2: { content: UUID } },
		);
		expect(refs).toEqual([]);
	});

	it("collects multiple scheduled tasks in order", () => {
		const refs = extractScheduledTaskRefs(
			[
				{ id: "tu1", name: "task", input: { action: "schedule" } },
				{ id: "tu2", name: "query", input: {} },
				{ id: "tu3", name: "task", input: { action: "schedule" } },
			],
			{
				tu1: { content: UUID, exit_code: 0 },
				tu2: { content: "rows" },
				tu3: { content: UUID2 },
			},
		);
		expect(refs).toEqual([
			{ toolUseId: "tu1", taskId: UUID },
			{ toolUseId: "tu3", taskId: UUID2 },
		]);
	});
});
