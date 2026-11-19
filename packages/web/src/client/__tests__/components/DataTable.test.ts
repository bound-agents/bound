import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createRawSnippet } from "svelte";
import DataTable from "../../components/DataTable.svelte";
import { installDom } from "../harness/dom";

const dom = installDom();
afterAll(() => dom.teardown());

type Row = Record<string, unknown>;

const basicColumns = [
	{ key: "name", label: "Name" },
	{ key: "count", label: "Count" },
];

const rows: Row[] = [
	{ id: "a", name: "Charlie", count: 3 },
	{ id: "b", name: "alpha", count: 20 },
	{ id: "c", name: "Bravo", count: 100 },
];

function cellTexts(target: HTMLElement): string[] {
	return [...target.querySelectorAll(".data-cell")].map((c) => c.textContent?.trim() ?? "");
}

function dataRows(target: HTMLElement): HTMLElement[] {
	return [...target.querySelectorAll<HTMLElement>(".data-row")];
}

describe("DataTable", () => {
	beforeEach(() => {
		// no-op: each test mounts its own instance
	});

	it("renders column headers and all cell values in row order", async () => {
		const { target } = await dom.mount(DataTable, { columns: basicColumns, rows });
		const headers = [...target.querySelectorAll(".header-label")].map((h) => h.textContent);
		expect(headers).toEqual(["Name", "Count"]);
		// Rows render in the order provided (sortable=false, no sort applied).
		expect(cellTexts(target)).toEqual(["Charlie", "3", "alpha", "20", "Bravo", "100"]);
		expect(dataRows(target)).toHaveLength(3);
	});

	it("shows no data rows when rows is empty", async () => {
		const { target } = await dom.mount(DataTable, { columns: basicColumns, rows: [] });
		expect(dataRows(target)).toHaveLength(0);
		// Headers still render.
		expect(target.querySelectorAll(".header-label")).toHaveLength(2);
	});

	it("applies a format projection for display while leaving raw values for sorting", async () => {
		const columns = [
			{ key: "name", label: "Name" },
			{ key: "ms", label: "Latency", format: (v: unknown) => `${v}ms` },
		];
		const { target } = await dom.mount(DataTable, {
			columns,
			rows: [{ id: "x", name: "A", ms: 42 }],
		});
		expect(cellTexts(target)).toEqual(["A", "42ms"]);
	});

	it("renders empty string for a missing cell value", async () => {
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows: [{ id: "x", name: "OnlyName" }],
		});
		// count is undefined -> renders as "".
		expect(cellTexts(target)).toEqual(["OnlyName", ""]);
	});

	it("does not sort when sortable is false even if a header is clicked", async () => {
		const { target } = await dom.mount(DataTable, { columns: basicColumns, rows });
		const header = target.querySelector<HTMLElement>(".header-cell");
		expect(header?.classList.contains("sortable")).toBe(false);
		await dom.fire(header as Element, "click");
		// Order unchanged; no sort arrow rendered.
		expect(cellTexts(target)).toEqual(["Charlie", "3", "alpha", "20", "Bravo", "100"]);
		expect(target.querySelector(".sort-arrow")).toBeNull();
	});

	it("sorts ascending then descending on header click (case-insensitive string sort)", async () => {
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows,
			sortable: true,
		});
		const nameHeader = target.querySelectorAll<HTMLElement>(".header-cell")[0];
		await dom.fire(nameHeader, "click");
		// asc: alpha, Bravo, Charlie
		expect(cellTexts(target)).toEqual(["alpha", "20", "Bravo", "100", "Charlie", "3"]);
		expect(nameHeader.classList.contains("active")).toBe(true);
		const arrow = target.querySelector(".sort-arrow");
		expect(arrow?.textContent?.trim()).toBe("▲");

		await dom.fire(nameHeader, "click");
		// desc: Charlie, Bravo, alpha
		expect(cellTexts(target)).toEqual(["Charlie", "3", "Bravo", "100", "alpha", "20"]);
		expect(target.querySelector(".sort-arrow")?.textContent?.trim()).toBe("▼");
	});

	it("switches sort key and resets to ascending when a different header is clicked", async () => {
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows,
			sortable: true,
		});
		const [nameHeader, countHeader] = target.querySelectorAll<HTMLElement>(".header-cell");
		await dom.fire(nameHeader, "click"); // sort by name asc
		await dom.fire(countHeader, "click"); // switch to count asc
		// numeric asc: 3, 20, 100
		expect(cellTexts(target)).toEqual(["Charlie", "3", "alpha", "20", "Bravo", "100"]);
		expect(countHeader.classList.contains("active")).toBe(true);
		expect(nameHeader.classList.contains("active")).toBe(false);
	});

	it("sorts via keyboard (Enter and Space) on a sortable header", async () => {
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows,
			sortable: true,
		});
		const countHeader = target.querySelectorAll<HTMLElement>(".header-cell")[1];
		await dom.fire(countHeader, "keydown", { key: "Enter" });
		expect(cellTexts(target)).toEqual(["Charlie", "3", "alpha", "20", "Bravo", "100"]);
		await dom.fire(countHeader, "keydown", { key: " " });
		// toggled to desc: 100, 20, 3
		expect(cellTexts(target)).toEqual(["Bravo", "100", "alpha", "20", "Charlie", "3"]);
	});

	it("ignores non-activation keys on a sortable header", async () => {
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows,
			sortable: true,
		});
		const countHeader = target.querySelectorAll<HTMLElement>(".header-cell")[1];
		await dom.fire(countHeader, "keydown", { key: "ArrowDown" });
		expect(target.querySelector(".sort-arrow")).toBeNull();
		expect(cellTexts(target)).toEqual(["Charlie", "3", "alpha", "20", "Bravo", "100"]);
	});

	it("calls onRowClick with the clicked row and marks rows clickable", async () => {
		const clicked: Row[] = [];
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows,
			onRowClick: (row: Row) => clicked.push(row),
		});
		const firstRow = dataRows(target)[0];
		expect(firstRow.classList.contains("clickable")).toBe(true);
		await dom.fire(firstRow, "click");
		expect(clicked).toHaveLength(1);
		expect(clicked[0].id).toBe("a");
	});

	it("fires onRowClick on keyboard activation", async () => {
		const clicked: Row[] = [];
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows,
			onRowClick: (row: Row) => clicked.push(row),
		});
		await dom.fire(dataRows(target)[1], "keydown", { key: "Enter" });
		expect(clicked[0].id).toBe("b");
	});

	it("expands and collapses a row's expanded content on click", async () => {
		const expandedContent = createRawSnippet((row: () => Row) => ({
			render: () => `<div class="detail">detail:${row().id}</div>`,
		}));
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows,
			expandable: true,
			expandedContent,
		});
		const firstRow = dataRows(target)[0];
		expect(firstRow.classList.contains("expandable")).toBe(true);
		expect(target.querySelector(".expanded-row")).toBeNull();

		await dom.fire(firstRow, "click");
		const expanded = target.querySelector(".expanded-row");
		expect(expanded).not.toBeNull();
		expect(expanded?.textContent).toContain("detail:a");

		// Clicking again collapses it.
		await dom.fire(dataRows(target)[0], "click");
		expect(target.querySelector(".expanded-row")).toBeNull();
	});

	it("keeps only one row expanded at a time", async () => {
		const expandedContent = createRawSnippet((row: () => Row) => ({
			render: () => `<div>detail:${row().id}</div>`,
		}));
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows,
			expandable: true,
			expandedContent,
		});
		await dom.fire(dataRows(target)[0], "click");
		await dom.fire(dataRows(target)[2], "click");
		const expandedRows = target.querySelectorAll(".expanded-row");
		expect(expandedRows).toHaveLength(1);
		expect(expandedRows[0].textContent).toContain("detail:c");
	});

	it("applies a row accent color when rowAccent returns a value", async () => {
		const { target } = await dom.mount(DataTable, {
			columns: basicColumns,
			rows,
			rowAccent: (row: Row) => (row.id === "a" ? "#ff0000" : null),
		});
		const [first, second] = dataRows(target);
		expect(first.classList.contains("accented")).toBe(true);
		expect(first.getAttribute("style")).toContain("--row-accent: #ff0000");
		expect(second.classList.contains("accented")).toBe(false);
	});

	it("renders mono cells with the mono class", async () => {
		const columns = [
			{ key: "id", label: "ID", mono: true },
			{ key: "name", label: "Name" },
		];
		const { target } = await dom.mount(DataTable, {
			columns,
			rows: [{ id: "abc123", name: "N" }],
		});
		const monoCells = target.querySelectorAll(".data-cell.mono");
		expect(monoCells).toHaveLength(1);
		expect(monoCells[0].textContent?.trim()).toBe("abc123");
	});

	it("uses column widths in the grid template", async () => {
		const columns = [
			{ key: "a", label: "A", width: "200px" },
			{ key: "b", label: "B" },
		];
		const { target } = await dom.mount(DataTable, { columns, rows: [] });
		const headerRow = target.querySelector<HTMLElement>(".header-row");
		expect(headerRow?.getAttribute("style")).toContain("grid-template-columns: 200px 1fr");
	});
});
