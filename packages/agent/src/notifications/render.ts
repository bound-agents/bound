/**
 * Operator-feedback notification renderer.
 *
 * Pure function over `(retiredSkills, resolvedAdvisories)` that produces
 * the `[Skill notification]` / `[Advisory notification]` lines emitted
 * into the volatile-tail varying half of the assembled context.
 *
 * Contract pinned by `__tests__/render.property.test.ts`:
 *
 *   F1 Determinism — same inputs produce byte-equal output.
 *   F2 Cap — at most ADVISORY_NOTIF_CAP advisory lines emitted.
 *   F3 Dedup — duplicate titles collapse to one line; counts >1 carry "(×N)".
 *   F4 Empty inputs → empty output.
 *   F5 Skill retirement is uncapped (operator action, all should surface).
 *   F6 Line-shape — each line begins with the expected tag prefix.
 *   F7 Order preservation — input order drives output order.
 *
 * The DB-loading wrapper lives in `load.ts`; this module never touches
 * SQL or wall-clock time, so it is trivially testable.
 */

/** Advisory dedup cap — limits *distinct titles* emitted, not summed counts. */
export const ADVISORY_NOTIF_CAP = 5;

export interface RetiredSkillRow {
	name: string;
	retired_reason: string | null;
}

export interface ResolvedAdvisoryRow {
	title: string;
	status: string;
}

export interface RenderNotificationsParams {
	retiredSkills: ReadonlyArray<RetiredSkillRow>;
	resolvedAdvisories: ReadonlyArray<ResolvedAdvisoryRow>;
}

/**
 * Produces a flat list of notification lines.
 *
 * The caller is responsible for splicing blank-line separators between
 * the returned lines and surrounding content; `renderNotifications`
 * itself returns no leading or trailing blanks so the function is a
 * pure projection of its inputs.
 */
export function renderNotifications(params: RenderNotificationsParams): string[] {
	const lines: string[] = [];

	for (const s of params.retiredSkills) {
		const reason = s.retired_reason ? `"${s.retired_reason}"` : "no reason given";
		lines.push(`[Skill notification] Skill '${s.name}' was retired by operator: ${reason}.`);
	}

	const titleGroups = new Map<string, { status: string; count: number }>();
	for (const adv of params.resolvedAdvisories) {
		const existing = titleGroups.get(adv.title);
		if (existing) {
			existing.count++;
		} else {
			titleGroups.set(adv.title, { status: adv.status, count: 1 });
		}
	}

	let notifCount = 0;
	for (const [title, { status, count }] of titleGroups) {
		if (notifCount >= ADVISORY_NOTIF_CAP) break;
		const countStr = count > 1 ? ` (×${count})` : "";
		lines.push(`[Advisory notification] Advisory '${title}' was ${status} by operator${countStr}.`);
		notifCount++;
	}

	return lines;
}
