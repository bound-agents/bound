import { expect, test } from "@playwright/test";

// Skip E2E tests if SKIP_E2E env var is set
const skipE2E = process.env.SKIP_E2E === "1";

test.describe.configure({ mode: skipE2E ? "skip" : "default" });

test.describe("Network Status View", () => {
	test("should render TopologyDiagram SVG element", async ({ page }) => {
		// Mock /api/status/network endpoint
		await page.route("**/api/status/network", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					hosts: [
						{
							site_id: "node-001",
							host_name: "hub-node",
							version: "0.1.0",
							sync_url: "http://localhost:3000/sync",
							online_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
							models: '["claude-3-sonnet"]',
							mcp_tools: '["github"]',
							modified_at: new Date().toISOString(),
						},
						{
							site_id: "node-002",
							host_name: "spoke-a",
							version: "0.1.0",
							sync_url: "http://localhost:3001/sync",
							online_at: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
							models: '["gpt-4"]',
							mcp_tools: '["slack"]',
							modified_at: new Date().toISOString(),
						},
					],
					hub: { siteId: "node-001", hostName: "hub-node" },
					syncState: [
						{
							peer_site_id: "node-002",
							last_received: "2026-04-13T10:00:00.000Z_0001_node-002",
							last_sent: "2026-04-13T10:00:00.000Z_0001_node-001",
							last_sync_at: new Date(Date.now() - 30 * 1000).toISOString(),
							sync_errors: 0,
						},
					],
				}),
			});
		});

		// Navigate to network status
		await page.goto("/status/network");

		// Wait for page to load
		await page.waitForLoadState("networkidle");

		// Verify TopologyDiagram SVG element exists
		const topologyDiagram = page.locator(".topology-diagram").first();
		await expect(topologyDiagram).toBeDefined();
		const diagramCount = await topologyDiagram.count();
		expect(diagramCount).toBeGreaterThanOrEqual(1);

		// Verify SVG has circles for hub and spokes
		const circles = topologyDiagram.locator("circle");
		const circleCount = await circles.count();
		expect(circleCount).toBeGreaterThanOrEqual(3); // Hub (2 circles) + at least 1 spoke
	});

	test("should render host cards with LineBadge elements", async ({ page }) => {
		// Mock /api/status/network
		await page.route("**/api/status/network", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					hosts: [
						{
							site_id: "node-a",
							host_name: "host-a",
							version: "0.1.0",
							sync_url: null,
							online_at: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
							models: "[]",
							mcp_tools: "[]",
							modified_at: new Date().toISOString(),
						},
						{
							site_id: "node-b",
							host_name: "host-b",
							version: "0.1.0",
							sync_url: null,
							online_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
							models: "[]",
							mcp_tools: "[]",
							modified_at: new Date().toISOString(),
						},
					],
					hub: null,
					syncState: [],
				}),
			});
		});

		// Navigate to network status
		await page.goto("/status/network");

		// Wait for page to load
		await page.waitForLoadState("networkidle");

		// Verify host cards have LineBadge elements (colored circles)
		const hostCards = page.locator(".metro-card");
		const cardCount = await hostCards.count();
		expect(cardCount).toBeGreaterThanOrEqual(2);

		// Each card should contain a LineBadge (inline span with circular style)
		const lineBadges = page.locator(".metro-card span[role='img']");
		const badgeCount = await lineBadges.count();
		expect(badgeCount).toBeGreaterThanOrEqual(2);
	});

	test("should render StatusChip for online/offline state", async ({ page }) => {
		// Mock /api/status/network
		await page.route("**/api/status/network", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					hosts: [
						{
							site_id: "node-online",
							host_name: "online-host",
							version: "0.1.0",
							sync_url: null,
							online_at: new Date(Date.now() - 1 * 60 * 1000).toISOString(), // Online
							models: "[]",
							mcp_tools: "[]",
							modified_at: new Date().toISOString(),
						},
						{
							site_id: "node-offline",
							host_name: "offline-host",
							version: "0.1.0",
							sync_url: null,
							online_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // Offline
							models: "[]",
							mcp_tools: "[]",
							modified_at: new Date().toISOString(),
						},
					],
					hub: null,
					syncState: [],
				}),
			});
		});

		// Navigate to network status
		await page.goto("/status/network");

		// Wait for page to load
		await page.waitForLoadState("networkidle");

		// Find StatusChip elements (they have a dot and label)
		const statusChips = page.locator(".status-chip");
		const chipCount = await statusChips.count();
		expect(chipCount).toBeGreaterThanOrEqual(2);

		// Collect chip text content
		const chipTexts: string[] = [];
		for (let i = 0; i < chipCount; i++) {
			const text = await statusChips.nth(i).textContent();
			if (text) {
				chipTexts.push(text);
			}
		}

		// Verify we have both online and offline statuses
		const hasOnline = chipTexts.some((text) => text.includes("Online"));
		const hasOffline = chipTexts.some((text) => text.includes("Offline"));
		expect(hasOnline).toBeTruthy();
		expect(hasOffline).toBeTruthy();
	});

	test("should render Sync Mesh DataTable with column headers", async ({ page }) => {
		// Mock /api/status/network with sync state data
		await page.route("**/api/status/network", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					hosts: [
						{
							site_id: "node-001",
							host_name: "hub-node",
							version: "0.1.0",
							sync_url: null,
							online_at: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
							models: "[]",
							mcp_tools: "[]",
							modified_at: new Date().toISOString(),
						},
						{
							site_id: "node-002",
							host_name: "spoke-a",
							version: "0.1.0",
							sync_url: null,
							online_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
							models: "[]",
							mcp_tools: "[]",
							modified_at: new Date().toISOString(),
						},
					],
					hub: { siteId: "node-001", hostName: "hub-node" },
					syncState: [
						{
							peer_site_id: "node-002",
							last_received: "2026-04-13T10:00:30.000Z_0002_node-002",
							last_sent: "2026-04-13T10:00:00.000Z_0001_node-001",
							last_sync_at: new Date(Date.now() - 30 * 1000).toISOString(),
							sync_errors: 0,
						},
					],
				}),
			});
		});

		// Navigate to network status
		await page.goto("/status/network");

		// Wait for page to load
		await page.waitForLoadState("networkidle");

		// Find the Sync Mesh section
		const syncMeshHeading = page.locator("h2", { hasText: "Sync Mesh" });
		await expect(syncMeshHeading).toBeDefined();

		// Find DataTable header cells
		const headerCells = page.locator(".header-cell");
		const headerCount = await headerCells.count();
		expect(headerCount).toBeGreaterThanOrEqual(5); // Peer, Sent, Received, Last Sync, Errors

		// Collect header text content
		const headerTexts: string[] = [];
		for (let i = 0; i < headerCount; i++) {
			const text = await headerCells.nth(i).textContent();
			if (text) {
				headerTexts.push(text.toUpperCase().trim());
			}
		}

		// Verify expected columns are present
		expect(headerTexts.some((t) => t.includes("PEER"))).toBeTruthy();
		expect(headerTexts.some((t) => t.includes("SENT"))).toBeTruthy();
		expect(headerTexts.some((t) => t.includes("RECEIVED"))).toBeTruthy();
		expect(headerTexts.some((t) => t.includes("LAST") && t.includes("SYNC"))).toBeTruthy();
		expect(headerTexts.some((t) => t.includes("ERROR"))).toBeTruthy();
	});

	test("should color-code error count in sync mesh table", async ({ page }) => {
		// Mock /api/status/network with sync errors
		await page.route("**/api/status/network", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					hosts: [
						{
							site_id: "node-001",
							host_name: "hub-node",
							version: "0.1.0",
							sync_url: null,
							online_at: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
							models: "[]",
							mcp_tools: "[]",
							modified_at: new Date().toISOString(),
						},
						{
							site_id: "node-002",
							host_name: "healthy-spoke",
							version: "0.1.0",
							sync_url: null,
							online_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
							models: "[]",
							mcp_tools: "[]",
							modified_at: new Date().toISOString(),
						},
						{
							site_id: "node-003",
							host_name: "error-spoke",
							version: "0.1.0",
							sync_url: null,
							online_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
							models: "[]",
							mcp_tools: "[]",
							modified_at: new Date().toISOString(),
						},
					],
					hub: { siteId: "node-001", hostName: "hub-node" },
					syncState: [
						{
							peer_site_id: "node-002",
							last_received: "2026-04-13T10:00:30.000Z_0002_node-002",
							last_sent: "2026-04-13T10:00:00.000Z_0001_node-001",
							last_sync_at: new Date(Date.now() - 30 * 1000).toISOString(),
							sync_errors: 0,
						},
						{
							peer_site_id: "node-003",
							last_received: "2026-04-13T09:59:00.000Z_0001_node-003",
							last_sent: "2026-04-13T09:58:00.000Z_0001_node-001",
							last_sync_at: new Date(Date.now() - 60 * 1000).toISOString(),
							sync_errors: 3,
						},
					],
				}),
			});
		});

		// Navigate to network status
		await page.goto("/status/network");

		// Wait for page to load
		await page.waitForLoadState("networkidle");

		// Find the sync mesh table rows
		const dataRows = page.locator(".data-row");
		const rowCount = await dataRows.count();
		expect(rowCount).toBeGreaterThanOrEqual(2);

		// Verify we have rows with error styling
		const rowsWithAccent = page.locator(".data-row[style*='border-left']");
		const accentRowCount = await rowsWithAccent.count();
		// At least one row should have accent color (error row)
		expect(accentRowCount).toBeGreaterThanOrEqual(1);
	});
});
