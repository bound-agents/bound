/// <reference lib="esnext.temporal" />
import { z } from "zod";
/**
 * Duration parsing for operator-authored config.
 *
 * Timeouts and intervals in `config-schemas.ts` were raw millisecond numbers:
 * `inference_timeout_ms: 300000` reads as five minutes only if you divide in
 * your head, and `1800000` is a bug waiting to be misread by an order of
 * magnitude. `Temporal.Duration` parses ISO 8601 durations, so the same field
 * accepts `"PT5M"` — self-describing, and validated by the runtime rather than
 * by a comment.
 *
 * `Temporal` was unavailable as a Bun global until 1.4 (bound#149, upstream
 * oven-sh/bun#15853), which is why these fields were numbers in the first
 * place. Bun 1.4 ships it, so the helpers below can rely on the global with no
 * polyfill.
 *
 * Numbers stay valid everywhere a duration is accepted. Every existing config
 * keeps parsing, and the field's canonical form remains milliseconds — the
 * string is a spelling of the number, not a competing representation, so
 * nothing downstream has to learn a new type.
 */

/**
 * Milliseconds in each calendar-independent unit. Deliberately stops at hours:
 * `Temporal.Duration.total()` refuses to convert days and larger without a
 * reference point (a "day" is 23, 24, or 25 hours across a DST boundary), and a
 * config timeout has no calendar anchor to offer. A duration carrying days or
 * above is rejected rather than silently assumed to be 24-hour days.
 */
const CALENDAR_FREE_UNITS = ["hours", "minutes", "seconds", "milliseconds"] as const;

/** Fields whose presence means the duration needs a calendar to resolve. */
const CALENDAR_DEPENDENT_FIELDS = ["years", "months", "weeks", "days"] as const;

export class DurationParseError extends Error {
	constructor(
		readonly input: string,
		reason: string,
	) {
		super(`invalid duration ${JSON.stringify(input)}: ${reason}`);
		this.name = "DurationParseError";
	}
}

/**
 * Parse an ISO 8601 duration string to whole milliseconds.
 *
 * Accepts the calendar-free subset (`PT30S`, `PT5M`, `PT1H30M`, `PT0.5S`).
 * Rejects calendar-dependent durations (`P1D`, `P2W`, `P1M`) because resolving
 * them requires a reference date the config layer does not have, and rejects
 * negative durations because every consumer here is a timeout or interval.
 */
export function parseIsoDurationMs(input: string): number {
	let duration: Temporal.Duration;
	try {
		duration = Temporal.Duration.from(input);
	} catch (err) {
		throw new DurationParseError(input, err instanceof Error ? err.message : String(err));
	}

	const calendarField = CALENDAR_DEPENDENT_FIELDS.find((field) => duration[field] !== 0);
	if (calendarField !== undefined) {
		throw new DurationParseError(
			input,
			`${calendarField} require a calendar reference to convert; use hours or smaller (e.g. "PT24H" rather than "P1D")`,
		);
	}

	if (duration.sign < 0) {
		throw new DurationParseError(input, "must not be negative");
	}

	const total = duration.total({ unit: "millisecond" });
	if (!Number.isInteger(total)) {
		throw new DurationParseError(input, "must be a whole number of milliseconds");
	}
	return total;
}

/**
 * Render milliseconds as an ISO 8601 duration, for surfacing a numeric default
 * back to an operator in the vocabulary they'd write it in.
 */
export function formatIsoDurationMs(ms: number): string {
	return Temporal.Duration.from({ milliseconds: ms })
		.round({ largestUnit: "hour", smallestUnit: "millisecond" })
		.toString();
}

/**
 * Normalize a config duration to milliseconds. Numbers pass through; strings go
 * through {@link parseIsoDurationMs}.
 */
export function toDurationMs(value: number | string): number {
	return typeof value === "number" ? value : parseIsoDurationMs(value);
}

/** The units `parseIsoDurationMs` can convert without a calendar reference. */
export const DURATION_UNITS = CALENDAR_FREE_UNITS;

/**
 * Zod schema for a config duration, in milliseconds.
 *
 * Accepts a raw millisecond number (every pre-existing config keeps parsing) or
 * an ISO 8601 duration string, and always *outputs* a number — so consumers
 * receive the same `number` they did before and no downstream code changes.
 *
 * @param options.min Floor for the resolved value. `0` allows the
 * disabled-sentinel some fields use; the default of `1` rejects it.
 */
export function durationMsSchema(options: { min?: number } = {}) {
	const min = options.min ?? 1;
	return z.union([z.number(), z.string().min(1)]).transform((value, ctx) => {
		let ms: number;
		if (typeof value === "number") {
			ms = value;
		} else {
			try {
				ms = parseIsoDurationMs(value);
			} catch (err) {
				ctx.addIssue({
					code: "custom",
					message: err instanceof DurationParseError ? err.message : String(err),
				});
				return z.NEVER;
			}
		}
		if (!Number.isInteger(ms)) {
			ctx.addIssue({ code: "custom", message: "duration must be a whole number of milliseconds" });
			return z.NEVER;
		}
		if (ms < min) {
			ctx.addIssue({
				code: "custom",
				message: `duration must be >= ${min}ms (got ${ms}ms${
					typeof value === "string" ? ` from ${JSON.stringify(value)}` : ""
				})`,
			});
			return z.NEVER;
		}
		return ms;
	});
}
