import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { FakeResizeObserver, installDom } from "../harness/dom";

// MessageList is a props-driven transcript: it groups consecutive tool_call
// messages into cards, renders user/assistant/system/alert bubbles on a timed
// rail, shows a thinking/streaming row while the agent is active, dims rows
// outside a turn range, and re-pins the viewport via a ResizeObserver. It owns
// no API calls; every input arrives as a prop.

const dom = installDom({ url: "http://localhost/#/line/t1" });
afterAll(() => dom.teardown());

// MessageList always mounts McpChallengeCard, which fetches pending MCP OAuth
// challenges on mount. Route it so the child renders cleanly instead of
// injecting a "no fake route" error banner into the transcript's textContent.
beforeEach(() => {
	dom.route("GET", "/api/mcp-challenges", () => ({
		challenges: [],
		loopback: false,
		canResolve: false,
	}));
});

interface Message {
	role: string;
	content: string;
	tool_name?: string | null;
	model_id?: string | null;
	created_at?: string;
	id?: string;
	exit_code?: number | null;
	metadata?: string | Record<string, unknown> | null;
}

async function load() {
	return (await import("../../components/MessageList.svelte")).default;
}

function msg(over: Partial<Message>): Message {
	return {
		role: "user",
		content: "hello",
		created_at: "2026-01-01T09:30:00.000Z",
		id: "m1",
		...over,
	};
}

// A single tool_call message content is a JSON ContentBlock[] with a tool_use.
function toolCallContent(name: string, id: string, text?: string): string {
	const blocks: unknown[] = [];
	if (text) blocks.push({ type: "text", text });
	blocks.push({ type: "tool_use", id, name, input: {} });
	return JSON.stringify(blocks);
}

describe("MessageList", () => {
	it("renders the empty state when there are no messages and emptyText is set", async () => {
		// First mount in the file pays a one-time module-compilation cost through the
		// shared jsdom window (MessageList statically imports YardExecutionPanel →
		// SvelteFlow → Shiki); under a loaded concurrent run that cold compile can
		// cross the 5000ms default, so this test takes a wider budget.
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [],
			emptyText: "No messages yet",
		});
		await dom.settle();
		const empty = target.querySelector(".empty-state");
		expect(empty).not.toBeNull();
		expect(empty?.textContent).toContain("No messages yet");
	}, 15000);

	it("renders a user and an assistant message as rows with time gutters", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [
				msg({
					id: "u1",
					role: "user",
					content: "what is 2+2",
					created_at: "2026-01-01T09:30:00.000Z",
				}),
				msg({
					id: "a1",
					role: "assistant",
					content: "four",
					created_at: "2026-01-01T09:31:00.000Z",
				}),
			],
		});
		await dom.settle();
		const rows = target.querySelectorAll(".turn-row");
		expect(rows.length).toBe(2);
		expect(target.textContent).toContain("what is 2+2");
		expect(target.textContent).toContain("four");
		// User row carries the user rail dot; the first row gets a rail cap.
		expect(target.querySelector(".rail-dot-user")).not.toBeNull();
		expect(target.querySelector(".rail-cap")).not.toBeNull();
		// Time gutter shows HH:MM (local, 24h).
		const gutter = target.querySelector(".time-gutter");
		expect(gutter?.textContent).toMatch(/\d{2}:\d{2}/);
	});

	it("tags rail dots by role for user, assistant, alert and system", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [
				msg({ id: "u", role: "user", content: "hi" }),
				msg({ id: "a", role: "assistant", content: "yo" }),
				msg({ id: "al", role: "alert", content: "heads up" }),
				msg({ id: "s", role: "system", content: "sys note" }),
			],
		});
		await dom.settle();
		expect(target.querySelector(".rail-dot-user")).not.toBeNull();
		expect(target.querySelector(".rail-dot-alert")).not.toBeNull();
		expect(target.querySelector(".rail-dot-system")).not.toBeNull();
		// assistant dots exist too (one per assistant row).
		expect(target.querySelector(".rail-dot-assistant")).not.toBeNull();
	});

	it("groups consecutive tool_call messages into a single tool card", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [
				msg({ id: "u", role: "user", content: "run it" }),
				msg({
					id: "tc1",
					role: "tool_call",
					tool_name: "bash",
					content: toolCallContent("bash", "call-1"),
					created_at: "2026-01-01T09:30:10.000Z",
				}),
				msg({
					id: "tc2",
					role: "tool_call",
					tool_name: "read",
					content: toolCallContent("read", "call-2"),
					created_at: "2026-01-01T09:30:11.000Z",
				}),
			],
		});
		await dom.settle();
		// user row + ONE grouped tool row = 2 rows (the two tool_calls collapse).
		const rows = target.querySelectorAll(".turn-row");
		expect(rows.length).toBe(2);
	});

	it("surfaces a tool_result inline under its tool_call (results keyed by tool_use id)", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [
				msg({
					id: "tc1",
					role: "tool_call",
					tool_name: "bash",
					content: toolCallContent("bash", "call-1"),
				}),
				msg({
					id: "tr1",
					role: "tool_result",
					// Production persists a tool_result's `tool_name` as the tool_use id
					// (bound-agent-loop sets toolName: toolCall.id), which is how
					// MessageList keys resultsByToolUseId and ToolCallCard looks it up.
					tool_name: "call-1",
					content: "command output here",
					exit_code: 0,
				}),
			],
		});
		await dom.settle();
		// tool_result rows do not produce their own turn-row; they fold into the card.
		const rows = target.querySelectorAll(".turn-row");
		expect(rows.length).toBe(1);
		// ToolCallCard shows result content only when the group AND the tool row are
		// expanded: open the group header, then the per-tool row.
		const groupHeader = target.querySelector(".tg-header") as HTMLButtonElement;
		expect(groupHeader).not.toBeNull();
		await dom.fire(groupHeader, "click");
		await dom.settle();
		const toolHeader = target.querySelector(".tool-row-header") as HTMLButtonElement;
		expect(toolHeader).not.toBeNull();
		await dom.fire(toolHeader, "click");
		await dom.settle();
		const output = target.querySelector(".tr-output");
		expect(output?.textContent).toContain("command output here");
	});

	it("shows a thinking row with animated dots while waiting with no streaming text", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [msg({ id: "u", role: "user", content: "ping" })],
			waiting: true,
		});
		await dom.settle();
		const thinking = target.querySelector(".thinking-row");
		expect(thinking).not.toBeNull();
		expect(thinking?.textContent).toContain("Thinking");
		expect(target.querySelector(".rail-dot-pulsing")).not.toBeNull();
		expect(target.querySelectorAll(".dots .dot").length).toBe(3);
	});

	it("renders streaming assistant text in the thinking row when streaming", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [msg({ id: "u", role: "user", content: "ping" })],
			isAgentActive: true,
			streamingText: "partial answer so far",
		});
		await dom.settle();
		expect(target.querySelector(".thinking-row")).not.toBeNull();
		expect(target.textContent).toContain("partial answer so far");
		// With streaming text present, the "Thinking" caption is replaced.
		expect(target.querySelector(".thinking-caption")).toBeNull();
	});

	it("renders a streaming reasoning block before the assistant text", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [msg({ id: "u", role: "user", content: "ping" })],
			isAgentActive: true,
			streamingReasoning: "let me think step by step",
		});
		await dom.settle();
		expect(target.querySelector(".thinking-row")).not.toBeNull();
		// ReasoningBlock renders its text in a collapsed disclosure by default; the
		// summary shows a word count, the prose appears only when toggled open.
		const reasoningToggle = target.querySelector(".reasoning-toggle") as HTMLButtonElement;
		expect(reasoningToggle).not.toBeNull();
		await dom.fire(reasoningToggle, "click");
		await dom.settle();
		expect(target.querySelector(".reasoning-prose")?.textContent).toContain(
			"let me think step by step",
		);
	});

	it("dims rows outside the active turn range and marks the active row", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [
				msg({
					id: "old",
					role: "user",
					content: "old turn",
					created_at: "2026-01-01T09:00:00.000Z",
				}),
				msg({
					id: "cur",
					role: "assistant",
					content: "current turn",
					created_at: "2026-01-01T10:00:00.000Z",
				}),
			],
			turnRange: { from: "2026-01-01T09:59:00.000Z", to: null },
		});
		await dom.settle();
		const dimmed = target.querySelectorAll(".turn-row.dimmed");
		// The older row (before the range) is dimmed; the current one is not.
		expect(dimmed.length).toBe(1);
		const active = target.querySelector("[data-turn-active]");
		expect(active).not.toBeNull();
	});

	it("tags message rows with data-message-id and data-message-role", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [msg({ id: "msg-xyz", role: "assistant", content: "tagged" })],
		});
		await dom.settle();
		const row = target.querySelector('[data-message-id="msg-xyz"]');
		expect(row).not.toBeNull();
		expect(row?.getAttribute("data-message-role")).toBe("assistant");
	});

	it("re-pins the viewport to the bottom on ResizeObserver growth when at bottom", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [msg({ id: "u", role: "user", content: "hi" })],
		});
		await dom.settle();
		const scroller = target.querySelector(".messages") as HTMLElement;
		// Simulate content taller than the viewport, scrolled to the bottom.
		Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
		Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
		scroller.scrollTop = 1000;
		// Fire the onscroll handler so isAtBottom latches true.
		scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
		await dom.settle();
		// The component created a ResizeObserver on the scroll container.
		const ro = FakeResizeObserver.instances.at(-1);
		expect(ro).toBeDefined();
		scroller.scrollTop = 0; // content grew, viewport drifted up
		ro?.callback([], ro);
		// Re-pin sets scrollTop back to scrollHeight.
		expect(scroller.scrollTop).toBe(1000);
	});

	it("reacts to a scroll request by targeting the requested message id", async () => {
		const Comp = await load();
		const { target, component } = await dom.mount(Comp, {
			messages: [
				msg({ id: "a", role: "user", content: "a" }),
				msg({ id: "b", role: "assistant", content: "b" }),
			],
			scrollRequest: { messageId: "b", nonce: 1 },
		});
		await dom.settle();
		// The targeted row exists and is addressable by the selector the effect uses.
		const targetRow = target.querySelector('[data-message-id="b"]');
		expect(targetRow).not.toBeNull();
		// Bumping the nonce re-fires the scroll effect without throwing.
		expect(() => {
			(component as { $set?: (p: Record<string, unknown>) => void }).$set?.({
				scrollRequest: { messageId: "b", nonce: 2 },
			});
		}).not.toThrow();
	});

	it("keeps a tool group active in a turn range when any of its timestamps falls inside", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [
				msg({
					id: "u-old",
					role: "user",
					content: "old",
					created_at: "2026-01-01T08:00:00.000Z",
				}),
				msg({
					id: "tc-in",
					role: "tool_call",
					tool_name: "bash",
					content: toolCallContent("bash", "call-in"),
					created_at: "2026-01-01T10:00:05.000Z",
				}),
			],
			// Range covers the tool group's timestamp but not the old user row.
			turnRange: { from: "2026-01-01T10:00:00.000Z", to: null },
		});
		await dom.settle();
		// The old user row is dimmed; the tool group row (timestamp in range) is not.
		const dimmed = target.querySelectorAll(".turn-row.dimmed");
		expect(dimmed.length).toBe(1);
		// The non-dimmed, in-range row is the tool group card.
		const active = target.querySelector(".turn-row:not(.dimmed) .tg-header");
		expect(active).not.toBeNull();
	});

	// --- Yard execution + MCP app panel rows ---
	// Round 1 claimed these could not mount under jsdom (@xyflow/svelte
	// rune_outside_svelte). Round 2 proved that false: the svelte-test-plugin now
	// compiles .svelte.js/.svelte.ts runes modules, so SvelteFlow mounts and
	// renders YardExecutionPanel's graph. SvelteFlow keeps scheduling rAFs under
	// jsdom so settle() never fully quiesces — give these rows explicit long
	// timeouts and read the DOM once it has rendered.
	const PANEL_TIMEOUT = 30000;

	function yardTree(over: Record<string, unknown> = {}) {
		return {
			traceId: "yardtrace0001",
			runId: "run0",
			phase: "completed",
			nodes: [
				{
					id: "run0",
					parentId: null,
					node: { kind: "run", depth: 0 },
					phase: "completed",
					seq: 0,
					startSeq: 0,
				},
			],
			...over,
		};
	}

	it(
		"anchors a yard panel beneath the tool_call row carrying its tool_use id",
		async () => {
			const Comp = await load();
			const { target } = await dom.mount(Comp, {
				messages: [
					msg({
						id: "tc",
						role: "tool_call",
						tool_name: "yard",
						content: toolCallContent("yard", "call-yard"),
						created_at: "2026-01-01T10:00:00.000Z",
					}),
				],
				yardTrees: [yardTree({ toolCallId: "call-yard" })],
			});
			// SvelteFlow never idles; poll the DOM after it has had time to render.
			await new Promise((resolve) => setTimeout(resolve, 1500));
			await dom.settle(4);
			// The yard panel renders inside a tool_call turn row, driven by the
			// yardPanelRow snippet, with the shared assistant rail dot.
			const panel = target.querySelector(".yard-execution-panel");
			expect(panel).not.toBeNull();
			expect(target.querySelector(".svelte-flow")).not.toBeNull();
			// It sits in a row that also holds the tool card for the same call.
			const panelRow = panel?.closest(".turn-row");
			expect(panelRow?.querySelector(".rail-dot-assistant")).not.toBeNull();
		},
		PANEL_TIMEOUT,
	);

	it(
		"renders an unanchored yard tree as a trailing panel row",
		async () => {
			const Comp = await load();
			const { target } = await dom.mount(Comp, {
				messages: [msg({ id: "u", role: "user", content: "hi" })],
				// No message carries this call id, so the tree falls to the trailing slot.
				yardTrees: [yardTree({ traceId: "orphan01", phase: "started", toolCallId: "absent" })],
			});
			await new Promise((resolve) => setTimeout(resolve, 1500));
			await dom.settle(4);
			const panel = target.querySelector(".yard-execution-panel");
			expect(panel).not.toBeNull();
			// The trailing panel is the last turn row in the stream, after the user row.
			const rows = [...target.querySelectorAll(".turn-row")];
			const last = rows.at(-1);
			expect(last?.querySelector(".yard-execution-panel")).not.toBeNull();
		},
		PANEL_TIMEOUT,
	);

	it(
		"anchors an MCP app panel beneath the tool_call row carrying its callId",
		async () => {
			const Comp = await load();
			// A minimal McpAppInstance. McpAppPanel.onMount reads the ui:// resource via
			// instance.client; a stub whose readResource rejects lands the panel in its
			// error state (it does not throw), which is all this test needs — the point
			// is that MessageList's anchoredInstances/panelRow placed the panel at all.
			const instance = {
				callId: "call-mcp",
				threadId: "t1",
				boundName: "srv__render",
				serverName: "srv",
				uiResourceUri: "ui://srv/app",
				input: {},
				client: { readResource: async () => Promise.reject(new Error("stub")) },
				resultPromise: Promise.resolve({ content: [] }),
				createdAt: Date.now(),
			};
			const { target } = await dom.mount(Comp, {
				messages: [
					msg({
						id: "tc",
						role: "tool_call",
						tool_name: "srv__render",
						content: toolCallContent("srv__render", "call-mcp"),
						created_at: "2026-01-01T10:00:00.000Z",
					}),
				],
				appInstances: [instance],
			});
			await dom.settle(6);
			// The panelRow snippet placed an McpAppPanel into a tool_call turn row.
			const mcpPanel = target.querySelector(".mcp-app");
			expect(mcpPanel).not.toBeNull();
			expect(mcpPanel?.closest(".turn-row")?.querySelector(".rail-dot-assistant")).not.toBeNull();
		},
		PANEL_TIMEOUT,
	);

	// --- Per-turn provenance footer + thread-level notices (§9.1, §9.2) ---
	// These wire the built-but-previously-unmounted components into the live
	// transcript: MessageProvenanceFooter under each assistant message (matched to
	// its turn), and RouteFailoverNotice / ModelSubstitutionNotice as thread-level
	// rows in the timeline.

	function turn(over: Record<string, unknown> = {}) {
		return {
			id: "turn-1",
			created_at: "2026-01-01T09:31:00.000Z",
			model_id: "gpt-5.6-sol",
			route_id: "site-hub:codex:sol",
			substituted_from: null,
			status: "ok",
			cost_usd: 0.5,
			attempts: null,
			...over,
		};
	}

	const assistantAt = (created_at: string) =>
		msg({ id: "a1", role: "assistant", content: "answer", model_id: "gpt-5.6-sol", created_at });
	const describeRoute = (routeId: string | null) => ({
		label: routeId === "site-hub:codex:sol" ? "codex:sol" : (routeId ?? ""),
		host: routeId?.startsWith("site-hub") ? "hub" : null,
	});

	it("renders no per-message provenance footer", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [assistantAt("2026-01-01T09:31:05.000Z")],
			turnProvenance: [turn()],
			describeRoute,
		});
		await dom.settle();
		expect(target.querySelector(".provenance")).toBeNull();
		// A plain served-on-first-route turn adds no annotation.
		expect(target.querySelector(".model-note")).toBeNull();
	});

	it("annotates a substitution fallback beside the model name", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [assistantAt("2026-01-01T09:31:05.000Z")],
			turnProvenance: [turn({ substituted_from: "opus-4.8" })],
			describeRoute,
			modelDisplay: (id: string | null) => (id === "opus-4.8" ? "Claude Opus 4.8" : (id ?? "")),
		});
		await dom.settle();
		const note = target.querySelector('[data-message-id="a1"] .model-note');
		expect(note?.textContent).toBe("· fallback from Claude Opus 4.8");
		expect(note?.getAttribute("title")).toContain("codex:sol on hub");
	});

	it("annotates a failover with the serving host and lists attempts in the tooltip", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [assistantAt("2026-01-01T09:31:05.000Z")],
			turnProvenance: [
				turn({
					attempts: [
						{
							model_id: "gpt-5.6-sol",
							route_id: "site-msi:codex:sol",
							outcome: "route-error",
							refusal_category: null,
							credit_redeemed: false,
							cost_usd: 0,
						},
						{
							model_id: "gpt-5.6-sol",
							route_id: "site-hub:codex:sol",
							outcome: "ok",
							refusal_category: null,
							credit_redeemed: false,
							cost_usd: 0.5,
						},
					],
				}),
			],
			describeRoute,
		});
		await dom.settle();
		const note = target.querySelector('[data-message-id="a1"] .model-note');
		expect(note?.textContent).toBe("· via hub");
		expect(note?.getAttribute("title")).toContain("route error");
	});

	it("mounts the route-failover notice at the thread level when provided", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [msg({ id: "a1", role: "assistant", content: "answer" })],
			routeFailover: {
				failedRoute: "MSI / Codex",
				failedCount: 4,
				windowSize: 5,
				servingRoute: "hub / Bedrock",
			},
		});
		await dom.settle();
		const notice = target.querySelector(".failover-notice");
		expect(notice).not.toBeNull();
		expect(notice?.textContent).toContain("MSI / Codex failed 4 of the last 5 turns");
		expect(notice?.textContent).toContain("hub / Bedrock");
	});

	it("mounts the model-substitution notice at the thread level when provided", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [msg({ id: "a1", role: "assistant", content: "answer" })],
			modelSubstitution: {
				original: "opus-4.8",
				substitute: "gpt-5.6-sol",
				category: "content_filter",
				explanation: null,
			},
		});
		await dom.settle();
		const notice = target.querySelector(".subst-notice");
		expect(notice).not.toBeNull();
		expect(notice?.textContent).toContain("opus-4.8");
		expect(notice?.textContent).toContain("gpt-5.6-sol");
	});

	it("renders neither notice when neither prop is supplied", async () => {
		const Comp = await load();
		const { target } = await dom.mount(Comp, {
			messages: [msg({ id: "a1", role: "assistant", content: "answer" })],
		});
		await dom.settle();
		expect(target.querySelector(".failover-notice")).toBeNull();
		expect(target.querySelector(".subst-notice")).toBeNull();
	});

	it(
		"renders an unanchored MCP app instance as a trailing panel row",
		async () => {
			const Comp = await load();
			const instance = {
				callId: "no-match",
				threadId: "t1",
				boundName: "srv__render",
				serverName: "srv",
				uiResourceUri: "ui://srv/app",
				input: {},
				client: { readResource: async () => Promise.reject(new Error("stub")) },
				resultPromise: Promise.resolve({ content: [] }),
				createdAt: Date.now(),
			};
			const { target } = await dom.mount(Comp, {
				messages: [msg({ id: "u", role: "user", content: "hi" })],
				appInstances: [instance],
			});
			await dom.settle(6);
			const panel = target.querySelector(".mcp-app");
			expect(panel).not.toBeNull();
			const rows = [...target.querySelectorAll(".turn-row")];
			expect(rows.at(-1)?.querySelector(".mcp-app")).not.toBeNull();
		},
		PANEL_TIMEOUT,
	);
});
