import { describe, expect, it } from "bun:test";
import { attachedSessionHosts, attachedSessionLabel, attachedSessionTitle } from "../session-badge";

describe("session badge", () => {
	it("reads hosts defensively", () => {
		expect(attachedSessionHosts({ attachedSessionHosts: ["a"] })).toEqual(["a"]);
		expect(attachedSessionHosts({ attachedSessionHosts: "a" })).toEqual([]);
		expect(attachedSessionHosts(null)).toEqual([]);
	});

	it("labels one host by name and more by count", () => {
		expect(attachedSessionLabel([])).toBe("");
		expect(attachedSessionLabel(["MSI"])).toBe("MSI");
		expect(attachedSessionLabel(["MSI", "mac", "vm"])).toBe("MSI +2");
	});

	it("pluralizes the title", () => {
		expect(attachedSessionTitle(["MSI"])).toBe("Attached session on MSI");
		expect(attachedSessionTitle(["MSI", "mac"])).toBe("Attached sessions on MSI, mac");
	});
});
