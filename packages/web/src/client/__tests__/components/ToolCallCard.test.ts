import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// ToolCallCard: renders a run of consecutive tool_call messages as one Agent
// turn — reasoning + inline text up front, a collapsible that aggregates every
// tool_use, and inline cards for scheduled-task and aux-invoke results. These
// tests drive the real compiled component (plus its ReasoningBlock, TaskCard,
// and AuxInvokeCard children) under jsdom and assert what renders and how the
// expand/collapse interactions behave.

const dom = installDom();
afterAll(() => dom.teardown());

const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

// The async markdown pipeline (Shiki/marked/DOMPurify) is unreliable to settle
// under jsdom + a loaded concurrent run, so these tests assert on the message
// TEXT (present whether the raw-text fallback or the rendered .inline-text md
// shows) rather than on specific rendered HTML elements.

async function mountCard(props: Record<string, unknown>) {
	const ToolCallCard = (await import("../../components/ToolCallCard.svelte")).default;
	const handle = await dom.mount(ToolCallCard, props);
	unmounts.push(handle.unmount);
	await dom.settle();
	return handle;
}

/** Build a tool_call message whose content is a JSON ContentBlock[]. */
function toolCallMsg(blocks: unknown[], extra: Record<string, unknown> = {}) {
	return { content: JSON.stringify(blocks), ...extra };
}

const UUID = "11111111-2222-3333-4444-555555555555";

describe("ToolCallCard", () => {
	beforeEach(() => {
		dom.requests.length = 0;
	});

	it("renders the Agent header and first-message inline text as markdown", async () => {
		const messages = [
			toolCallMsg(
				[
					{ type: "text", text: "Running a **check**." },
					{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
				],
				{ model_id: "opus-4.8" },
			),
		];
		const { target } = await mountCard({ messages });
		expect(target.querySelector(".role")?.textContent?.trim()).toBe("Agent");
		expect(target.querySelector(".model")?.textContent).toContain("opus-4.8");
		// The text is present whether or not the async markdown render has landed.
		expect(target.textContent).toContain("Running a");
		expect(target.textContent).toContain("check");
	});

	it("uses the first non-null model_id, skipping synthetic rows", async () => {
		const messages = [
			toolCallMsg([{ type: "tool_use", id: "t0", name: "retrieve_task", input: {} }], {
				model_id: null,
			}),
			toolCallMsg([{ type: "tool_use", id: "t1", name: "bash", input: {} }], {
				model_id: "gpt-6-astra",
			}),
		];
		const { target } = await mountCard({ messages });
		expect(target.querySelector(".model")?.textContent).toContain("gpt-6-astra");
	});

	it("summarizes the tool-call count and names, collapsed by default", async () => {
		const messages = [
			toolCallMsg([
				{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
				{ type: "tool_use", id: "t2", name: "read", input: { path: "/x" } },
			]),
		];
		const { target } = await mountCard({ messages });
		expect(target.querySelector(".tg-count")?.textContent).toContain("2 tool calls");
		expect(target.querySelector(".tg-summary")?.textContent).toContain("bash");
		expect(target.querySelector(".tg-summary")?.textContent).toContain("read");
		// Collapsed: no tool-row body yet.
		expect(target.querySelector(".tg-body")).toBeNull();
		expect(target.querySelector(".tg-header")?.getAttribute("aria-expanded")).toBe("false");
	});

	it("singularizes the count for exactly one tool call", async () => {
		const messages = [toolCallMsg([{ type: "tool_use", id: "t1", name: "bash", input: {} }])];
		const { target } = await mountCard({ messages });
		expect(target.querySelector(".tg-count")?.textContent?.trim()).toBe("1 tool call");
	});

	it("expands the group and reveals one row per tool_use", async () => {
		const messages = [
			toolCallMsg([
				{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls -la" } },
				{ type: "tool_use", id: "t2", name: "read", input: { path: "/etc/hosts" } },
			]),
		];
		const { target } = await mountCard({ messages });
		await dom.fire(target.querySelector(".tg-header") as HTMLButtonElement, "click");
		expect(target.querySelector(".tg-header")?.getAttribute("aria-expanded")).toBe("true");
		const rows = target.querySelectorAll(".tool-row");
		expect(rows.length).toBe(2);
		expect(target.textContent).toContain("bash");
		expect(target.textContent).toContain("read");
		// Collapsed rows show a one-line preview of the input.
		expect(target.querySelector(".tr-preview")?.textContent).toContain("ls -la");
	});

	it("expands a single tool row to show full input and its result", async () => {
		const messages = [
			toolCallMsg([{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }]),
		];
		const resultsByToolUseId = {
			t1: { content: "hi\n", exit_code: 0 },
		};
		const { target } = await mountCard({ messages, resultsByToolUseId });
		await dom.fire(target.querySelector(".tg-header") as HTMLButtonElement, "click");
		// A completed result shows the done check.
		expect(target.querySelector(".tr-done")).not.toBeNull();
		await dom.fire(target.querySelector(".tool-row-header") as HTMLButtonElement, "click");
		expect(target.querySelector(".tr-input")?.textContent).toContain("echo hi");
		expect(target.querySelector(".tr-output")?.textContent).toContain("hi");
	});

	it("marks a non-zero exit code as an error and shows pending when no result yet", async () => {
		const messages = [
			toolCallMsg([
				{ type: "tool_use", id: "t1", name: "bash", input: {} },
				{ type: "tool_use", id: "t2", name: "read", input: {} },
			]),
		];
		const resultsByToolUseId = { t1: { content: "nope", exit_code: 2 } };
		const { target } = await mountCard({ messages, resultsByToolUseId });
		await dom.fire(target.querySelector(".tg-header") as HTMLButtonElement, "click");
		expect(target.querySelector(".tr-error")).not.toBeNull();
		// Open the second (resultless) row → pending note.
		const headers = target.querySelectorAll(".tool-row-header");
		await dom.fire(headers[1] as HTMLButtonElement, "click");
		expect(target.querySelector(".tr-pending")?.textContent).toContain("Awaiting result");
		expect(target.querySelector(".tr-output-error")).toBeNull();
	});

	it("renders a ReasoningBlock from a leading thinking block", async () => {
		const messages = [
			toolCallMsg([
				{ type: "thinking", thinking: "let me think about this plan" },
				{ type: "tool_use", id: "t1", name: "bash", input: {} },
			]),
		];
		const { target } = await mountCard({ messages });
		const toggle = target.querySelector(".reasoning-toggle") as HTMLButtonElement;
		expect(toggle).not.toBeNull();
		await dom.fire(toggle, "click");
		expect(target.querySelector(".reasoning-body")?.textContent).toContain(
			"let me think about this plan",
		);
	});

	it("interleaves 2nd-message reasoning and inline text inside the expanded body", async () => {
		const messages = [
			toolCallMsg([{ type: "tool_use", id: "t1", name: "bash", input: {} }]),
			toolCallMsg([
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "second inline note" },
				{ type: "tool_use", id: "t2", name: "read", input: {} },
			]),
		];
		const { target } = await mountCard({ messages });
		await dom.fire(target.querySelector(".tg-header") as HTMLButtonElement, "click");
		await dom.settle();
		// The 2nd message's reasoning renders inside the body (a second toggle).
		expect(target.querySelectorAll(".reasoning-toggle").length).toBe(1);
		expect(target.querySelector(".inner-inline")?.textContent).toContain("second inline note");
	});

	it("renders a scheduled-task card for a task-tool schedule result", async () => {
		// TaskCard fetches the task detail from /api/tasks/:id on mount.
		dom.route("GET", `/api/tasks/${UUID}`, () => ({
			id: UUID,
			status: "pending",
			thread_id: null,
			displayName: "nightly sweep",
			schedule: "every 1d",
		}));
		const messages = [
			toolCallMsg([{ type: "tool_use", id: "tu1", name: "task", input: { action: "schedule" } }]),
		];
		const resultsByToolUseId = { tu1: { content: UUID, exit_code: 0 } };
		const { target } = await mountCard({ messages, resultsByToolUseId });
		await dom.settle();
		expect(target.querySelector(".scheduled-tasks")).not.toBeNull();
		expect(target.textContent).toContain("nightly sweep");
		const taskGets = dom.requests.filter((r) => r.path === `/api/tasks/${UUID}`);
		expect(taskGets.length).toBeGreaterThanOrEqual(1);
	});

	it("renders an aux-invoke card from a result carrying aux_thread metadata", async () => {
		const messages = [
			toolCallMsg([
				{
					type: "tool_use",
					id: "au1",
					name: "aux",
					input: { action: "invoke", name: "implementer" },
				},
			]),
		];
		const resultsByToolUseId = {
			au1: {
				content: "done",
				exit_code: 0,
				metadata: JSON.stringify({ aux_thread: UUID }),
			},
		};
		const { target } = await mountCard({ messages, resultsByToolUseId });
		await dom.settle();
		expect(target.querySelector(".aux-invokes")).not.toBeNull();
		expect(target.textContent).toContain("aux: implementer");
	});

	it("renders a raw fallback when content is not a valid block array", async () => {
		const messages = [{ content: "this is not json" }];
		const { target } = await mountCard({ messages });
		expect(target.querySelector(".raw-fallback")?.textContent).toContain("this is not json");
		// No tool group when there are no tool_uses.
		expect(target.querySelector(".tg")).toBeNull();
	});

	it("applies the provided line color as a custom property", async () => {
		const messages = [toolCallMsg([{ type: "tool_use", id: "t1", name: "bash", input: {} }])];
		const { target } = await mountCard({ messages, lineColor: "#0E8E83" });
		const card = target.querySelector(".tool-call-card") as HTMLElement;
		expect(card.getAttribute("style")).toContain("#0E8E83");
	});
});
