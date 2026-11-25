/**
 * Sender identity for a `role: "user"` message, shared by the web UI and the
 * boundless TUI so both surfaces label the same row the same way (#258).
 *
 * A user-role row is not always the operator: in an auxiliary thread the main
 * agent writes its errand as a user-role message stamped `sender_role: "main"`
 * (the #201 sender-envelope role axis). Operator messages carry the display name
 * the intake site froze at send time in `user_name`; rows written before that
 * stamp existed fall back to the thread owner's `users.display_name`.
 */
export type UserMessageSender =
	/** The main agent speaking into an auxiliary conversation. */
	| { kind: "agent"; name: string }
	/** An operator. `name` is null when no identity is known — the surface shows its own default. */
	| { kind: "user"; name: string | null };

export interface ResolveUserMessageSenderInput {
	/** The message row's metadata bag: JSON text (DB/API form) or an already-parsed object. */
	metadata: string | Record<string, unknown> | null | undefined;
	/** The thread owner's `users.display_name`, used when the row carries no `user_name`. */
	userDisplayName?: string | null;
	/** The main agent's name, when the surface knows one. Defaults to `"agent"`. */
	agentName?: string | null;
}

export const DEFAULT_AGENT_SENDER_NAME = "agent";

function parseMetadata(
	metadata: ResolveUserMessageSenderInput["metadata"],
): Record<string, unknown> | null {
	if (!metadata) return null;
	if (typeof metadata === "object") return metadata;
	try {
		const parsed: unknown = JSON.parse(metadata);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function nonEmpty(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveUserMessageSender(input: ResolveUserMessageSenderInput): UserMessageSender {
	const bag = parseMetadata(input.metadata);
	if (bag?.sender_role === "main") {
		return { kind: "agent", name: nonEmpty(input.agentName) ?? DEFAULT_AGENT_SENDER_NAME };
	}
	return { kind: "user", name: nonEmpty(bag?.user_name) ?? nonEmpty(input.userDisplayName) };
}
