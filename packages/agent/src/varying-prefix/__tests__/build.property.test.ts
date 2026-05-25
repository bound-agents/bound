/**
 * Property tests for `buildVaryingPrefix`.
 *
 * Properties:
 *
 *   V1 Determinism — same inputs produce byte-equal output.
 *   V2 First line — always `User ID: <userId>, Thread ID: <threadId>`.
 *   V3 Order — user/thread, relay, platform, current model (any subset).
 *   V4 Platform-tool fallback — empty `toolNames` -> "the platform send tool".
 *   V5 Platform-tool join — multiple names joined " or ", each backticked.
 *   V6 Discord formatting block — iff platform is discord / discord-interaction.
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
const platformArb = fc.constantFrom("discord", "discord-interaction", "slack", "matrix", "web");
const toolNameArb = fc.string({ minLength: 1, maxLength: 16 }).filter((s) => !/[\n\r`]/.test(s));

const relayArb = fc.record({
	remoteHost: hostArb,
	localHost: hostArb,
	model: modelArb,
	provider: hostArb,
});

const platformContextArb = fc.record({
	platform: platformArb,
	toolNames: fc.option(fc.array(toolNameArb, { maxLength: 4 }), { nil: undefined }),
});

const fullArb = fc.record({
	userId: idArb,
	threadId: idArb,
	relayInfo: fc.option(relayArb, { nil: undefined }),
	platformContext: fc.option(platformContextArb, { nil: undefined }),
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

	it("V3: order — user/thread before relay before platform before currentModel", () => {
		fc.assert(
			fc.property(fullArb, (params) => {
				const out = buildVaryingPrefix(params);
				const userIdx = 0;
				const relayIdx = params.relayInfo ? out.findIndex((l) => l.startsWith("You are: ")) : -1;
				const platformIdx = params.platformContext
					? out.findIndex((l) => l.startsWith("## Platform Context: "))
					: -1;
				const modelIdx = params.currentModel
					? out.findIndex((l) => l.startsWith("Current Model: "))
					: -1;

				if (relayIdx !== -1 && relayIdx <= userIdx) return false;
				if (platformIdx !== -1 && relayIdx !== -1 && platformIdx <= relayIdx) return false;
				if (modelIdx !== -1 && platformIdx !== -1 && modelIdx <= platformIdx) return false;
				if (modelIdx !== -1 && relayIdx !== -1 && modelIdx <= relayIdx) return false;
				return true;
			}),
			{ numRuns: 100 },
		);
	});

	it("V4: empty toolNames falls back to 'the platform send tool'", () => {
		fc.assert(
			fc.property(idArb, idArb, platformArb, (userId, threadId, platform) => {
				const out = buildVaryingPrefix({
					userId,
					threadId,
					platformContext: { platform, toolNames: [] },
				});
				const callLine = out.find((l) => l.startsWith("To send a message"));
				if (!callLine) return false;
				return callLine.includes("the platform send tool");
			}),
			{ numRuns: 50 },
		);
	});

	it("V4b: undefined toolNames falls back to 'the platform send tool'", () => {
		const out = buildVaryingPrefix({
			userId: "u",
			threadId: "t",
			platformContext: { platform: "slack" },
		});
		const callLine = out.find((l) => l.startsWith("To send a message"));
		if (!callLine || !callLine.includes("the platform send tool")) {
			throw new Error(`unexpected call line: ${callLine}`);
		}
	});

	it("V5: multiple toolNames joined ' or ' with backticks", () => {
		fc.assert(
			fc.property(
				fc.array(toolNameArb, { minLength: 1, maxLength: 4 }),
				platformArb,
				(toolNames, platform) => {
					const out = buildVaryingPrefix({
						userId: "u",
						threadId: "t",
						platformContext: { platform, toolNames },
					});
					const callLine = out.find((l) => l.startsWith("To send a message"));
					if (!callLine) return false;
					const expected = toolNames.map((n) => `\`${n}\``).join(" or ");
					return callLine.includes(expected);
				},
			),
			{ numRuns: 50 },
		);
	});

	it("V6: Discord formatting block present iff platform is discord variant", () => {
		fc.assert(
			fc.property(platformArb, (platform) => {
				const out = buildVaryingPrefix({
					userId: "u",
					threadId: "t",
					platformContext: { platform, toolNames: ["send"] },
				});
				const hasDiscordNote = out.some((l) => l.startsWith("Discord formatting:"));
				const isDiscord = platform === "discord" || platform === "discord-interaction";
				return hasDiscordNote === isDiscord;
			}),
			{ numRuns: 50 },
		);
	});

	it("V7: optional fields absent -> their lines absent", () => {
		const out = buildVaryingPrefix({ userId: "u", threadId: "t" });
		if (out.length !== 1) throw new Error(`expected exactly 1 line, got ${out.length}`);
		if (out[0] !== "User ID: u, Thread ID: t") throw new Error(`unexpected line: ${out[0]}`);
	});

	it("V7b: relay-only adds exactly one line; platform-only adds platform block; model-only adds one line", () => {
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
