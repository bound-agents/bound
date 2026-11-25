import { describe, expect, it } from "bun:test";
import { resolveUserMessageSender } from "../message-sender";

describe("resolveUserMessageSender", () => {
	it("uses the user_name stamped on the message metadata", () => {
		expect(
			resolveUserMessageSender({
				metadata: JSON.stringify({ user_id: "u1", user_name: "Kara" }),
				userDisplayName: "Someone Else",
			}),
		).toEqual({ kind: "user", name: "Kara" });
	});

	it("accepts an already-parsed metadata object", () => {
		expect(resolveUserMessageSender({ metadata: { user_name: "Kara" } })).toEqual({
			kind: "user",
			name: "Kara",
		});
	});

	it("falls back to the users-table display name when metadata carries no user_name", () => {
		expect(resolveUserMessageSender({ metadata: null, userDisplayName: "Kara" })).toEqual({
			kind: "user",
			name: "Kara",
		});
		expect(
			resolveUserMessageSender({ metadata: '{"tz_offset":-480}', userDisplayName: "Kara" }),
		).toEqual({ kind: "user", name: "Kara" });
	});

	it("returns a null user name when no identity is known", () => {
		expect(resolveUserMessageSender({ metadata: undefined })).toEqual({ kind: "user", name: null });
		expect(resolveUserMessageSender({ metadata: "not json", userDisplayName: "" })).toEqual({
			kind: "user",
			name: null,
		});
	});

	it("labels a main-agent message (sender_role=main) as the agent, not the operator", () => {
		expect(
			resolveUserMessageSender({
				metadata: JSON.stringify({ sender_role: "main" }),
				userDisplayName: "Kara",
			}),
		).toEqual({ kind: "agent", name: "agent" });
	});

	it("uses the agent's name for a main-agent message when one is available", () => {
		expect(
			resolveUserMessageSender({
				metadata: JSON.stringify({ sender_role: "main" }),
				agentName: "polaris",
			}),
		).toEqual({ kind: "agent", name: "polaris" });
	});

	it("treats sender_role=user as an operator message", () => {
		expect(
			resolveUserMessageSender({
				metadata: JSON.stringify({ sender_role: "user", user_name: "Kara" }),
			}),
		).toEqual({ kind: "user", name: "Kara" });
	});
});
