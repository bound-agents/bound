import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { storeFile } from "../files";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

describe("storeFile — content-hash dedup (#159)", () => {
	let db: Database;
	const siteId = "test-site";
	const base = {
		mimeType: "application/pdf",
		createdBy: "u",
		hostOrigin: "h",
	};

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	it("no-ops to the existing row when identical content is re-uploaded under the same name", async () => {
		const id1 = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("hello") });
		const id2 = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("hello") });
		expect(id2).toBe(id1);
		const rows = db.query("SELECT id FROM files WHERE deleted = 0").all();
		expect(rows.length).toBe(1);
	});

	it("creates distinct rows for the same name with different content", async () => {
		const id1 = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("v1") });
		const id2 = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("v2") });
		expect(id2).not.toBe(id1);
		const paths = (
			db.query("SELECT path FROM files WHERE deleted = 0").all() as { path: string }[]
		).map((r) => r.path);
		expect(new Set(paths).size).toBe(2);
	});

	it("inserts the content hash before the extension", async () => {
		const id = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("hello") });
		const row = db.query("SELECT path FROM files WHERE id = ?").get(id) as { path: string };
		expect(row.path).toMatch(/\/home\/user\/uploads\/report\.[0-9a-f]+\.pdf$/);
	});

	it("handles extensionless names by appending the hash", async () => {
		const id = await storeFile(db, siteId, { ...base, name: "LICENSE", data: buf("x") });
		const row = db.query("SELECT path FROM files WHERE id = ?").get(id) as { path: string };
		expect(row.path).toMatch(/\/home\/user\/uploads\/LICENSE\.[0-9a-f]+$/);
	});
});
