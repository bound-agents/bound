import { describe, expect, it } from "bun:test";
import { extractAuxInvokeRefs } from "../aux-invoke-cards";

const THREAD = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const THREAD2 = "11111111-2222-3333-4444-555555555555";

describe("extractAuxInvokeRefs", () => {
	it("resolves a completed foreground invoke from the Thread trailer", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
			{ tu1: { content: `Found 3 call sites, all guarded.\n\nThread: ${THREAD}` } },
		);
		expect(refs).toEqual([
			{ toolUseId: "tu1", agentName: "scout", threadId: THREAD, status: "completed" },
		]);
	});

	it("reports running with no thread link while the result is pending", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
			{},
		);
		expect(refs).toEqual([
			{ toolUseId: "tu1", agentName: "scout", threadId: null, status: "running" },
		]);
	});

	it("resolves a background placeholder to running with the queued thread id", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
			{
				tu1: {
					content: `Auxiliary agent 'scout' queued on thread ${THREAD} — running in background. Result will arrive when complete.`,
				},
			},
		);
		expect(refs).toEqual([
			{ toolUseId: "tu1", agentName: "scout", threadId: THREAD, status: "running" },
		]);
	});

	it("marks an invoke error result as failed but keeps the thread link", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
			{
				tu1: {
					content: `Auxiliary agent 'scout' completed with error: model timeout\n\nThread: ${THREAD}`,
				},
			},
		);
		expect(refs[0]?.status).toBe("failed");
		expect(refs[0]?.threadId).toBe(THREAD);
	});

	it("marks a background errand failure as failed", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
			{
				tu1: {
					content: `Auxiliary agent errand failed: loop threw\n\nThread: ${THREAD}`,
				},
			},
		);
		expect(refs[0]?.status).toBe("failed");
	});

	it("marks a non-zero exit result as failed", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
			{ tu1: { content: `boom\n\nThread: ${THREAD}`, exit_code: 1 } },
		);
		expect(refs[0]?.status).toBe("failed");
	});

	it("skips results that name no thread (validation errors)", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "ghost" } }],
			{ tu1: { content: "Error: no active auxiliary agent named 'ghost'.", exit_code: 0 } },
		);
		expect(refs).toEqual([]);
	});

	it("only links the end-of-content trailer, not a mid-text thread mention", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
			{
				tu1: {
					content: `Compared against Thread: ${THREAD2} in passing.\n\nThread: ${THREAD}`,
				},
			},
		);
		expect(refs[0]?.threadId).toBe(THREAD);
	});

	it("tolerates trailing whitespace after the trailer", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
			{ tu1: { content: `done\n\nThread: ${THREAD}\n` } },
		);
		expect(refs[0]?.threadId).toBe(THREAD);
	});

	it("skips non-invoke aux actions", () => {
		const refs = extractAuxInvokeRefs(
			[
				{ id: "tu1", name: "aux", input: { action: "define", name: "scout" } },
				{ id: "tu2", name: "aux", input: { action: "list" } },
			],
			{ tu1: { content: "defined" }, tu2: { content: "1 identity" } },
		);
		expect(refs).toEqual([]);
	});

	it("skips non-aux tools even when the result carries a trailer", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "task", input: { action: "invoke", name: "x" } }],
			{ tu1: { content: `ok\n\nThread: ${THREAD}` } },
		);
		expect(refs).toEqual([]);
	});

	it("skips invokes with a malformed input", () => {
		const refs = extractAuxInvokeRefs(
			[
				{ id: "tu1", name: "aux", input: null },
				{ id: "tu2", name: "aux", input: { action: "invoke" } },
			],
			{ tu1: { content: `x\n\nThread: ${THREAD}` }, tu2: { content: `x\n\nThread: ${THREAD}` } },
		);
		expect(refs).toEqual([]);
	});

	it("collects multiple invokes in order", () => {
		const refs = extractAuxInvokeRefs(
			[
				{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } },
				{ id: "tu2", name: "query", input: {} },
				{ id: "tu3", name: "aux", input: { action: "invoke", name: "auditor" } },
			],
			{
				tu1: { content: `a\n\nThread: ${THREAD}`, exit_code: 0 },
				tu2: { content: "rows" },
				tu3: { content: `b\n\nThread: ${THREAD2}` },
			},
		);
		expect(refs.map((r) => [r.agentName, r.threadId])).toEqual([
			["scout", THREAD],
			["auditor", THREAD2],
		]);
	});
});
