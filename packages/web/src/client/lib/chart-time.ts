// Time-bucket parsing for the metrics charts.
//
// The metrics route emits two bucket shapes:
//  - hourly: `2026-06-10T14:00:00Z` — a UTC instant (the Z is load-bearing:
//    without it `new Date()` parses the string as LOCAL time and every point
//    shifts by the viewer's tz offset). Legacy responses lack the Z; we
//    normalize them to UTC here so old data renders at the right instant.
//  - daily: `2026-06-10` — a calendar date, NOT an instant. `new Date()`
//    parses date-only strings as UTC midnight, so calling local getters like
//    `getDate()` on it shows the PREVIOUS day for any viewer west of UTC.
//    Daily labels must come from the raw string, never from local-time getters.

export interface BucketPoint {
	/** The raw bucket string from the API. */
	raw: string;
	/** Instant used for x-axis positioning (UTC midnight for daily buckets). */
	dateObj: Date;
	/** True when the bucket is a calendar date (no time component). */
	daily: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** Parse a metrics bucket string into a positioned, label-ready point. */
export function parseBucket(raw: string): BucketPoint {
	if (DATE_ONLY.test(raw)) {
		return { raw, dateObj: new Date(`${raw}T00:00:00Z`), daily: true };
	}
	// Hourly bucket. Buckets are derived from UTC-stored `created_at`, so a
	// missing zone suffix (legacy server) still means UTC.
	const iso = HAS_ZONE.test(raw) ? raw : `${raw}Z`;
	return { raw, dateObj: new Date(iso), daily: false };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Short axis label. Daily buckets render the calendar date from the raw
 * string (`M/D`); hourly buckets render the local hour (`HH:00`), or `M/D`
 * at local midnight so day boundaries are visible on the axis.
 */
export function formatBucketAxisLabel(p: BucketPoint): string {
	if (p.daily) {
		const [, month, day] = p.raw.split("-");
		return `${Number(month)}/${Number(day)}`;
	}
	const hour = p.dateObj.getHours();
	if (hour === 0) return `${p.dateObj.getMonth() + 1}/${p.dateObj.getDate()}`;
	return `${pad2(hour)}:00`;
}

/**
 * Full tooltip label. Daily buckets are the raw calendar date; hourly buckets
 * are the bucket start in the viewer's local time.
 */
export function formatBucketTooltipLabel(p: BucketPoint): string {
	if (p.daily) return p.raw;
	const d = p.dateObj;
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
