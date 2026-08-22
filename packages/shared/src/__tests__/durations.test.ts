import { describe, expect, it } from "bun:test";
import { modelBackendsSchema, platformsSchema, relaySchema, wsSchema } from "../config-schemas.js";
import {
	DurationParseError,
	durationMsSchema,
	formatIsoDurationMs,
	parseIsoDurationMs,
	toDurationMs,
} from "../durations.js";

// bound#149 was blocked on `Temporal` being absent from the Bun runtime
// (upstream oven-sh/bun#15853). Bun 1.4 ships it as a global, so this asserts
// the premise the rest of the file rests on rather than letting a regression
// here surface as a confusing parse failure downstream.
describe("Temporal availability", () => {
	it("exposes Temporal as a global", () => {
		expect(typeof Temporal).toBe("object");
		expect(Temporal.Duration.from("PT5M").total({ unit: "millisecond" })).toBe(300_000);
	});
});

describe("parseIsoDurationMs", () => {
	it("parses the calendar-free units", () => {
		expect(parseIsoDurationMs("PT30S")).toBe(30_000);
		expect(parseIsoDurationMs("PT5M")).toBe(300_000);
		expect(parseIsoDurationMs("PT1H")).toBe(3_600_000);
		expect(parseIsoDurationMs("PT1H30M")).toBe(5_400_000);
		expect(parseIsoDurationMs("PT0.5S")).toBe(500);
		expect(parseIsoDurationMs("PT0S")).toBe(0);
	});

	it("accepts hours large enough to span a day without a calendar", () => {
		expect(parseIsoDurationMs("PT24H")).toBe(86_400_000);
		expect(parseIsoDurationMs("PT48H")).toBe(172_800_000);
	});

	// A "day" is 23, 24, or 25 hours across a DST boundary, so Temporal refuses
	// to total() days-and-larger without a reference point. Rejecting is the
	// honest answer — silently assuming 24h would be a wrong timeout nobody
	// could see in the config file.
	it("rejects calendar-dependent units and names the offending field", () => {
		for (const [input, unit] of [
			["P1D", "days"],
			["P2W", "weeks"],
			["P1M", "months"],
			["P1Y", "years"],
		] as const) {
			const thrown = (() => {
				try {
					parseIsoDurationMs(input);
					return undefined;
				} catch (err) {
					return err;
				}
			})();
			expect(thrown, `${input} should be rejected`).toBeInstanceOf(DurationParseError);
			expect((thrown as DurationParseError).message).toContain(unit);
			expect((thrown as DurationParseError).message).toContain("calendar reference");
		}
	});

	it("suggests the hours spelling when rejecting days", () => {
		expect(() => parseIsoDurationMs("P1D")).toThrow(/PT24H/);
	});

	it("rejects negatives, garbage, and sub-millisecond precision", () => {
		expect(() => parseIsoDurationMs("PT-5M")).toThrow(DurationParseError);
		expect(() => parseIsoDurationMs("-PT5M")).toThrow(/must not be negative/);
		expect(() => parseIsoDurationMs("garbage")).toThrow(DurationParseError);
		expect(() => parseIsoDurationMs("")).toThrow(DurationParseError);
		expect(() => parseIsoDurationMs("PT0.0005S")).toThrow(/whole number of milliseconds/);
	});

	it("carries the offending input on the error for operator-facing messages", () => {
		try {
			parseIsoDurationMs("P1D");
			throw new Error("expected a throw");
		} catch (err) {
			expect(err).toBeInstanceOf(DurationParseError);
			expect((err as DurationParseError).input).toBe("P1D");
		}
	});
});

describe("formatIsoDurationMs", () => {
	it("round-trips through parseIsoDurationMs", () => {
		for (const ms of [0, 1, 500, 30_000, 300_000, 5_400_000, 86_400_000]) {
			expect(parseIsoDurationMs(formatIsoDurationMs(ms))).toBe(ms);
		}
	});

	it("renders the units an operator would recognize", () => {
		expect(formatIsoDurationMs(300_000)).toBe("PT5M");
		expect(formatIsoDurationMs(30_000)).toBe("PT30S");
		expect(formatIsoDurationMs(5_400_000)).toBe("PT1H30M");
	});
});

describe("toDurationMs", () => {
	it("passes numbers through untouched and parses strings", () => {
		expect(toDurationMs(20_000)).toBe(20_000);
		expect(toDurationMs("PT20S")).toBe(20_000);
	});
});

describe("durationMsSchema", () => {
	it("accepts both spellings and always outputs a number", () => {
		const schema = durationMsSchema();
		expect(schema.parse(30_000)).toBe(30_000);
		expect(schema.parse("PT30S")).toBe(30_000);
		expect(typeof schema.parse("PT5M")).toBe("number");
	});

	it("enforces the default 1ms floor", () => {
		const schema = durationMsSchema();
		expect(schema.safeParse(0).success).toBe(false);
		expect(schema.safeParse(-1).success).toBe(false);
		expect(schema.safeParse("PT0S").success).toBe(false);
		expect(schema.parse(1)).toBe(1);
	});

	it("allows the disabled sentinel when min is 0", () => {
		const schema = durationMsSchema({ min: 0 });
		expect(schema.parse(0)).toBe(0);
		expect(schema.parse("PT0S")).toBe(0);
		expect(schema.safeParse(-1).success).toBe(false);
	});

	it("surfaces the duration parse reason through the Zod issue", () => {
		const result = durationMsSchema().safeParse("P1D");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("calendar reference");
		}
	});

	it("rejects non-integer millisecond numbers", () => {
		expect(durationMsSchema().safeParse(1.5).success).toBe(false);
	});
});

// The point of the change: an operator can write "PT5M" in a config file and
// the loaded config still hands a plain number to consumers, so nothing
// downstream of the schema learns a new type.
describe("config schema integration", () => {
	it("keeps numeric millisecond defaults", () => {
		const relay = relaySchema.parse({});
		expect(relay.request_timeout_ms).toBe(30_000);
		expect(relay.inference_timeout_ms).toBe(300_000);

		const ws = wsSchema.parse({});
		expect(ws.receive_timeout_ms).toBe(300_000);
		expect(ws.handshake_timeout_ms).toBe(20_000);
	});

	it("accepts ISO durations for relay timeouts", () => {
		const relay = relaySchema.parse({
			request_timeout_ms: "PT45S",
			inference_timeout_ms: "PT10M",
		});
		expect(relay.request_timeout_ms).toBe(45_000);
		expect(relay.inference_timeout_ms).toBe(600_000);
	});

	it("accepts ISO durations for ws timeouts and keeps 0 disabled", () => {
		const ws = wsSchema.parse({
			receive_timeout_ms: 0,
			handshake_timeout_ms: "PT20S",
		});
		expect(ws.receive_timeout_ms).toBe(0);
		expect(ws.handshake_timeout_ms).toBe(20_000);
	});

	it("accepts an ISO failover threshold on a platform connector", () => {
		const platforms = platformsSchema.parse({
			connectors: [{ platform: "discord", failover_threshold_ms: "PT1M" }],
		});
		expect(platforms.connectors[0]?.failover_threshold_ms).toBe(60_000);
	});

	it("accepts an ISO per-backend connect timeout", () => {
		const parsed = modelBackendsSchema.parse({
			default: "b",
			backends: [
				{
					id: "b",
					provider: "openai-compatible",
					model: "llama3",
					base_url: "http://localhost:11434/v1",
					context_window: 8192,
					tier: 3,
					connect_timeout_ms: "PT2S",
				},
			],
		});
		expect(parsed.backends[0]?.connect_timeout_ms).toBe(2_000);
	});

	it("rejects a calendar duration in a config field with a usable message", () => {
		const result = relaySchema.safeParse({ inference_timeout_ms: "P1D" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("calendar reference");
		}
	});
});
