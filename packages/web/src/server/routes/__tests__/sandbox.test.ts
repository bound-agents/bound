import { describe, expect, it } from "bun:test";
import type { MountableFs } from "just-bash";
import { createSandboxRoutes } from "../sandbox";

// createSandboxRoutes bridges raw octet-stream bodies to a just-bash
// MountableFs (binary-string convention: one char per byte). These tests drive
// every branch — the null-fs 503, path validation, the binary round-trip, and
// the ENOENT/EISDIR/generic error mapping — with a minimal fake FS.

type FsError = Error & { code?: string };

/** A MountableFs stub whose readFile/writeFile are caller-controlled. */
function fakeFs(
	impl: Partial<{
		readFile: (path: string) => Promise<string>;
		writeFile: (path: string, content: string) => Promise<void>;
	}> = {},
): MountableFs {
	return {
		readFile: impl.readFile ?? (async () => ""),
		writeFile: impl.writeFile ?? (async () => {}),
	} as unknown as MountableFs;
}

describe("sandbox routes — GET /file", () => {
	it("returns 503 when no cluster filesystem is wired", async () => {
		const app = createSandboxRoutes(null);
		const res = await app.request("/file?path=/a.txt");
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "Sandbox filesystem not available" });
	});

	it("rejects a missing path query with 400", async () => {
		const app = createSandboxRoutes(fakeFs());
		const res = await app.request("/file");
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("Missing required query parameter");
	});

	it("rejects a relative path", async () => {
		const app = createSandboxRoutes(fakeFs());
		const res = await app.request("/file?path=relative/path");
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Path must be absolute");
	});

	it("rejects an unnormalized path with a traversal segment", async () => {
		const app = createSandboxRoutes(fakeFs());
		const res = await app.request(`/file?path=${encodeURIComponent("/a/../b")}`);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Path must be normalized");
	});

	it("returns the file bytes as octet-stream on success", async () => {
		// "binary" convention: byte 0xFF is char 0xFF. Confirm the round-trip
		// restores raw octets on the wire.
		const stored = String.fromCharCode(0x00, 0xff, 0x41);
		const app = createSandboxRoutes(fakeFs({ readFile: async () => stored }));
		const res = await app.request("/file?path=/bin.dat");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(res.headers.get("Content-Length")).toBe("3");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([...bytes]).toEqual([0x00, 0xff, 0x41]);
	});

	it("maps an ENOENT read to 404", async () => {
		const err: FsError = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		const app = createSandboxRoutes(
			fakeFs({
				readFile: async () => {
					throw err;
				},
			}),
		);
		const res = await app.request("/file?path=/missing.txt");
		expect(res.status).toBe(404);
		expect((await res.json()).error).toContain("File not found: /missing.txt");
	});

	it("maps an EISDIR read (via message prefix) to 400", async () => {
		const app = createSandboxRoutes(
			fakeFs({
				readFile: async () => {
					throw new Error("EISDIR: illegal operation on a directory");
				},
			}),
		);
		const res = await app.request("/file?path=/adir");
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("Path is a directory: /adir");
	});

	it("maps an unexpected read error to 500 with details", async () => {
		const app = createSandboxRoutes(
			fakeFs({
				readFile: async () => {
					throw new Error("disk melted");
				},
			}),
		);
		const res = await app.request("/file?path=/x.txt");
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toBe("Failed to read sandbox file");
		expect(body.details).toBe("disk melted");
	});
});

describe("sandbox routes — PUT /file", () => {
	it("returns 503 when no cluster filesystem is wired", async () => {
		const app = createSandboxRoutes(null);
		const res = await app.request("/file?path=/a.txt", {
			method: "PUT",
			body: new Uint8Array([1, 2, 3]),
		});
		expect(res.status).toBe(503);
	});

	it("rejects a missing path query with 400", async () => {
		const app = createSandboxRoutes(fakeFs());
		const res = await app.request("/file", { method: "PUT", body: new Uint8Array([1]) });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("Missing required query parameter");
	});

	it("rejects an invalid (unnormalized) path", async () => {
		const app = createSandboxRoutes(fakeFs());
		const res = await app.request(`/file?path=${encodeURIComponent("/a/./b")}`, {
			method: "PUT",
			body: new Uint8Array([1]),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Path must be normalized");
	});

	it("writes raw octets through the binary-string convention and reports the byte count", async () => {
		let writtenPath = "";
		let written = "";
		const app = createSandboxRoutes(
			fakeFs({
				writeFile: async (path, content) => {
					writtenPath = path;
					written = content;
				},
			}),
		);
		const payload = new Uint8Array([0x00, 0xff, 0x7f]);
		const res = await app.request("/file?path=/out.dat", { method: "PUT", body: payload });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytes: 3 });
		expect(writtenPath).toBe("/out.dat");
		// Each byte survives as a one-char code unit.
		expect([...written].map((c) => c.charCodeAt(0))).toEqual([0x00, 0xff, 0x7f]);
	});

	it("maps an EISDIR write to 400", async () => {
		const err: FsError = Object.assign(new Error("is a dir"), { code: "EISDIR" });
		const app = createSandboxRoutes(
			fakeFs({
				writeFile: async () => {
					throw err;
				},
			}),
		);
		const res = await app.request("/file?path=/adir", {
			method: "PUT",
			body: new Uint8Array([1]),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("Path is a directory: /adir");
	});

	it("maps an unexpected write error to 500 with details", async () => {
		const app = createSandboxRoutes(
			fakeFs({
				writeFile: async () => {
					throw new Error("quota exceeded");
				},
			}),
		);
		const res = await app.request("/file?path=/x.txt", {
			method: "PUT",
			body: new Uint8Array([1]),
		});
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toBe("Failed to write sandbox file");
		expect(body.details).toBe("quota exceeded");
	});
});
