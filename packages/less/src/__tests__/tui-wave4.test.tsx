import { describe, expect, it } from "bun:test";
import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { SelectList } from "../tui/components/SelectList";
import { useMessages } from "../tui/hooks/useMessages";
import { type InFlightTool, dropAuxEntries } from "../tui/hooks/useToolCalls";
import { resolveModelName } from "../tui/util/resolve-model";
import {
	CHAT_HELP_COLUMN_WIDTH,
	CHAT_HELP_ROWS,
	CHAT_SLASH_COMPLETIONS,
	suggestSlashCommand,
} from "../tui/views/ChatView";

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
type Handler = (...args: unknown[]) => void;
function mockClient() {
	const listeners = new Map<string, Set<Handler>>();
	return {
		on: (e: string, h: Handler) => {
			if (!listeners.has(e)) listeners.set(e, new Set());
			listeners.get(e)?.add(h);
		},
		off: (e: string, h: Handler) => listeners.get(e)?.delete(h),
		emit: (e: string, d: unknown) => {
			for (const h of listeners.get(e) ?? []) h(d);
		},
	};
}
function msg(id: string, threadId: string): Message {
	return {
		id,
		thread_id: threadId,
		role: "assistant",
		content: id,
		model_id: null,
		tool_name: null,
		created_at: new Date().toISOString(),
		modified_at: null,
		host_origin: "h",
		deleted: 0,
		exit_code: null,
		metadata: null,
	};
}

describe("resolveModelName", () => {
	const candidates = [
		{ id: "claude-opus-5-5", aliases: ["copilot-claude-opus-5.5", "Claude Opus 5.5"] },
		{ id: "gpt-6-1-sol", aliases: ["GPT-6.1 Sol"] },
	];
	it("matches id, backend id, and display name case-insensitively", () => {
		expect(resolveModelName("CLAUDE-OPUS-5-5", candidates)).toBe("claude-opus-5-5");
		expect(resolveModelName("copilot-claude-opus-5.5", candidates)).toBe("claude-opus-5-5");
		expect(resolveModelName("gpt-6.1 sol", candidates)).toBe("gpt-6-1-sol");
	});
	it("returns null for typos and blanks", () => {
		expect(resolveModelName("opsu", candidates)).toBeNull();
		expect(resolveModelName("  ", candidates)).toBeNull();
	});
});

describe("slash command help and suggestions", () => {
	it("derives every /help row from CHAT_SLASH_COMPLETIONS", () => {
		expect(CHAT_HELP_ROWS.length).toBe(CHAT_SLASH_COMPLETIONS.length);
		expect(CHAT_HELP_ROWS.map(([c]) => c)).toContain("/sandbox [off|on|allow <path>]");
		for (const [cmd] of CHAT_HELP_ROWS) expect(cmd.length).toBeLessThan(CHAT_HELP_COLUMN_WIDTH);
	});
	it("suggests the closest command", () => {
		expect(suggestSlashCommand("modle")).toBe("/model");
		expect(suggestSlashCommand("att")).toBe("/attach");
		expect(suggestSlashCommand("zzzzzzzz")).toBeNull();
	});
});

describe("dropAuxEntries", () => {
	it("removes only aux cards", () => {
		const tool = { toolName: "x" } as unknown as InFlightTool;
		const prev = new Map([
			["aux:t1", tool],
			["call-1", tool],
		]);
		expect([...dropAuxEntries(prev).keys()]).toEqual(["call-1"]);
		const noAux = new Map([["call-1", tool]]);
		expect(dropAuxEntries(noAux)).toBe(noAux);
	});
});

describe("useMessages thread scoping", () => {
	it("drops message:created events for other threads", async () => {
		const client = mockClient();
		const ref = { current: "t-1" };
		let count = 0;
		function Harness() {
			count = useMessages(client as unknown as BoundClient, [], ref).messages.length;
			return React.createElement(Text, null, String(count));
		}
		const r = render(React.createElement(Harness));
		await tick();
		client.emit("message:created", msg("a", "aux-thread"));
		client.emit("message:created", msg("b", "t-1"));
		await tick();
		expect(count).toBe(1);
		r.unmount();
	});
});

describe("SelectList inside a modal", () => {
	it("does not handle Esc or Ctrl-C when handleCancelKeys is false", async () => {
		let cancels = 0;
		const r = render(
			React.createElement(SelectList<string>, {
				items: ["a"],
				onSelect: () => {},
				onCancel: () => cancels++,
				handleCancelKeys: false,
				renderItem: (i: string) => i,
			}),
		);
		await tick();
		r.stdin.write("\u001B");
		r.stdin.write("\u0003");
		await tick();
		expect(cancels).toBe(0);
		r.unmount();
	});
	it("still handles Esc standalone", async () => {
		let cancels = 0;
		const r = render(
			React.createElement(SelectList<string>, {
				items: ["a"],
				onSelect: () => {},
				onCancel: () => cancels++,
				renderItem: (i: string) => i,
			}),
		);
		await tick();
		r.stdin.write("\u001B");
		await tick();
		expect(cancels).toBe(1);
		r.unmount();
	});
});
