import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createCopyTool } from "../tools/copy";

const HOSTNAME = "test-host";
const BOUND_URL = "http://localhost:9999";

function makeCopyTool() {
	return createCopyTool({ hostname: HOSTNAME, boundUrl: BOUND_URL });
}

interface FakeResponseInit {
	status?: number;
	body?: ArrayBuffer | string;
}

function makeResponse(init: FakeResponseInit): Response {
	const status = init.status ?? 200;
	if (init.body instanceof ArrayBuffer) {
		return new Response(init.body, {
			status,
			headers: { "Content-Type": "application/octet-stream" },
		});
	}
	if (typeof init.body === "string") {
		return new Response(init.body, { status });
	}
	return new Response(null, { status });
}

describe("boundless_copy", () => {
	let tempDir: string;
	let originalFetch: typeof fetch;

	beforeEach(() => {
		tempDir = join(tmpdir(), `boundless-copy-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(tempDir, { recursive: true });
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects missing source", async () => {
		const tool = makeCopyTool();
		const result = await tool(
			{ source_path: "a", target: "host", target_path: "b" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toContain("source");
	});

	it("rejects invalid source value", async () => {
		const tool = makeCopyTool();
		const result = await tool(
			{ source: "moon", source_path: "a", target: "satellite", target_path: "b" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toContain('"main" or "satellite"');
	});

	it("accepts the legacy host/sandbox spelling for replayed history", async () => {
		const sourcePath = join(tempDir, "legacy.txt");
		writeFileSync(sourcePath, "hi");
		const tool = makeCopyTool();
		// "host" normalizes to "satellite", "sandbox" would normalize to "main";
		// here both legacy values map to the real disk so the copy stays local.
		const result = await tool(
			{
				source: "host",
				source_path: sourcePath,
				target: "host",
				target_path: join(tempDir, "legacy-out.txt"),
			},
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBeUndefined();
	});

	it("rejects empty source_path", async () => {
		const tool = makeCopyTool();
		const result = await tool(
			{ source: "host", source_path: "", target: "host", target_path: "b" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
	});

	it("includes provenance block first", async () => {
		const sourcePath = join(tempDir, "a.txt");
		writeFileSync(sourcePath, "hi");
		const tool = makeCopyTool();
		const result = await tool(
			{
				source: "host",
				source_path: sourcePath,
				target: "host",
				target_path: join(tempDir, "b.txt"),
			},
			new AbortController().signal,
			tempDir,
		);
		const provenance = result.content[0] as { type: string; text: string };
		expect(provenance.type).toBe("text");
		expect(provenance.text).toContain("[boundless]");
		expect(provenance.text).toContain("tool=boundless_copy");
	});

	it("host -> host: copies bytes and creates parent directories", async () => {
		const sourcePath = join(tempDir, "src.bin");
		const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80]);
		writeFileSync(sourcePath, payload);

		const targetRel = "deeply/nested/dst.bin";
		const tool = makeCopyTool();
		const result = await tool(
			{
				source: "host",
				source_path: sourcePath,
				target: "host",
				target_path: targetRel,
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		const text = (result.content[1] as { text: string }).text;
		expect(text).toContain(`Copied ${payload.byteLength} bytes`);

		const targetAbs = join(tempDir, targetRel);
		expect(existsSync(targetAbs)).toBe(true);
		const got = readFileSync(targetAbs);
		expect(got.equals(payload)).toBe(true);
	});

	it("host -> host: reports ENOENT on missing source", async () => {
		const tool = makeCopyTool();
		const result = await tool(
			{
				source: "host",
				source_path: join(tempDir, "missing.txt"),
				target: "host",
				target_path: join(tempDir, "out.txt"),
			},
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toContain("not found");
	});

	it("host -> sandbox: PUTs to /api/sandbox/file with raw bytes", async () => {
		const sourcePath = join(tempDir, "src.txt");
		const payload = Buffer.from("hello sandbox", "utf8");
		writeFileSync(sourcePath, payload);

		let captured: { url: string; method: string; body: Buffer } | null = null;
		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const body = init?.body;
			let bodyBuf = Buffer.alloc(0);
			if (body instanceof Blob) {
				bodyBuf = Buffer.from(await body.arrayBuffer());
			} else if (body instanceof ArrayBuffer) {
				bodyBuf = Buffer.from(body);
			} else if (body instanceof Uint8Array) {
				bodyBuf = Buffer.from(body);
			}
			captured = { url: url.toString(), method, body: bodyBuf };
			return new Response(JSON.stringify({ bytes: bodyBuf.byteLength }), { status: 200 });
		}) as unknown as typeof fetch;

		const tool = makeCopyTool();
		const result = await tool(
			{
				source: "host",
				source_path: sourcePath,
				target: "sandbox",
				target_path: "/home/user/out.txt",
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		expect(captured).not.toBeNull();
		const c = captured as unknown as { url: string; method: string; body: Buffer };
		expect(c.method).toBe("PUT");
		expect(c.url).toBe(
			`${BOUND_URL}/api/sandbox/file?path=${encodeURIComponent("/home/user/out.txt")}`,
		);
		expect(c.body.equals(payload)).toBe(true);
	});

	it("sandbox -> host: GETs /api/sandbox/file and writes bytes locally", async () => {
		const payload = Buffer.from([0x10, 0x20, 0x30, 0x40]);

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const u = url.toString();
			expect(u).toBe(`${BOUND_URL}/api/sandbox/file?path=${encodeURIComponent("/tmp/in.bin")}`);
			return makeResponse({
				status: 200,
				body: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
			});
		}) as unknown as typeof fetch;

		const tool = makeCopyTool();
		const targetRel = "out/copied.bin";
		const result = await tool(
			{
				source: "sandbox",
				source_path: "/tmp/in.bin",
				target: "host",
				target_path: targetRel,
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		const targetAbs = join(tempDir, targetRel);
		expect(existsSync(targetAbs)).toBe(true);
		const got = readFileSync(targetAbs);
		expect(got.equals(payload)).toBe(true);
	});

	it("sandbox -> sandbox: GET then PUT, no host-side fs writes", async () => {
		const payload = Buffer.from("transfer-only", "utf8");
		const calls: Array<{ url: string; method: string }> = [];

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({ url: url.toString(), method });
			if (method === "GET") {
				return makeResponse({
					status: 200,
					body: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
				});
			}
			return new Response(JSON.stringify({ bytes: payload.byteLength }), { status: 200 });
		}) as unknown as typeof fetch;

		const tool = makeCopyTool();
		const result = await tool(
			{
				source: "sandbox",
				source_path: "/a/in.txt",
				target: "sandbox",
				target_path: "/b/out.txt",
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		expect(calls).toHaveLength(2);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toContain("/api/sandbox/file?path=");
		expect(calls[0]?.url).toContain(encodeURIComponent("/a/in.txt"));
		expect(calls[1]?.method).toBe("PUT");
		expect(calls[1]?.url).toContain(encodeURIComponent("/b/out.txt"));
	});

	it("sandbox source 404 maps to a not-found error", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ error: "File not found" }), { status: 404 });
		}) as unknown as typeof fetch;

		const tool = makeCopyTool();
		const result = await tool(
			{
				source: "sandbox",
				source_path: "/missing",
				target: "host",
				target_path: join(tempDir, "x.txt"),
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toContain("not found");
	});

	it("sandbox target 500 surfaces error", async () => {
		const sourcePath = join(tempDir, "src.txt");
		writeFileSync(sourcePath, "anything");

		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
		}) as unknown as typeof fetch;

		const tool = makeCopyTool();
		const result = await tool(
			{
				source: "host",
				source_path: sourcePath,
				target: "sandbox",
				target_path: "/tmp/dst.txt",
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toContain("HTTP 500");
	});
});

describe("boundless_copy — guards", () => {
	let tempDir: string;
	let originalFetch: typeof fetch;
	beforeEach(() => {
		tempDir = join(tmpdir(), `boundless-copy-guard-${randomBytes(4).toString("hex")}`);
		mkdirSync(tempDir, { recursive: true });
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("blocks a satellite-target copy onto the bound system database", async () => {
		const src = join(tempDir, "src.txt");
		writeFileSync(src, "payload");
		const tool = createCopyTool({ hostname: HOSTNAME, boundUrl: BOUND_URL });
		const result = await tool(
			{ source: "satellite", source_path: src, target: "satellite", target_path: "bound.db" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toMatch(/bound system database|refusing/i);
		expect(existsSync(join(tempDir, "bound.db"))).toBe(false);
	});

	it("appends a db-read advisory when the satellite source is the system database", async () => {
		// Source under data/ named like the system DB triggers the read advisory,
		// but the copy still succeeds (read is advised, not blocked).
		mkdirSync(join(tempDir, "data"), { recursive: true });
		const src = join(tempDir, "data", "app.db");
		writeFileSync(src, "rows");
		const tool = createCopyTool({ hostname: HOSTNAME, boundUrl: BOUND_URL });
		const result = await tool(
			{ source: "satellite", source_path: src, target: "satellite", target_path: "out.txt" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBeUndefined();
		const note = result.content.find(
			(b) => b.type === "text" && /query|database|db-guard/i.test(b.text ?? ""),
		);
		expect(note).toBeDefined();
		expect(existsSync(join(tempDir, "out.txt"))).toBe(true);
	});

	it("denies a satellite-target write outside the writable roots when the sandbox is enabled", async () => {
		const src = join(tempDir, "src.txt");
		writeFileSync(src, "payload");
		const sandbox = {
			enabled: true,
			writablePaths: [tempDir],
			network: "open",
			onUnavailable: "error",
		} as const;
		const tool = createCopyTool({
			hostname: HOSTNAME,
			boundUrl: BOUND_URL,
			sandbox: sandbox as unknown as Parameters<typeof createCopyTool>[0]["sandbox"],
		});
		const outside = join(homedir(), `.boundless-copy-deny-${randomBytes(4).toString("hex")}.txt`);
		const result = await tool(
			{ source: "satellite", source_path: src, target: "satellite", target_path: outside },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(existsSync(outside)).toBe(false);
	});

	it("surfaces a main-source fetch network failure", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("econnrefused");
		}) as unknown as typeof fetch;
		const tool = createCopyTool({ hostname: HOSTNAME, boundUrl: BOUND_URL });
		const result = await tool(
			{ source: "main", source_path: "/vfs/a.txt", target: "satellite", target_path: "out.txt" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toMatch(/request failed/i);
	});

	it("maps a main-source 404 to a not-found error", async () => {
		globalThis.fetch = mock(
			async () => new Response(null, { status: 404 }),
		) as unknown as typeof fetch;
		const tool = createCopyTool({ hostname: HOSTNAME, boundUrl: BOUND_URL });
		const result = await tool(
			{
				source: "main",
				source_path: "/vfs/missing.txt",
				target: "satellite",
				target_path: "out.txt",
			},
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toMatch(/not found/i);
	});

	it("surfaces a main-source non-ok HTTP error with the response detail", async () => {
		globalThis.fetch = mock(
			async () => new Response("it is a directory", { status: 400 }),
		) as unknown as typeof fetch;
		const tool = createCopyTool({ hostname: HOSTNAME, boundUrl: BOUND_URL });
		const result = await tool(
			{ source: "main", source_path: "/vfs/dir", target: "satellite", target_path: "out.txt" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toMatch(/HTTP 400/i);
	});

	it("copies main -> satellite, GETting the VFS and writing bytes locally", async () => {
		const payload = Buffer.from("vfs-bytes");
		globalThis.fetch = mock(async (url: string | URL | Request) => {
			expect(String(url)).toContain("/api/sandbox/file");
			const ab = new ArrayBuffer(payload.byteLength);
			new Uint8Array(ab).set(payload);
			return new Response(ab, { status: 200 });
		}) as unknown as typeof fetch;
		const tool = createCopyTool({ hostname: HOSTNAME, boundUrl: BOUND_URL });
		const result = await tool(
			{ source: "main", source_path: "/vfs/a.txt", target: "satellite", target_path: "local.txt" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(tempDir, "local.txt"), "utf-8")).toBe("vfs-bytes");
	});

	it("surfaces a main-target network failure on the PUT", async () => {
		const src = join(tempDir, "src.txt");
		writeFileSync(src, "payload");
		globalThis.fetch = mock(async () => {
			throw new Error("put-econnrefused");
		}) as unknown as typeof fetch;
		const tool = createCopyTool({ hostname: HOSTNAME, boundUrl: BOUND_URL });
		const result = await tool(
			{ source: "satellite", source_path: src, target: "main", target_path: "/vfs/out.txt" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect((result.content[1] as { text: string }).text).toMatch(/request failed/i);
	});
});
