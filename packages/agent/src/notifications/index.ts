/**
 * Operator-feedback notifications — the `[Skill notification]` and
 * `[Advisory notification]` lines surfaced into the volatile-tail
 * varying half so the agent learns when an operator retired a skill
 * or resolved one of its advisories within the last 24 h.
 *
 * Properties pinned by `__tests__/render.property.test.ts`:
 *
 *   F1 Determinism — same inputs produce byte-equal output.
 *   F2 Cap — at most ADVISORY_NOTIF_CAP advisory lines emitted.
 *   F3 Dedup — duplicate titles collapse to one line; counts >1 carry "(×N)".
 *   F4 Empty inputs → empty output.
 *   F5 Skill retirement is uncapped.
 *   F6 Line-shape — each line begins with the expected tag prefix.
 *   F7 Order preservation — input order drives output order.
 */

export {
	renderNotifications,
	ADVISORY_NOTIF_CAP,
	type RenderNotificationsParams,
	type RetiredSkillRow,
	type ResolvedAdvisoryRow,
} from "./render";
export { loadNotificationInputs, type NotificationInputs } from "./load";
