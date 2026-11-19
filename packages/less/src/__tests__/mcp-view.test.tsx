import { describe, expect, it, vi } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { McpServerConfig } from "../config";
import type { McpServerManager } from "../mcp/manager";
import { McpView } from "../tui/views/McpView";

const tick = () => new Promise((resolve) => setTimeout(resolve, 100));

function makeManager(states: Map<string, { status: string; error?: string }>): McpServerManager {
	return {
		getServerStates: vi.fn().mockReturnValue(states),
	} as unknown as McpServerManager;
}

describe("McpView", () => {
	it("renders 'No servers configured' when the config list is empty", () => {
		const { lastFrame } = render(
			React.createElement(McpView, {
				mcpManager: makeManager(new Map()),
				mcpConfigs: [],
				onConfigChange: vi.fn(),
				onCancel: vi.fn(),
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("MCP Server Configuration");
		expect(out).toContain("No servers configured");
	});

	it("renders each configured server with its running/stopped badge, disabled marker, and error", () => {
		const configs: McpServerConfig[] = [
			{ name: "github", transport: "stdio", command: "x", args: [], enabled: true },
			{ name: "slack", transport: "stdio", command: "y", args: [], enabled: false },
		];
		const states = new Map([
			["github", { status: "running" }],
			["slack", { status: "stopped", error: "connection refused" }],
		]);
		const { lastFrame } = render(
			React.createElement(McpView, {
				mcpManager: makeManager(states),
				mcpConfigs: configs,
				onConfigChange: vi.fn(),
				onCancel: vi.fn(),
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("github");
		expect(out).toContain("slack");
		expect(out).toContain("(disabled)");
		expect(out).toContain("connection refused");
		// Action bar hints are rendered.
		expect(out).toContain("toggle");
		expect(out).toContain("back");
	});

	it("invokes onCancel when the SelectList is dismissed with Esc", async () => {
		const onCancel = vi.fn();
		const configs: McpServerConfig[] = [
			{ name: "github", transport: "stdio", command: "x", args: [], enabled: true },
		];
		const { stdin } = render(
			React.createElement(McpView, {
				mcpManager: makeManager(new Map([["github", { status: "running" }]])),
				mcpConfigs: configs,
				onConfigChange: vi.fn(),
				onCancel,
			}),
		);
		await tick();
		stdin.write("\x1b"); // Esc
		await tick();
		expect(onCancel).toHaveBeenCalled();
	});

	it("invokes onCancel from the empty-list overlay dismiss", async () => {
		const onCancel = vi.fn();
		const { stdin } = render(
			React.createElement(McpView, {
				mcpManager: makeManager(new Map()),
				mcpConfigs: [],
				onConfigChange: vi.fn(),
				onCancel,
			}),
		);
		await tick();
		stdin.write("\x1b"); // Esc dismisses the ModalOverlay
		await tick();
		expect(onCancel).toHaveBeenCalled();
	});

	it("runs the SelectList onSelect no-op without throwing when an item is chosen", async () => {
		const configs: McpServerConfig[] = [
			{ name: "github", transport: "stdio", command: "x", args: [], enabled: true },
		];
		const onConfigChange = vi.fn();
		const { stdin, lastFrame } = render(
			React.createElement(McpView, {
				mcpManager: makeManager(new Map([["github", { status: "running" }]])),
				mcpConfigs: configs,
				onConfigChange,
				onCancel: vi.fn(),
			}),
		);
		await tick();
		stdin.write("\r"); // Enter selects the highlighted row -> onSelect no-op
		await tick();
		// The view stays mounted (selection is a TODO no-op) and does not emit a
		// config change.
		expect(lastFrame() ?? "").toContain("MCP Server Configuration");
		expect(onConfigChange).not.toHaveBeenCalled();
	});
});
