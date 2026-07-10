/**
 * Platform-native command contract.
 *
 * Connectors (Discord, etc.) translate these specs into their platform's
 * native command surface (Discord application commands) and route matching
 * invocations to the injected handler DETERMINISTICALLY — no agent loop, no
 * inference. That property is the whole point: the canonical consumer is
 * `/model`, which a user reaches for precisely when the current model cannot
 * complete an agent turn. A command that needs inference to execute cannot
 * fix a broken model.
 *
 * Dependency direction mirrors the DiscordClientFactory pattern: the
 * connector knows the command SHAPE (name/options) but nothing about what the
 * handler does; the wiring layer (packages/cli) supplies handlers that know
 * models/tasks/threads but nothing about Discord. Neither side imports the
 * other's domain.
 */

/** One option (argument) on a platform command. */
export interface PlatformCommandOption {
	/** Option name as the platform surfaces it (e.g. Discord option name). */
	name: string;
	/** Human-readable description shown in the platform's command UI. */
	description: string;
	/** Whether the platform should require the option before submit. */
	required: boolean;
}

/**
 * A command invocation, normalized away from any platform's interaction
 * shape. This is everything a handler may know about where the command came
 * from — deliberately platform-neutral so handlers stay portable across
 * connectors.
 */
export interface PlatformCommandInvocation {
	/** Registered command name that matched. */
	command: string;
	/** Parsed option values keyed by option name. */
	options: Record<string, unknown>;
	/** Platform channel the command was issued in. */
	channel_id: string;
	/** Platform user id of the issuer. */
	user_id: string;
	/** Connector server name (e.g. "discord") — set by the registry/wiring. */
	server_name: string;
}

/**
 * Handler outcome is the reply text shown to the user (ephemerally where the
 * platform supports it). Throwing surfaces the error message as the reply,
 * prefixed with "Error:" — handlers should throw for invalid input rather
 * than encode failure in the string.
 */
export type PlatformCommandHandler = (invocation: PlatformCommandInvocation) => Promise<string>;

/** Spec for one platform command a connector should register and route. */
export interface PlatformCommandSpec {
	/** Command name (platform-lowercase conventions apply, e.g. "model"). */
	name: string;
	/** Description shown in the platform's command picker. */
	description: string;
	/** Options/arguments the command takes. */
	options: PlatformCommandOption[];
	/**
	 * When true, only users in the connector's `allowed_users` allowlist may
	 * invoke the command; others get a refusal reply and the handler is never
	 * called. Commands that mutate agent state (like /model) must be
	 * restricted; an empty allowlist restricts to nobody-but-everyone (i.e.
	 * no gate) to match the connector's DM gating semantics.
	 */
	restricted: boolean;
	/** The injected domain logic. */
	handler: PlatformCommandHandler;
}
