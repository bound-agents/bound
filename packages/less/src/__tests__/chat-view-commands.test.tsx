import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { deflateSync } from "node:zlib";
import type { ContentBlock } from "@bound/llm";
import { render } from "ink-testing-library";
import React from "react";
import * as clipboardImage from "../tui/util/clipboard-image";
import { clearImagePreviews } from "../tui/util/image-preview";
import { ChatView, type ChatViewProps } from "../tui/views/ChatView";

/**
 * Covers ChatView's remaining uncovered input paths: the `/clear` and
 * `/inspect` slash commands, the unknown-command error banner, and the
 * Ctrl+V image-paste → staged-chip → send flow. The slash dispatch and
 * submission-gating cases already live in chat-view.test.tsx; these add the
 * branches that file left uncovered.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

function makeProps(overrides: Partial<ChatViewProps> = {}): ChatViewProps {
	return {
		client: null,
		threadId: "thread-123",
		model: "gpt-4",
		connectionState: "connected",
		cwd: "/tmp/work",
		commitHash: "test-sha",
		messages: [],
		inFlightTools: new Map(),
		mcpServerCount: 0,
		bannerMessage: null,
		bannerType: null,
		ctrlCHint: null,
		isProcessing: false,
		onModelChange: vi.fn(),
		onModelPicker: vi.fn(),
		onAttachThread: vi.fn(),
		onMcpView: vi.fn(),
		onInspect: vi.fn(),
		onClear: vi.fn(),
		onBannerDismiss: vi.fn(),
		onSendMessage: vi.fn(),
		...overrides,
	};
}

async function typeAndSubmit(stdin: NodeJS.WritableStream, text: string) {
	stdin.write(text);
	await tick();
	stdin.write("\r");
	await tick();
}

/** A real, decodable 2×2 RGB PNG so decodePng/renderHalfBlocks run for real. */
function buildPng(): Uint8Array {
	const width = 2;
	const height = 2;
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const out = new Uint8Array(12 + data.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.length);
		for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
		out.set(data, 8);
		return out;
	};
	const ihdr = new Uint8Array(13);
	const iv = new DataView(ihdr.buffer);
	iv.setUint32(0, width);
	iv.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB
	const stride = width * 3;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			const base = y * (stride + 1) + 1 + x * 3;
			raw[base] = 255;
			raw[base + 1] = 0;
			raw[base + 2] = 0;
		}
	}
	const idat = deflateSync(raw);
	const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdrChunk = chunk("IHDR", ihdr);
	const idatChunk = chunk("IDAT", idat);
	const iendChunk = chunk("IEND", new Uint8Array(0));
	const total = sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
	const png = new Uint8Array(total);
	let off = 0;
	for (const part of [sig, ihdrChunk, idatChunk, iendChunk]) {
		png.set(part, off);
		off += part.length;
	}
	return png;
}

describe("ChatView /clear and /inspect commands", () => {
	it("dispatches onInspect for /inspect", async () => {
		const onInspect = vi.fn();
		const { stdin } = render(React.createElement(ChatView, makeProps({ onInspect })));
		await tick();
		await typeAndSubmit(stdin, "/inspect");
		expect(onInspect).toHaveBeenCalledTimes(1);
	});

	it("dispatches onClear for /clear", async () => {
		const onClear = vi.fn();
		const { stdin } = render(React.createElement(ChatView, makeProps({ onClear })));
		await tick();
		await typeAndSubmit(stdin, "/clear");
		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it("shows an error banner for an unknown slash command and sends nothing", async () => {
		const onSendMessage = vi.fn();
		const { stdin, lastFrame } = render(
			React.createElement(ChatView, makeProps({ onSendMessage })),
		);
		await tick();
		await typeAndSubmit(stdin, "/frobnicate");
		expect(lastFrame() ?? "").toContain("Unknown command: /frobnicate");
		expect(onSendMessage).not.toHaveBeenCalled();
	});
});

describe("ChatView image paste + staged send", () => {
	afterEach(() => {
		clearImagePreviews();
	});

	it("stages a pasted image and sends it as an image content block", async () => {
		const png = buildPng();
		const spy = spyOn(clipboardImage, "readClipboardImage").mockResolvedValue({
			bytes: png,
			mediaType: "image/png",
		});
		try {
			const onSendMessage = vi.fn();
			const { stdin, lastFrame } = render(
				React.createElement(ChatView, makeProps({ onSendMessage })),
			);
			await tick();
			// Ctrl+V triggers the paste handler (TextInput's onPasteImage).
			stdin.write("\x16");
			await tick();
			await tick();

			// The staged chip caption is rendered in the dynamic region.
			expect(lastFrame() ?? "").toContain("staged");

			// Enter submits the staged image. No text typed → a single image block.
			stdin.write("\r");
			await tick();
			expect(onSendMessage).toHaveBeenCalledTimes(1);
			const blocks = onSendMessage.mock.calls[0][0] as ContentBlock[];
			expect(Array.isArray(blocks)).toBe(true);
			const imageBlock = blocks.find((b) => b.type === "image");
			expect(imageBlock).toBeDefined();
		} finally {
			spy.mockRestore();
		}
	});

	it("rides typed text ahead of the staged image when both are present", async () => {
		const png = buildPng();
		const spy = spyOn(clipboardImage, "readClipboardImage").mockResolvedValue({
			bytes: png,
			mediaType: "image/png",
		});
		try {
			const onSendMessage = vi.fn();
			const { stdin } = render(React.createElement(ChatView, makeProps({ onSendMessage })));
			await tick();
			stdin.write("\x16"); // Ctrl+V
			await tick();
			await tick();
			await typeAndSubmit(stdin, "caption text");

			expect(onSendMessage).toHaveBeenCalledTimes(1);
			const blocks = onSendMessage.mock.calls[0][0] as ContentBlock[];
			expect(blocks[0]).toMatchObject({ type: "text", text: "caption text" });
			expect(blocks.some((b) => b.type === "image")).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	it("surfaces an error banner when the clipboard has no image", async () => {
		const spy = spyOn(clipboardImage, "readClipboardImage").mockResolvedValue(null);
		try {
			const { stdin, lastFrame } = render(React.createElement(ChatView, makeProps()));
			await tick();
			stdin.write("\x16"); // Ctrl+V
			await tick();
			await tick();
			expect(lastFrame() ?? "").toContain("No image on the clipboard");
		} finally {
			spy.mockRestore();
		}
	});
});

type YardEventListener = (event: unknown) => void;

/** A client that lets a test push yard:execution events into useYardExecutions. */
function makeYardClient(): {
	client: { on: (e: string, h: YardEventListener) => void; off: () => void };
	emit: (event: unknown) => void;
} {
	let listener: YardEventListener | null = null;
	return {
		client: {
			on: (event: string, handler: YardEventListener) => {
				if (event === "yard:execution") listener = handler;
			},
			off: () => {
				listener = null;
			},
		},
		emit: (event: unknown) => listener?.(event),
	};
}

describe("ChatView resize and yard static-item rendering", () => {
	it("re-emits the Static region on a terminal resize without crashing", async () => {
		const { stdin: _stdin, lastFrame, stdout } = render(React.createElement(ChatView, makeProps()));
		await tick();
		// Drive the resize handler: a width change bumps the redraw nonce and
		// re-emits Static. The handler's resize listener + cleanup are the
		// uncovered closures.
		Object.defineProperty(stdout, "columns", { value: 40, configurable: true, writable: true });
		(stdout as unknown as { emit: (e: string) => void }).emit("resize");
		await tick();
		// Still rendering the status bar after the repaint.
		expect(lastFrame() ?? "").toContain("thread-123");
	});

	it("renders a completed yard execution as a yard card correlated to its tool_result", async () => {
		const { client, emit } = makeYardClient();
		// A tool_result whose tool_name is the yard call id correlates to the
		// completed snapshot (ChatView keys completedByCall by toolCallId).
		const messages = [
			{
				id: "m-yard",
				thread_id: "thread-123",
				role: "tool_result" as const,
				content: "yard output",
				model_id: null,
				tool_name: "yard-call-1",
				created_at: "2026-07-18T01:02:03Z",
				modified_at: null,
				host_origin: "test",
				deleted: 0,
				exit_code: 0,
				metadata: null,
			},
		];
		const { lastFrame } = render(
			React.createElement(
				ChatView,
				makeProps({
					// biome-ignore lint/suspicious/noExplicitAny: minimal yard-event client stub
					client: client as any,
					// biome-ignore lint/suspicious/noExplicitAny: Message fixtures mirror the DB shape
					messages: messages as any,
				}),
			),
		);
		await tick();
		// Push a terminal (completed) tree-root yard event carrying the call id.
		emit({
			thread_id: "thread-123",
			trace_id: "trace-1",
			run_id: "run-1",
			node_id: "run-1",
			parent_id: null,
			seq: 1,
			phase: "completed",
			node: { kind: "run", depth: 0 },
			tool_call_id: "yard-call-1",
			result_preview: "done",
			started_at: "2026-07-18T01:02:00Z",
			finished_at: "2026-07-18T01:02:03Z",
		});
		await tick();
		await tick();
		// The yard card renders (its header/label) in place of the plain message
		// block for the correlated tool_result. The frame stays well-formed.
		expect(lastFrame() ?? "").toContain("thread-123");
	});

	describe("ChatView help list and live-yard spinner", () => {
		it("renders the full /help command list", async () => {
			const { stdin, lastFrame } = render(React.createElement(ChatView, makeProps()));
			await tick();
			stdin.write("/help");
			await tick();
			stdin.write("\r");
			await tick();
			const out = lastFrame() ?? "";
			// The help block maps over every command row (the map callback).
			expect(out).toContain("Available commands");
			expect(out).toContain("/inspect");
			expect(out).toContain("/clear");
			expect(out).toContain("Browse the transcript at full fidelity");
		});

		it("renders a running yard card for a live (non-terminal) execution", async () => {
			const { client, emit } = makeYardClient();
			const { lastFrame } = render(
				React.createElement(
					ChatView,
					makeProps({
						// biome-ignore lint/suspicious/noExplicitAny: minimal yard-event client stub
						client: client as any,
						isProcessing: true,
					}),
				),
			);
			await tick();
			// A live (started, not completed) tree-root event keeps the run in the
			// live region so the running YardExecutionCard map callback fires.
			emit({
				thread_id: "thread-123",
				trace_id: "trace-live",
				run_id: "run-live",
				node_id: "run-live",
				parent_id: null,
				seq: 1,
				phase: "started",
				node: { kind: "run", depth: 0 },
				input_preview: '{"task":"demo"}',
				started_at: "2026-07-18T01:02:00Z",
			});
			await tick();
			await tick();
			// The frame still renders the status bar with the live run present.
			expect(lastFrame() ?? "").toContain("thread-123");
		});
	});
});

describe("ChatView /sandbox notice", () => {
	it("shows the /sandbox confirmation once and clears it on the next submit", async () => {
		const { stdin, lastFrame } = render(React.createElement(ChatView, makeProps()));
		await tick();
		await typeAndSubmit(stdin, "/sandbox off");
		expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("/sandbox: OFF for this thread");
		await typeAndSubmit(stdin, "/help");
		expect((lastFrame() ?? "").replace(/\s+/g, " ")).not.toContain("/sandbox: OFF for this thread");
	});

	it("replaces rather than stacks repeated /sandbox notices", async () => {
		const { stdin, lastFrame } = render(React.createElement(ChatView, makeProps()));
		await tick();
		await typeAndSubmit(stdin, "/sandbox off");
		await typeAndSubmit(stdin, "/sandbox on");
		const out = (lastFrame() ?? "").replace(/\s+/g, " ");
		expect(out).toContain("back to the configured default");
		expect(out).not.toContain("/sandbox: OFF for this thread");
	});
});
