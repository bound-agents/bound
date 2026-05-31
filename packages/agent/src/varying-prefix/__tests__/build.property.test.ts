/**
 * Property tests for `buildVaryingPrefix`.
 *
 * Properties:
 *
 *   V1 Determinism — same inputs produce byte-equal output.
 *   V2 First line — always `User ID: <userId>, Thread ID: <threadId>`.
 *   V3 Order — user/thread, relay, current model (any subset).
 *   V7 Optional fields absent -> their lines absent.
 *   V8 Newline absence — no embedded newlines in any single emitted line
 *      (split-on-"\n" must be lossless for downstream snapshot consumers).
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import { buildVaryingPrefix } from "../build";

const idArb = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => !/[\n\r]/.test(s));
const hostArb = fc.string({ minLength: 1, maxLength: 16 }).filter((s) => !/[\n\r]/.test(s));
const modelArb = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => !/[\n\r]/.test(s));

const relayArb = fc.record({
	remoteHost: hostArb,
	localHost: hostArb,
	model: modelArb,
	provider: hostArb,
});

const fullArb = fc.record({
	userId: idArb,
	threadId: idArb,
	relayInfo: fc.option(relayArb, { nil: undefined }),
	currentModel: fc.option(modelArb, { nil: undefined }),
});

describe("buildVaryingPrefix — property tests", () => {
	it("V1: determinism — same inputs produce byte-equal output", () => {
		fc.assert(
			fc.property(fullArb, (params) => {
				const a = buildVaryingPrefix(params).join("\n");
				const b = buildVaryingPrefix(params).join("\n");
				return a === b;
			}),
			{ numRuns: 100 },
		);
	});

	it("V2: first line is always `User ID: ..., Thread ID: ...`", () => {
		fc.assert(
			fc.property(fullArb, (params) => {
				const out = buildVaryingPrefix(params);
				return out[0] === `User ID: ${params.userId}, Thread ID: ${params.threadId}`;
			}),
			{ numRuns: 100 },
		);
	});

	it("V3: order — user/thread before relay before currentModel", () => {
		fc.assert(
			fc.property(fullArb, (params) => {
				const out = buildVaryingPrefix(params);
				const userIdx = 0;
				const relayIdx = params.relayInfo ? out.findIndex((l) => l.startsWith("You are: ")) : -1;
				const modelIdx = params.currentModel
					? out.findIndex((l) => l.startsWith("Current Model: "))
					: -1;

				if (relayIdx !== -1 && relayIdx <= userIdx) return false;
				if (modelIdx !== -1 && relayIdx !== -1 && modelIdx <= relayIdx) return false;
				return true;
			}),
			{ numRuns: 100 },
		);
	});

	it("V7: optional fields absent -> their lines absent", () => {
		const out = buildVaryingPrefix({ userId: "u", threadId: "t" });
		if (out.length !== 1) throw new Error(`expected exactly 1 line, got ${out.length}`);
		if (out[0] !== "User ID: u, Thread ID: t") throw new Error(`unexpected line: ${out[0]}`);
	});

	it("V7b: relay-only adds exactly one line; model-only adds one line", () => {
		const relayOnly = buildVaryingPrefix({
			userId: "u",
			threadId: "t",
			relayInfo: { remoteHost: "rh", localHost: "lh", model: "m", provider: "p" },
		});
		if (relayOnly.length !== 2) throw new Error(`relayOnly: ${relayOnly.length}`);

		const modelOnly = buildVaryingPrefix({ userId: "u", threadId: "t", currentModel: "claude" });
		if (modelOnly.length !== 2) throw new Error(`modelOnly: ${modelOnly.length}`);
		if (modelOnly[1] !== "Current Model: claude") {
			throw new Error(`modelOnly[1]: ${modelOnly[1]}`);
		}
	});

	it("V8: no emitted line contains an embedded newline", () => {
		fc.assert(
			fc.property(fullArb, (params) => {
				const out = buildVaryingPrefix(params);
				for (const line of out) {
					if (line.includes("\n") || line.includes("\r")) return false;
				}
				return true;
			}),
			{ numRuns: 100 },
		);
	});
});
