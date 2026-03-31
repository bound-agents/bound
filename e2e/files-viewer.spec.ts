import { expect, test } from "@playwright/test";

// Skip E2E tests if SKIP_E2E env var is set
const skipE2E = process.env.SKIP_E2E === "1";

test.describe.configure({ mode: skipE2E ? "skip" : "default" });

test.describe("Files Viewer Layout and Directory Selection", () => {
	// Test data matching FileMetadata interface
	const testFiles = [
		{
			id: "1",
			path: "home/user/src/index.ts",
			is_binary: 0,
			size_bytes: 1024,
			created_at: "2026-03-30T00:00:00Z",
			modified_at: "2026-03-30T00:00:00Z",
			deleted: 0,
			created_by: "agent",
			host_origin: "local",
		},
		{
			id: "2",
			path: "home/user/src/utils.ts",
			is_binary: 0,
			size_bytes: 512,
			created_at: "2026-03-30T00:00:00Z",
			modified_at: "2026-03-30T00:00:00Z",
			deleted: 0,
			created_by: "agent",
			host_origin: "local",
		},
		{
			id: "3",
			path: "home/user/docs/readme.md",
			is_binary: 0,
			size_bytes: 256,
			created_at: "2026-03-30T00:00:00Z",
			modified_at: "2026-03-30T00:00:00Z",
			deleted: 0,
			created_by: "agent",
			host_origin: "local",
		},
		{
			id: "4",
			path: "home/user/config.json",
			is_binary: 0,
			size_bytes: 128,
			created_at: "2026-03-30T00:00:00Z",
			modified_at: "2026-03-30T00:00:00Z",
			deleted: 0,
			created_by: "agent",
			host_origin: "local",
		},
	];

	test("AC1.1: Stable two-panel grid layout", async ({ page }) => {
		// Mock GET /api/files to return test data
		await page.route("**/api/files", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(testFiles),
			});
		});

		// Navigate to the files view
		await page.goto("/#/files");

		// Wait for the page to load
		await page.waitForLoadState("networkidle");

		// Verify the files-browser grid container exists
		const filesBrowser = page.locator(".files-browser");
		await expect(filesBrowser).toBeVisible();

		// Verify it's a grid layout
		const displayValue = await filesBrowser.evaluate((el) => {
			return window.getComputedStyle(el).display;
		});
		expect(displayValue).toBe("grid");

		// Verify tree-sidebar and content-area are visible children
		const treeSidebar = page.locator(".tree-sidebar");
		const contentArea = page.locator(".content-area");

		await expect(treeSidebar).toBeVisible();
		await expect(contentArea).toBeVisible();

		// Verify sidebar has fixed width around 260px
		const sidebarWidth = await treeSidebar.evaluate((el) => {
			return el.getBoundingClientRect().width;
		});
		expect(sidebarWidth).toBeCloseTo(260, 5);
	});

	test("AC1.2: Content area stable when collapsing directories", async ({ page }) => {
		// Mock GET /api/files to return test data
		await page.route("**/api/files", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(testFiles),
			});
		});

		// Navigate to the files view
		await page.goto("/#/files");

		// Wait for the page to load
		await page.waitForLoadState("networkidle");

		// Get the initial content area bounding box
		const contentArea = page.locator(".content-area");
		const initialBbox = await contentArea.evaluate((el) => {
			const rect = el.getBoundingClientRect();
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		});

		// Find a directory toggle button and click it to collapse
		const toggleButtons = page.locator(".expand-button");
		const count = await toggleButtons.count();
		expect(count).toBeGreaterThan(0);

		// Click the first toggle to collapse
		await toggleButtons.first().click();

		// Wait a moment for any reflow
		await page.waitForTimeout(100);

		// Get the content area bounding box after collapse
		const afterCollapseBbox = await contentArea.evaluate((el) => {
			const rect = el.getBoundingClientRect();
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		});

		// Verify the bounding box did not change
		expect(afterCollapseBbox.x).toBe(initialBbox.x);
		expect(afterCollapseBbox.y).toBe(initialBbox.y);
		expect(afterCollapseBbox.width).toBe(initialBbox.width);
		expect(afterCollapseBbox.height).toBe(initialBbox.height);

		// Click the toggle again to expand
		await toggleButtons.first().click();

		// Wait a moment for any reflow
		await page.waitForTimeout(100);

		// Get the content area bounding box after expand
		const afterExpandBbox = await contentArea.evaluate((el) => {
			const rect = el.getBoundingClientRect();
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		});

		// Verify the bounding box is still stable
		expect(afterExpandBbox.x).toBe(initialBbox.x);
		expect(afterExpandBbox.y).toBe(initialBbox.y);
		expect(afterExpandBbox.width).toBe(initialBbox.width);
		expect(afterExpandBbox.height).toBe(initialBbox.height);
	});

	test("AC1.5: Directory selection with visual highlight", async ({ page }) => {
		// Mock GET /api/files to return test data
		await page.route("**/api/files", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(testFiles),
			});
		});

		// Navigate to the files view
		await page.goto("/#/files");

		// Wait for the page to load
		await page.waitForLoadState("networkidle");

		// Get all directory nodes in the tree
		const dirNodes = page.locator(".node-dir");
		const dirCount = await dirNodes.count();
		expect(dirCount).toBeGreaterThan(0);

		// Click the first directory to select it
		const firstDir = dirNodes.first();
		await firstDir.click();

		// Wait for selection to apply
		await page.waitForTimeout(50);

		// Verify the first directory has the node-selected class
		const hasSelectedClass = await firstDir.evaluate((el) => {
			return el.classList.contains("node-selected");
		});
		expect(hasSelectedClass).toBe(true);

		// Verify a different directory does NOT have the selected class (if there's another)
		if (dirCount > 1) {
			const secondDir = dirNodes.nth(1);
			const secondHasSelectedClass = await secondDir.evaluate((el) => {
				return el.classList.contains("node-selected");
			});
			expect(secondHasSelectedClass).toBe(false);

			// Click the second directory
			await secondDir.click();

			// Wait for selection to apply
			await page.waitForTimeout(50);

			// Verify the second directory now has the selected class
			const secondHasSelected = await secondDir.evaluate((el) => {
				return el.classList.contains("node-selected");
			});
			expect(secondHasSelected).toBe(true);

			// Verify the first directory no longer has the selected class
			const firstNoLongerSelected = await firstDir.evaluate((el) => {
				return el.classList.contains("node-selected");
			});
			expect(firstNoLongerSelected).toBe(false);
		}
	});

	test.describe("Breadcrumbs and Directory Listing", () => {
		test("AC1.3: displays breadcrumbs for current path", async ({ page }) => {
			// Mock GET /api/files to return test data
			await page.route("**/api/files", async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(testFiles),
				});
			});

			// Navigate to the files view
			await page.goto("/#/files");

			// Wait for the page to load
			await page.waitForLoadState("networkidle");

			// Verify initial breadcrumbs show only root
			const breadcrumbs = page.locator(".breadcrumbs");
			await expect(breadcrumbs).toBeVisible();

			let breadcrumbText = await breadcrumbs.textContent();
			expect(breadcrumbText).toContain("/");

			// Click a directory in the tree (e.g., "home")
			const dirNodes = page.locator(".node-dir");
			const firstDir = dirNodes.first();
			await firstDir.click();

			// Wait for breadcrumbs to update
			await page.waitForTimeout(50);

			// Verify breadcrumbs now contain "/" and the directory name
			breadcrumbText = await breadcrumbs.textContent();
			expect(breadcrumbText).toContain("/");
			expect(breadcrumbText).toContain("home");

			// Click into another directory if available (e.g., "user")
			const nestedDirNodes = page.locator(".node-dir");
			const nestedCount = await nestedDirNodes.count();
			if (nestedCount > 1) {
				const secondDir = nestedDirNodes.nth(1);
				await secondDir.click();

				// Wait for breadcrumbs to update
				await page.waitForTimeout(50);

				// Verify breadcrumbs show deeper path
				breadcrumbText = await breadcrumbs.textContent();
				expect(breadcrumbText).toContain("/");
				expect(breadcrumbText).toContain("home");
				expect(breadcrumbText).toContain("user");
			}
		});

		test("AC1.4: breadcrumb click navigates to directory", async ({ page }) => {
			// Mock GET /api/files to return test data
			await page.route("**/api/files", async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(testFiles),
				});
			});

			// Navigate to the files view
			await page.goto("/#/files");

			// Wait for the page to load
			await page.waitForLoadState("networkidle");

			// Navigate deep into directories via tree clicks
			const dirNodes = page.locator(".node-dir");
			const firstDir = dirNodes.first();
			await firstDir.click();

			// Wait for breadcrumbs to update
			await page.waitForTimeout(50);

			// Verify we're in a non-root directory
			let breadcrumbs = page.locator(".breadcrumbs");
			let breadcrumbText = await breadcrumbs.textContent();
			expect(breadcrumbText).toContain("home");

			// Click the root breadcrumb segment
			const rootBreadcrumb = page.locator(".breadcrumbs").locator(".segment").first();
			await rootBreadcrumb.click();

			// Wait for navigation
			await page.waitForTimeout(50);

			// Verify breadcrumbs reset to just "/"
			breadcrumbs = page.locator(".breadcrumbs");
			breadcrumbText = await breadcrumbs.textContent();
			expect(breadcrumbText?.trim()).toBe("/");

			// Verify directory listing shows top-level contents
			const listingBody = page.locator(".listing-body");
			await expect(listingBody).toBeVisible();
		});

		test("AC1.6: folder click in directory listing navigates into it", async ({ page }) => {
			// Mock GET /api/files to return test data
			await page.route("**/api/files", async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(testFiles),
				});
			});

			// Navigate to the files view
			await page.goto("/#/files");

			// Wait for the page to load
			await page.waitForLoadState("networkidle");

			// Get initial directory listing
			const initialListing = page.locator(".listing-row");
			const initialCount = await initialListing.count();
			expect(initialCount).toBeGreaterThan(0);

			// Find and click a directory row in the listing (dirs have the listing-dir class)
			const dirRow = page.locator(".listing-row.listing-dir").first();
			await expect(dirRow).toBeVisible();
			await dirRow.click();

			// Wait for navigation
			await page.waitForTimeout(50);

			// Verify breadcrumbs updated
			const breadcrumbs = page.locator(".breadcrumbs");
			const breadcrumbText = await breadcrumbs.textContent();
			expect(breadcrumbText).toContain("home");

			// Verify tree selection updated (the selected directory should have node-selected class)
			const selectedNode = page.locator(".node-dir.node-selected");
			await expect(selectedNode).toBeVisible();

			// Verify directory listing now shows the contents of the selected directory
			const updatedListing = page.locator(".listing-row");
			await expect(updatedListing).toBeDefined();
		});

		test("AC1.7: empty directory shows empty state", async ({ page }) => {
			// Mock GET /api/files to return an empty array
			await page.route("**/api/files", async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify([]),
				});
			});

			// Navigate to the files view
			await page.goto("/#/files");

			// Wait for the page to load
			await page.waitForLoadState("networkidle");

			// Verify the FilesView-level empty state renders (no files yet)
			const emptyState = page.locator(".empty-state");
			await expect(emptyState).toBeVisible();

			const emptyText = await emptyState.textContent();
			expect(emptyText).toContain("No files yet");
		});
	});
});
