import { describe, expect, it } from "bun:test";
import type { KeyringConfig } from "@bound/shared";
import { findKeyringHubSiteId } from "../relay.js";

const key = "ed25519-public-key";

describe("findKeyringHubSiteId", () => {
	it("matches the hub when the keyring URL differs only by a trailing slash", () => {
		const keyring: KeyringConfig = {
			hosts: {
				"spoke-site": { public_key: key, url: "https://spoke.example.com" },
				"hub-site": { public_key: key, url: "https://hub.example.com/" },
			},
		};

		expect(findKeyringHubSiteId(keyring, "https://hub.example.com")).toBe("hub-site");
	});

	it("skips a malformed keyring URL without throwing", () => {
		const keyring: KeyringConfig = {
			hosts: {
				"broken-site": { public_key: key, url: "not a url" },
				"hub-site": { public_key: key, url: "https://hub.example.com" },
			},
		};

		expect(findKeyringHubSiteId(keyring, "https://hub.example.com/")).toBe("hub-site");
	});

	it("returns undefined when no keyring host matches the hub", () => {
		const keyring: KeyringConfig = {
			hosts: {
				"spoke-site": { public_key: key, url: "https://spoke.example.com" },
				"broken-site": { public_key: key, url: "::::" },
			},
		};

		expect(findKeyringHubSiteId(keyring, "https://hub.example.com")).toBeUndefined();
	});
});
