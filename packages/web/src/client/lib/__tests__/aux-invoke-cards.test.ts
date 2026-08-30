import { describe, expect, it } from "bun:test";
import { extractAuxInvokeRefs, reduceActiveAuxRuns } from "../aux-invoke-cards";

const THREAD = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const THREAD2 = "11111111-2222-3333-4444-555555555555";

describe("extractAuxInvokeRefs", () => {
	describe("metadata channel (primary)", () => {
		it("resolves a completed invoke from metadata.aux_thread", () => {
			const refs = extractAuxInvokeRefs(
				[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
				{
					tu1: {
						content: "Found 3 call sites, all guarded.",
						metadata: { aux_thread: THREAD },
					},
				},
			);
			expect(refs).toEqual([
				{ toolUseId: "tu1", agentName: "scout", threadId: THREAD, status: "completed" },
			]);
		});

		it("parses metadata delivered as a raw JSON string (API/WS shape)", () => {
			const refs = extractAuxInvokeRefs(
				[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
				{ tu1: { content: "done", metadata: JSON.stringify({ aux_thread: THREAD }) } },
			);
			expect(refs[0]?.threadId).toBe(THREAD);
		});

		it("reports running while metadata.background is set (unresolved placeholder)", () => {
			const refs = extractAuxInvokeRefs(
				[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
				{
					tu1: {
						content: "Auxiliary agent 'scout' queued — running in background.",
						metadata: { aux_thread: THREAD, background: true },
					},
				},
			);
			expect(refs).toEqual([
				{ toolUseId: "tu1", agentName: "scout", threadId: THREAD, status: "running" },
			]);
		});

		it("reports completed once the background marker is dropped on resolution", () => {
			// resolveDeferredToolResult drops `background` and preserves aux_thread.
			const refs = extractAuxInvokeRefs(
				[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
				{ tu1: { content: "errand summary", metadata: { aux_thread: THREAD } } },
			);
			expect(refs[0]?.status).toBe("completed");
		});

		it("marks an invoke error as failed but keeps the metadata thread link", () => {
			const refs = extractAuxInvokeRefs(
				[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
				{
					tu1: {
						content: "Auxiliary agent 'scout' completed with error: model timeout",
						metadata: { aux_thread: THREAD },
					},
				},
			);
			expect(refs[0]?.status).toBe("failed");
			expect(refs[0]?.threadId).toBe(THREAD);
		});

		it("marks a background errand failure (exit_code 1) as failed", () => {
			const refs = extractAuxInvokeRefs(
				[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
				{
					tu1: {
						content: "Auxiliary agent errand failed: loop threw",
						exit_code: 1,
						metadata: { aux_thread: THREAD },
					},
				},
			);
			expect(refs[0]?.status).toBe("failed");
		});

		it("metadata wins over a conflicting legacy content trailer", () => {
			const refs = extractAuxInvokeRefs(
				[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
				{
					tu1: {
						content: `summary\n\nThread: ${THREAD2}`,
						metadata: { aux_thread: THREAD },
					},
				},
			);
			expect(refs[0]?.threadId).toBe(THREAD);
		});

		it("tolerates malformed metadata JSON by falling back to content parsing", () => {
			const refs = extractAuxInvokeRefs(
				[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
				{ tu1: { content: `done\n\nThread: ${THREAD}`, metadata: "{ not json" } },
			);
			expect(refs[0]?.threadId).toBe(THREAD);
		});
	});

	describe("legacy content fallback (pre-metadata rows)", () => {
		it("resolves a completed invoke from the Thread trailer", () => {
			const refs = extractAuxInvokeRefs(
				[{ id: "tu1", name: "aux", input: { action: "invoke", name: "scout" } }],
				{ tu1: { content: `Found 3 call sites, all guarded.\n\nThread: ${THREAD}` } },
			);
			expect(refs).toEqual([
				{ toolUseId: "tu1", agentName: "scout", threadId: THREAD, status: "completed" },
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

	it("skips results that name no thread (validation errors)", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "aux", input: { action: "invoke", name: "ghost" } }],
			{ tu1: { content: "Error: no active auxiliary agent named 'ghost'.", exit_code: 0 } },
		);
		expect(refs).toEqual([]);
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

	it("skips non-aux tools even when the result carries a thread reference", () => {
		const refs = extractAuxInvokeRefs(
			[{ id: "tu1", name: "task", input: { action: "invoke", name: "x" } }],
			{ tu1: { content: "ok", metadata: { aux_thread: THREAD } } },
		);
		expect(refs).toEqual([]);
	});

	it("skips invokes with a malformed input", () => {
		const refs = extractAuxInvokeRefs(
			[
				{ id: "tu1", name: "aux", input: null },
				{ id: "tu2", name: "aux", input: { action: "invoke" } },
			],
			{
				tu1: { content: "x", metadata: { aux_thread: THREAD } },
				tu2: { content: "x", metadata: { aux_thread: THREAD } },
			},
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
				tu1: { content: "a", exit_code: 0, metadata: { aux_thread: THREAD } },
				tu2: { content: "rows" },
				tu3: { content: "b", metadata: { aux_thread: THREAD2 } },
			},
		);
		expect(refs.map((r) => [r.agentName, r.threadId])).toEqual([
			["scout", THREAD],
			["auditor", THREAD2],
		]);
	});
});

describe("reduceActiveAuxRuns", () => {
	it("ignores aux:completed when its transient start frame was missed", () => {
		expect(reduceActiveAuxRuns([], { type: "aux:completed", thread_id: THREAD })).toEqual([]);
	});
});
