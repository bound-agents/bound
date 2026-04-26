import { describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import { render } from "ink-testing-library";
import React from "react";
import { PickerView } from "../tui/views/PickerView";
import { formatThreadPickerLabel } from "../tui/views/picker-label";

describe("formatThreadPickerLabel", () => {
	it("collapses newlines in titles so each label is a single line", () => {
		const label = formatThreadPickerLabel("line one\nline two\nline three", "abc-123", 200);
		expect(label).not.toContain("\n");
		expect(label).toContain("line one");
		expect(label).toContain("abc-123");
	});

	it("collapses carriage returns and tabs to single spaces", () => {
		const label = formatThreadPickerLabel("foo\r\n\tbar\n\n\nbaz", "id-1", 200);
		expect(label).not.toMatch(/[\r\n\t]/);
		// No runs of whitespace within the title portion; the fixed
		// "  (" separator before the id is fine.
		const [titlePart] = label.split("  (");
		expect(titlePart).not.toMatch(/ {2,}/);
		expect(titlePart).toBe("foo bar baz");
	});

	it("trims leading and trailing whitespace from titles", () => {
		const label = formatThreadPickerLabel("   spaced out   ", "id-1", 200);
		expect(label.startsWith(" ")).toBe(false);
		expect(label).toContain("spaced out  (id-1)");
	});

	it("shows the full id and title when there is room", () => {
		const label = formatThreadPickerLabel("Short title", "abc-123", 80);
		expect(label).toBe("Short title  (abc-123)");
	});

	it("returns the id only when the title is empty or whitespace", () => {
		expect(formatThreadPickerLabel("", "abc-123", 80)).toBe("abc-123");
		expect(formatThreadPickerLabel("   ", "abc-123", 80)).toBe("abc-123");
		expect(formatThreadPickerLabel(null, "abc-123", 80)).toBe("abc-123");
		expect(formatThreadPickerLabel(undefined, "abc-123", 80)).toBe("abc-123");
	});

	it("truncates titles that would overflow the column budget, preserving the id", () => {
		const longTitle = "a very long thread title ".repeat(20);
		const id = "thread-abcd-1234";
		const label = formatThreadPickerLabel(longTitle, id, 60);
		// The final label must fit within the column budget …
		expect(label.length).toBeLessThanOrEqual(60);
		// … must still expose the full id (so users can copy it) …
		expect(label).toContain(id);
		// … and must visibly indicate truncation so the UX is honest.
		expect(label).toMatch(/…/);
	});

	it("falls back to the id alone when the column budget is too tight for a title", () => {
		const id = "thread-abcd-1234";
		// Budget barely fits the id; no room for any title chars.
		const label = formatThreadPickerLabel("some title", id, id.length + 2);
		expect(label).toContain(id);
		expect(label.length).toBeLessThanOrEqual(id.length + 2);
	});
});

describe("PickerView Esc handling", () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
	const ESC = "";

	it("calls onCancel when Esc is pressed in /attach (thread) mode", async () => {
		const mockClient = {
			listThreads: vi.fn().mockResolvedValue([{ id: "thread-1", title: "Hello" }]),
			listModels: vi.fn(),
		} as unknown as BoundClient;

		const onCancel = vi.fn();
		const { stdin } = render(
			React.createElement(PickerView, {
				mode: "thread",
				client: mockClient,
				onSelect: vi.fn(),
				onCancel,
			}),
		);

		await tick();
		stdin.write(ESC);
		await tick();

		expect(onCancel).toHaveBeenCalled();
	});

	it("calls onCancel when Esc is pressed in /model mode", async () => {
		const mockClient = {
			listThreads: vi.fn(),
			listModels: vi.fn().mockResolvedValue({ models: [{ id: "claude-opus" }] }),
		} as unknown as BoundClient;

		const onCancel = vi.fn();
		const { stdin } = render(
			React.createElement(PickerView, {
				mode: "model",
				client: mockClient,
				onSelect: vi.fn(),
				onCancel,
			}),
		);

		await tick();
		stdin.write(ESC);
		await tick();

		expect(onCancel).toHaveBeenCalled();
	});

	it("calls onCancel when Esc is pressed in /model mode while loading (before items arrive)", async () => {
		let resolveModels: ((v: { models: { id: string }[] }) => void) | null = null;
		const mockClient = {
			listThreads: vi.fn(),
			listModels: vi.fn(
				() =>
					new Promise<{ models: { id: string }[] }>((resolve) => {
						resolveModels = resolve;
					}),
			),
		} as unknown as BoundClient;

		const onCancel = vi.fn();
		const { stdin } = render(
			React.createElement(PickerView, {
				mode: "model",
				client: mockClient,
				onSelect: vi.fn(),
				onCancel,
			}),
		);

		// Wait for initial render so useInput is bound, then Esc while the
		// loader is still spinning — the modal should still dismiss.
		await tick();
		stdin.write(ESC);
		await tick();

		expect(onCancel).toHaveBeenCalled();

		// Let the pending promise settle to avoid unhandled-rejection noise.
		resolveModels?.({ models: [] });
	});
});

describe("PickerView thread labels", () => {
	it("does not render newlines from thread titles in the visible label", async () => {
		const mockClient = {
			listThreads: vi.fn().mockResolvedValue([
				{ id: "thread-1", title: "multi\nline\ntitle" },
				{ id: "thread-2", title: "single line" },
			]),
			listModels: vi.fn(),
		} as unknown as BoundClient;

		const { lastFrame } = render(
			React.createElement(PickerView, {
				mode: "thread",
				client: mockClient,
				onSelect: vi.fn(),
				onCancel: vi.fn(),
			}),
		);

		// Wait for async load
		await new Promise((resolve) => setTimeout(resolve, 150));

		const output = lastFrame() ?? "";
		// The raw multi-line title must not appear — the collapsed single-line form should.
		expect(output).toContain("multi line title");
		// And critically, the sequence "multi\nline" must not survive into the frame
		// as three physical lines of the same label. We check by counting how many
		// output lines contain any fragment of the title — it should be exactly 1.
		const titleLineCount = output.split("\n").filter((line) => line.includes("multi")).length;
		expect(titleLineCount).toBe(1);
	});
});
