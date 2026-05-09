import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AC8.2, AC8.3, AC8.4: Legacy platform connector removal verification
 *
 * These tests verify that old platform connector code (PlatformConnector interface,
 * delivery patterns, webhook routes) has been completely removed from the codebase.
 */

function runGrep(pattern: string): string {
	try {
		const result = execSync(
			`grep -r "${pattern}" packages/ --include="*.ts" --exclude-dir=node_modules --exclude-dir=__tests__ --exclude-dir=dist 2>/dev/null || true`,
			{
				encoding: "utf-8",
				cwd: resolve(__dirname, "../../../.."),
			},
		);
		return result.trim();
	} catch {
		return "";
	}
}

describe("AC8.2: Legacy PlatformConnector interface removal", () => {
	it("no PlatformConnector interface references in non-test source", () => {
		const result = runGrep("PlatformConnector\\b");
		// Should have no matches (excluding PlatformConnectorConfig which is valid)
		const lines = result
			.split("\n")
			.filter((line) => line && !line.includes("PlatformConnectorConfig"))
			.filter((line) => line && !line.includes("PlatformConnectorHandle"))
			.filter((line) => line && !line.includes("PlatformConnectorLifecycle"));

		if (lines.length > 0) {
			console.error("Found PlatformConnector references:", lines);
		}
		expect(lines.length).toBe(0);
	});

	it("no PlatformConnectorRegistry references in non-test source", () => {
		const result = runGrep("PlatformConnectorRegistry");
		expect(result).toBe("");
	});

	it("no DiscordConnector references in non-test source", () => {
		const result = runGrep("DiscordConnector");
		expect(result).toBe("");
	});

	it("no DiscordInteractionConnector references in non-test source", () => {
		const result = runGrep("DiscordInteractionConnector");
		expect(result).toBe("");
	});

	it("no DiscordClientManager references in non-test source", () => {
		const result = runGrep("DiscordClientManager");
		expect(result).toBe("");
	});

	it("no deliverPlatformPayload references in non-test source", () => {
		const result = runGrep("deliverPlatformPayload");
		expect(result).toBe("");
	});

	it("no verifyDelivery references in relay/platform context", () => {
		const result = runGrep("verifyDelivery");
		expect(result).toBe("");
	});

	it("no runPostLoopDeliveryCheck references in non-test source", () => {
		const result = runGrep("runPostLoopDeliveryCheck");
		expect(result).toBe("");
	});
});

describe("AC8.3: Legacy event types removed", () => {
	it("events.ts does not contain platform:deliver", () => {
		const eventsPath = resolve(__dirname, "../../../shared/src/events.ts");
		const content = readFileSync(eventsPath, "utf-8");
		expect(content).not.toContain("platform:deliver");
	});

	it("events.ts does not contain platform:webhook", () => {
		const eventsPath = resolve(__dirname, "../../../shared/src/events.ts");
		const content = readFileSync(eventsPath, "utf-8");
		expect(content).not.toContain("platform:webhook");
	});

	it("no platform:deliver references in non-test source", () => {
		const result = runGrep('"platform:deliver"');
		expect(result).toBe("");
	});

	it("no platform:webhook references in non-test source", () => {
		const result = runGrep('"platform:webhook"');
		expect(result).toBe("");
	});

	it("no platform:deliver (single quote) references in non-test source", () => {
		const result = runGrep("'platform:deliver'");
		expect(result).toBe("");
	});

	it("no platform:webhook (single quote) references in non-test source", () => {
		const result = runGrep("'platform:webhook'");
		expect(result).toBe("");
	});
});

describe("AC8.4: Webhook route removed", () => {
	it("webhooks.ts route file does not exist", () => {
		const webhooksPath = resolve(__dirname, "../../../web/src/server/routes/webhooks.ts");
		expect(existsSync(webhooksPath)).toBe(false);
	});

	it("no hooks/:platform route references in web source", () => {
		const result = runGrep("hooks/:platform");
		expect(result).toBe("");
	});

	it('no "/hooks/" route references in web source', () => {
		const result = runGrep('"/hooks/"');
		expect(result).toBe("");
	});

	it("no :platform webhook handling in web routes", () => {
		const result = runGrep("webhook.*:platform");
		expect(result).toBe("");
	});
});

describe("Comprehensive legacy removal checks", () => {
	it("no legacy delivery-check references", () => {
		const result = runGrep("deliveryCheck");
		expect(result).toBe("");
	});

	it("no PlatformEvent type references", () => {
		const result = runGrep("PlatformEvent\\b");
		expect(result).toBe("");
	});

	it("no platformConnectors registry in start.ts", () => {
		const startPath = resolve(__dirname, "../../../cli/src/commands/start/server.ts");
		if (existsSync(startPath)) {
			const content = readFileSync(startPath, "utf-8");
			expect(content).not.toContain("platformConnectors");
		}
	});

	it("no old delivery pattern in agent-loop.ts", () => {
		const agentLoopPath = resolve(__dirname, "../../../agent/src/agent-loop.ts");
		if (existsSync(agentLoopPath)) {
			const content = readFileSync(agentLoopPath, "utf-8");
			expect(content).not.toContain("runPostLoopDeliveryCheck");
		}
	});

	it("no WebhookRegistration type references", () => {
		const result = runGrep("WebhookRegistration");
		expect(result).toBe("");
	});

	it("no old DiscordWebhookQueue references", () => {
		const result = runGrep("DiscordWebhookQueue");
		expect(result).toBe("");
	});
});
