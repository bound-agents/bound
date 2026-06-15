// Behavioral test for the js-exec process.stdout/stderr guest stream.
//
// The createSandbox+bun-test path cannot link the js-exec worker as a Worker
// (pre-existing "Export named 'stripTypeScriptTypes' not found" load failure,
// orthogonal to this graft), so end-to-end js-exec execution is verified via
// the agent's own just-bash sandbox after a rebuild — the same way the stdin
// fix was. What we CAN pin here without the WASM stack is the guest stream's
// behavior: __mkWritable is pure JS. We extract the REAL function source from
// the materialized worker (not a copy) and exercise it, so this test fails if
// the shipped stream semantics ever drift.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Anchored on this test file's own directory (scripts/), so it resolves the
// same whether bun runs it by name or by path.
const workerPath = join(import.meta.dir, "..", "packages/sandbox/src/_runtime/worker-js-exec.js");
const workerSrc = readFileSync(workerPath, "utf8");

// Slice the real __mkWritable declaration out of the materialized guest shim:
// from its `function` keyword up to the first `_p.stdout =` line that uses it.
function extractMkWritable(): (
	hostWrite: (s: string) => void,
	fd: number,
) => Record<string, unknown> {
	const start = workerSrc.indexOf("function __mkWritable(");
	const end = workerSrc.indexOf("_p.stdout = __mkWritable", start);
	if (start < 0 || end < 0) {
		throw new Error(
			"could not locate __mkWritable in the materialized js-exec worker — stdout graft missing or drifted",
		);
	}
	const decl = workerSrc.slice(start, end);
	// Realize the declaration and hand the function back.
	return new Function(`${decl}; return __mkWritable;`)() as (
		hostWrite: (s: string) => void,
		fd: number,
	) => Record<string, unknown>;
}

const mkWritable = extractMkWritable();

function sink() {
	const chunks: string[] = [];
	return { chunks, write: (s: string) => chunks.push(s) };
}

describe("js-exec process.stdout/stderr guest stream (real shipped __mkWritable)", () => {
	test("write() emits the chunk verbatim with NO trailing newline", () => {
		const s = sink();
		const stream = mkWritable(s.write, 1) as { write: (c: unknown) => boolean };
		stream.write("a");
		stream.write("b");
		stream.write("c");
		expect(s.chunks.join("")).toBe("abc");
		expect(s.chunks).toEqual(["a", "b", "c"]);
	});

	test("write() returns true (never backpressured — host write is synchronous)", () => {
		const s = sink();
		const stream = mkWritable(s.write, 1) as { write: (c: unknown) => boolean };
		expect(stream.write("x")).toBe(true);
	});

	test("a Buffer/typed chunk is decoded to its string bytes", () => {
		const s = sink();
		const stream = mkWritable(s.write, 1) as { write: (c: unknown, e?: string) => boolean };
		stream.write(Buffer.from("héllo", "utf8"));
		expect(s.chunks.join("")).toBe("héllo");
	});

	test("write(str, cb) and write(str, enc, cb) both fire the callback (async)", async () => {
		const s = sink();
		const stream = mkWritable(s.write, 1) as {
			write: (c: unknown, e?: unknown, cb?: unknown) => boolean;
		};
		let n = 0;
		stream.write("x", () => {
			n++;
		});
		stream.write("y", "utf8", () => {
			n++;
		});
		expect(s.chunks.join("")).toBe("xy"); // writes are synchronous
		expect(n).toBe(0); // callbacks deferred to a microtask
		await Promise.resolve();
		await Promise.resolve();
		expect(n).toBe(2);
	});

	test("end(chunk) flushes the final chunk and returns the stream", () => {
		const s = sink();
		const stream = mkWritable(s.write, 1) as {
			write: (c: unknown) => boolean;
			end: (c?: unknown) => unknown;
		};
		stream.write("start");
		const ret = stream.end("-end");
		expect(s.chunks.join("")).toBe("start-end");
		expect(ret).toBe(stream);
	});

	test("end() with no chunk writes nothing and end(cb) fires the callback", async () => {
		const s = sink();
		const stream = mkWritable(s.write, 1) as { end: (c?: unknown) => unknown };
		let called = false;
		stream.end(() => {
			called = true;
		});
		expect(s.chunks.join("")).toBe("");
		await Promise.resolve();
		await Promise.resolve();
		expect(called).toBe(true);
	});

	test("non-TTY pipe shape: fd, writable, isTTY", () => {
		const out = mkWritable(() => {}, 1) as { fd: number; writable: boolean; isTTY: boolean };
		const err = mkWritable(() => {}, 2) as { fd: number };
		expect(out.fd).toBe(1);
		expect(err.fd).toBe(2);
		expect(out.writable).toBe(true);
		expect(out.isTTY).toBe(false);
	});

	test("event no-ops are chainable and never throw (libraries that .on('drain'))", () => {
		const stream = mkWritable(() => {}, 1) as Record<string, (...a: unknown[]) => unknown>;
		expect(() => {
			const r = stream.on("drain", () => {});
			expect(r).toBe(stream);
			stream.once("error", () => {});
			stream.cork();
			stream.uncork();
			expect(stream.emit("drain")).toBe(false);
		}).not.toThrow();
	});

	test("missing host writer (undefined) does not throw — write is a safe no-op", () => {
		// Defensive: if the global writer is somehow absent, write() must not crash.
		const stream = mkWritable(undefined as unknown as (s: string) => void, 1) as {
			write: (c: unknown) => boolean;
		};
		expect(() => stream.write("data")).not.toThrow();
		expect(stream.write("data")).toBe(true);
	});
});
