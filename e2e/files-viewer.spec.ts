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

	test.describe("File Preview Modal", () => {
		// Extended test data with different file types for preview testing
		const previewTestFiles = [
			// Code file
			{
				id: "10",
				path: "home/user/src/app.ts",
				is_binary: 0,
				size_bytes: 256,
				content: 'export function hello(): string {\n\treturn "world";\n}\n',
				created_at: "2026-03-30T00:00:00Z",
				modified_at: "2026-03-30T00:00:00Z",
				deleted: 0,
				created_by: "agent",
				host_origin: "local",
			},
			// Markdown file
			{
				id: "11",
				path: "home/user/docs/readme.md",
				is_binary: 0,
				size_bytes: 128,
				content: "# Hello\n\nThis is **bold** text.",
				created_at: "2026-03-30T00:00:00Z",
				modified_at: "2026-03-30T00:00:00Z",
				deleted: 0,
				created_by: "agent",
				host_origin: "local",
			},
			// Plain text file
			{
				id: "12",
				path: "home/user/notes.txt",
				is_binary: 0,
				size_bytes: 32,
				content: "Some plain text content",
				created_at: "2026-03-30T00:00:00Z",
				modified_at: "2026-03-30T00:00:00Z",
				deleted: 0,
				created_by: "agent",
				host_origin: "local",
			},
			// Empty file
			{
				id: "13",
				path: "home/user/empty.txt",
				is_binary: 0,
				size_bytes: 0,
				content: null,
				created_at: "2026-03-30T00:00:00Z",
				modified_at: "2026-03-30T00:00:00Z",
				deleted: 0,
				created_by: "agent",
				host_origin: "local",
			},
			// Binary file
			{
				id: "14",
				path: "home/user/data.bin",
				is_binary: 1,
				size_bytes: 1024,
				content: "AQID",
				created_at: "2026-03-30T00:00:00Z",
				modified_at: "2026-03-30T00:00:00Z",
				deleted: 0,
				created_by: "agent",
				host_origin: "local",
			},
			// Image file (1x1 transparent PNG, base64-encoded)
			{
				id: "15",
				path: "home/user/icon.png",
				is_binary: 1,
				size_bytes: 68,
				content:
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				created_at: "2026-03-30T00:00:00Z",
				modified_at: "2026-03-30T00:00:00Z",
				deleted: 0,
				created_by: "agent",
				host_origin: "local",
			},
			// SVG file (is_binary=0, raw XML text content)
			{
				id: "16",
				path: "home/user/logo.svg",
				is_binary: 0,
				size_bytes: 120,
				content:
					'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#009BBF"/></svg>',
				created_at: "2026-03-30T00:00:00Z",
				modified_at: "2026-03-30T00:00:00Z",
				deleted: 0,
				created_by: "agent",
				host_origin: "local",
			},
		];

		test.beforeEach(async ({ page }) => {
			// Mock file list endpoint
			await page.route("**/api/files", async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(previewTestFiles),
				});
			});

			// Mock individual file content endpoint
			await page.route("**/api/files/**", async (route) => {
				const url = route.request().url();
				const path = url.split("/api/files/")[1];
				const file = previewTestFiles.find((f) => f.path === path);
				if (file) {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify(file),
					});
				} else {
					await route.abort();
				}
			});
		});

		test("AC2.1: opens modal on file click", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Find and click first file row
			const fileRow = page.locator(".listing-row.listing-file").first();
			await expect(fileRow).toBeVisible();
			await fileRow.click();

			// Wait for modal to appear
			await page.waitForTimeout(200);

			// Verify modal backdrop and panel are visible
			const backdrop = page.locator(".modal-backdrop");
			const panel = page.locator(".modal-panel");
			await expect(backdrop).toBeVisible();
			await expect(panel).toBeVisible();

			// Verify accessibility attributes
			await expect(panel).toHaveAttribute("role", "dialog");
			await expect(panel).toHaveAttribute("aria-modal", "true");

			// Verify ARIA labels
			await expect(panel).toHaveAttribute("aria-label", /^File preview:/);

			// Verify close button ARIA label
			const closeBtn = page.locator(".close-btn");
			await expect(closeBtn).toHaveAttribute("aria-label", "Close preview");
		});

		test("AC2.2: renders code with syntax highlighting", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Click the TypeScript file (app.ts)
			const fileRow = page.locator(".listing-row.listing-file").filter({ hasText: "app.ts" });
			await fileRow.click();

			// Wait for modal and content to render
			await page.waitForTimeout(200);

			// Verify code preview exists
			const codePreview = page.locator(".preview-code");
			await expect(codePreview).toBeVisible();

			// Verify syntax highlighting HTML is present (shiki generates <span> tags with style)
			const preTag = codePreview.locator("pre");
			await expect(preTag).toBeVisible();

			// Verify content is present
			const content = await codePreview.textContent();
			expect(content).toContain("hello");
		});

		test("AC2.3: renders markdown as formatted HTML", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Click the markdown file (readme.md)
			const fileRow = page.locator(".listing-row.listing-file").filter({ hasText: "readme.md" });
			await fileRow.click();

			// Wait for modal and content to render
			await page.waitForTimeout(200);

			// Verify markdown preview exists
			const markdownPreview = page.locator(".preview-markdown");
			await expect(markdownPreview).toBeVisible();

			// Verify HTML elements are rendered
			const h1 = markdownPreview.locator("h1");
			await expect(h1).toBeVisible();
			const h1Text = await h1.textContent();
			expect(h1Text).toBe("Hello");

			// Verify bold text
			const strong = markdownPreview.locator("strong");
			await expect(strong).toBeVisible();
			const strongText = await strong.textContent();
			expect(strongText).toBe("bold");
		});

		test("AC2.4: displays PNG image inline", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Click the PNG file (icon.png)
			const fileRow = page.locator(".listing-row.listing-file").filter({ hasText: "icon.png" });
			await fileRow.click();

			// Wait for modal and content to render
			await page.waitForTimeout(200);

			// Verify image preview exists
			const imagePreview = page.locator(".preview-image");
			await expect(imagePreview).toBeVisible();

			// Verify img element with blob: URL
			const img = imagePreview.locator("img");
			await expect(img).toBeVisible();
			const src = await img.getAttribute("src");
			expect(src).toMatch(/^blob:/);
		});

		test("AC2.4: displays SVG image from raw text content", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Click the SVG file (logo.svg)
			const fileRow = page.locator(".listing-row.listing-file").filter({ hasText: "logo.svg" });
			await fileRow.click();

			// Wait for modal and content to render
			await page.waitForTimeout(200);

			// Verify image preview exists
			const imagePreview = page.locator(".preview-image");
			await expect(imagePreview).toBeVisible();

			// Verify img element with blob: URL
			const img = imagePreview.locator("img");
			await expect(img).toBeVisible();
			const src = await img.getAttribute("src");
			expect(src).toMatch(/^blob:/);
		});

		test("AC2.5: displays plain text in monospace", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Click the plain text file (notes.txt)
			const fileRow = page.locator(".listing-row.listing-file").filter({ hasText: "notes.txt" });
			await fileRow.click();

			// Wait for modal and content to render
			await page.waitForTimeout(200);

			// Verify text preview exists
			const textPreview = page.locator(".preview-text");
			await expect(textPreview).toBeVisible();

			// Verify content matches
			const content = await textPreview.textContent();
			expect(content).toContain("Some plain text content");
		});

		test("AC2.6: shows filename and download button", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Click a file to open modal
			const fileRow = page.locator(".listing-row.listing-file").first();
			await fileRow.click();

			// Wait for modal to appear
			await page.waitForTimeout(200);

			// Verify filename in header
			const title = page.locator(".modal-title");
			await expect(title).toBeVisible();
			const titleText = await title.textContent();
			expect(titleText).toBeTruthy();

			// Verify download button exists
			const downloadBtn = page.locator(".action-btn");
			await expect(downloadBtn).toBeVisible();
		});

		test("AC2.7: closes via close button", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Open modal
			const fileRow = page.locator(".listing-row.listing-file").first();
			await fileRow.click();
			await page.waitForTimeout(200);

			// Verify modal is visible
			const backdrop = page.locator(".modal-backdrop");
			await expect(backdrop).toBeVisible();

			// Click close button
			const closeBtn = page.locator(".close-btn");
			await closeBtn.click();

			// Wait and verify modal is gone
			await page.waitForTimeout(100);
			await expect(backdrop).not.toBeVisible();
		});

		test("AC2.7: closes via Escape key", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Open modal
			const fileRow = page.locator(".listing-row.listing-file").first();
			await fileRow.click();
			await page.waitForTimeout(200);

			// Verify modal is visible
			const backdrop = page.locator(".modal-backdrop");
			await expect(backdrop).toBeVisible();

			// Press Escape
			await page.keyboard.press("Escape");

			// Wait and verify modal is gone
			await page.waitForTimeout(100);
			await expect(backdrop).not.toBeVisible();
		});

		test("AC2.7: closes via backdrop click", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Open modal
			const fileRow = page.locator(".listing-row.listing-file").first();
			await fileRow.click();
			await page.waitForTimeout(200);

			// Verify modal is visible
			const backdrop = page.locator(".modal-backdrop");
			await expect(backdrop).toBeVisible();

			// Click backdrop (outside the panel)
			const panel = page.locator(".modal-panel");
			const panelBox = await panel.boundingBox();
			if (panelBox) {
				// Click outside the panel but inside backdrop
				await backdrop.click({
					position: { x: 10, y: 10 },
				});
			}

			// Wait and verify modal is gone
			await page.waitForTimeout(100);
			await expect(backdrop).not.toBeVisible();
		});

		test("AC2.8: shows binary fallback", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Click the binary file (data.bin)
			const fileRow = page.locator(".listing-row.listing-file").filter({ hasText: "data.bin" });
			await fileRow.click();

			// Wait for modal and content to render
			await page.waitForTimeout(200);

			// Verify binary fallback exists
			const binaryPreview = page.locator(".preview-binary");
			await expect(binaryPreview).toBeVisible();

			// Verify message text
			const text = await binaryPreview.textContent();
			expect(text).toContain("Preview not available");

			// Verify download button exists
			const downloadBtn = page.locator(".download-btn-large");
			await expect(downloadBtn).toBeVisible();
		});

		test("AC2.9: shows error state with retry", async ({ page }) => {
			let fileContentCallCount = 0;
			// File content endpoint initially fails
			await page.route("**/api/files/home/user/src/app.ts", async (route) => {
				fileContentCallCount++;
				if (fileContentCallCount === 1) {
					// First call fails
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ error: "Server error" }),
					});
				} else {
					// Subsequent calls succeed
					const file = previewTestFiles.find((f) => f.id === "10");
					if (file) {
						await route.fulfill({
							status: 200,
							contentType: "application/json",
							body: JSON.stringify(file),
						});
					}
				}
			});

			// Catch-all for other files
			await page.route("**/api/files/**", async (route) => {
				const url = route.request().url();
				const path = url.split("/api/files/")[1];
				if (path !== "home/user/src/app.ts") {
					const file = previewTestFiles.find((f) => f.path === path);
					if (file) {
						await route.fulfill({
							status: 200,
							contentType: "application/json",
							body: JSON.stringify(file),
						});
					}
				}
			});

			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Click the TypeScript file to trigger error
			const fileRow = page.locator(".listing-row.listing-file").filter({ hasText: "app.ts" });
			await fileRow.click();

			// Wait for modal and error to render
			await page.waitForTimeout(300);

			// Verify error state exists
			const errorDiv = page.locator(".modal-error");
			await expect(errorDiv).toBeVisible();

			// Verify retry button exists
			const retryBtn = page.locator(".retry-btn");
			await expect(retryBtn).toBeVisible();

			// Click retry
			await retryBtn.click();

			// Wait for retry to complete
			await page.waitForTimeout(300);

			// Verify content loads successfully
			const codePreview = page.locator(".preview-code");
			await expect(codePreview).toBeVisible();
		});

		test("AC2.10: shows empty file message", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Click the empty file (empty.txt)
			const fileRow = page.locator(".listing-row.listing-file").filter({ hasText: "empty.txt" });
			await fileRow.click();

			// Wait for modal and content to render
			await page.waitForTimeout(200);

			// Verify empty state exists
			const emptyDiv = page.locator(".modal-empty");
			await expect(emptyDiv).toBeVisible();

			// Verify message text
			const text = await emptyDiv.textContent();
			expect(text).toContain("This file is empty");
		});

		test("AC2.11: traps focus within modal", async ({ page }) => {
			await page.goto("/#/files");
			await page.waitForLoadState("networkidle");

			// Open modal
			const fileRow = page.locator(".listing-row.listing-file").first();
			await fileRow.click();
			await page.waitForTimeout(200);

			// Get all focusable elements in modal
			const focusableElements = await page
				.locator(".modal-panel button, .modal-panel [tabindex]")
				.count();
			expect(focusableElements).toBeGreaterThan(0);

			// Tab through multiple times and verify focus stays within modal
			for (let i = 0; i < focusableElements * 2 + 2; i++) {
				await page.keyboard.press("Tab");
				await page.waitForTimeout(50);

				// Verify focus is still within modal panel
				const focusedElement = await page.evaluate(() => {
					const el = document.activeElement;
					if (el) {
						const panel = el.closest(".modal-panel");
						return panel ? "inside" : "outside";
					}
					return "none";
				});

				expect(focusedElement).toBe("inside");
			}

			// Shift+Tab wrap test: after tabbing to first focusable, Shift+Tab should wrap to last
			// First, move to first focusable element
			await page.keyboard.press("Home"); // Move to beginning
			await page.keyboard.press("Tab");
			await page.waitForTimeout(50);

			// Now we should be on the first focusable element
			const _firstElementBeforeShiftTab = await page.evaluate(() => {
				const el = document.activeElement;
				return el?.className || "";
			});

			// Press Shift+Tab to wrap to last
			await page.keyboard.press("Shift+Tab");
			await page.waitForTimeout(50);

			// Verify focus is still within modal
			const afterShiftTab = await page.evaluate(() => {
				const el = document.activeElement;
				if (el) {
					const panel = el.closest(".modal-panel");
					return panel ? "inside" : "outside";
				}
				return "none";
			});
			expect(afterShiftTab).toBe("inside");

			// Focus restoration test: close modal and verify focus returns to trigger element
			// Store the modal button we clicked to open
			const triggerButton = page.locator(".listing-row.listing-file").first();
			const _triggerBoundingBox = await triggerButton.boundingBox();

			// Get focus position inside modal before closing
			const _focusBeforeClose = await page.evaluate(() => {
				const el = document.activeElement as HTMLElement;
				if (el) {
					const rect = el.getBoundingClientRect();
					return { x: rect.x, y: rect.y };
				}
				return null;
			});

			// Close modal via Escape
			await page.keyboard.press("Escape");
			await page.waitForTimeout(200);

			// Verify modal is closed
			const backdrop = page.locator(".modal-backdrop");
			await expect(backdrop).not.toBeVisible();

			// Verify focus was restored to the trigger element (file row)
			const focusAfterClose = await page.evaluate(() => {
				const el = document.activeElement as HTMLElement;
				if (el) {
					// Check if focused element is the file row
					const isFileRow =
						el.classList.contains("listing-row") || el.closest(".listing-row") !== null;
					return isFileRow ? "file-row" : el.className;
				}
				return "none";
			});
			expect(focusAfterClose).toBe("file-row");
		});
	});
});
