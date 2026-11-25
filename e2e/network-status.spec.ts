import { type Page, expect, test } from "@playwright/test";
import { json, mockAmbient } from "./helpers/mocks";

const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function network(syncErrors: number) {
	return {
		hosts: [
			{
				site_id: "node-001-hub-site",
				host_name: "hub-node",
				version: "0.1.0",
				sync_url: "http://localhost:3000/sync",
				online_at: ago(2 * 60_000),
				models: '["claude-3-sonnet"]',
				mcp_tools: '["github"]',
				modified_at: now(),
			},
			{
				site_id: "node-002-spoke",
				host_name: "spoke-a",
				version: "0.2.0",
				sync_url: "http://localhost:3001/sync",
				online_at: ago(60_000),
				models: '["gpt-4"]',
				mcp_tools: '["slack"]',
				modified_at: now(),
			},
		],
		hub: { siteId: "node-001-hub-site", hostName: "hub-node" },
		syncState: [
			{
				peer_site_id: "node-002-spoke",
				last_received: "2026-04-13T10:00:00.000Z_0001_node-002",
				last_sent: "2026-04-13T10:00:00.000Z_0001_node-001",
				last_sync_at: ago(30_000),
				sync_errors: syncErrors,
			},
		],
	};
}

async function open(page: Page, syncErrors = 0): Promise<void> {
	await mockAmbient(page);
	await page.route("**/api/status/network", (r) => json(r, network(syncErrors)));
	await page.goto("/#/network");
	await expect(page.locator(".host-card")).toHaveCount(2);
}

test.describe("Network status view", () => {
	test("renders one card per host with the hub marked", async ({ page }) => {
		await open(page);
		const hub = page.locator(".host-card", { hasText: "hub-node" });
		const spoke = page.locator(".host-card", { hasText: "spoke-a" });
		await expect(hub.locator(".hub-badge")).toHaveText("HUB");
		await expect(spoke.locator(".hub-badge")).toHaveCount(0);
		await expect(spoke).toContainText("0.2.0");
	});

	test("lists each host's models and MCP tools", async ({ page }) => {
		await open(page);
		const hub = page.locator(".host-card", { hasText: "hub-node" });
		const spoke = page.locator(".host-card", { hasText: "spoke-a" });
		await expect(hub.locator(".pill", { hasText: "claude-3-sonnet" })).toBeVisible();
		await expect(hub.locator(".pill-outline", { hasText: "github" })).toBeVisible();
		await expect(spoke.locator(".pill", { hasText: "gpt-4" })).toBeVisible();
		await expect(spoke.locator(".pill-outline", { hasText: "slack" })).toBeVisible();
	});

	test("renders the sync mesh with its columns and peer rows", async ({ page }) => {
		await open(page);
		await expect(page.getByRole("heading", { name: "Sync Mesh" })).toBeVisible();
		const columns = page.locator(".mesh-columns span");
		await expect(columns).toHaveText(["Peer", "Sent", "Received", "Last Sync", "Errors"]);
		await expect(page.locator(".mesh-row")).not.toHaveCount(0);
	});

	test("colors sync error counts red only when nonzero", async ({ page }) => {
		await open(page, 3);
		const spoke = page.locator(".host-card", { hasText: "spoke-a" });
		const errors = spoke.locator(".row", { hasText: "Errors (24h)" }).locator(".mono");
		await expect(errors).toHaveText("3");
		await expect(errors).toHaveAttribute("style", /var\(--err\)/);
	});

	test("zero sync errors stay neutral", async ({ page }) => {
		await open(page, 0);
		const spoke = page.locator(".host-card", { hasText: "spoke-a" });
		const errors = spoke.locator(".row", { hasText: "Errors (24h)" }).locator(".mono");
		await expect(errors).toHaveText("0");
		await expect(errors).not.toHaveAttribute("style", /var\(--err\)/);
	});
});
