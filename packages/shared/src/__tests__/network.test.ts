import { describe, expect, it } from "bun:test";
import { isBlockedAddress } from "../network.js";

describe("isBlockedAddress", () => {
	it.each([
		["127.0.0.1", "IPv4 loopback"],
		["0.0.0.0", "IPv4 unspecified"],
		["10.0.0.1", "IPv4 private 10/8"],
		["172.16.0.1", "IPv4 private 172.16/12 lower bound"],
		["172.31.255.255", "IPv4 private 172.16/12 upper bound"],
		["192.168.1.1", "IPv4 private 192.168/16"],
		["169.254.169.254", "IPv4 link-local metadata"],
		["224.0.0.1", "IPv4 multicast"],
		["::1", "IPv6 loopback"],
		["::", "IPv6 unspecified"],
		["fe80::1", "IPv6 link-local"],
		["febf::1", "IPv6 link-local upper bound"],
		["fc00::1", "IPv6 unique local lower bound"],
		["fdff::1", "IPv6 unique local upper bound"],
		["ff02::1", "IPv6 multicast"],
		["::ffff:127.0.0.1", "IPv4-mapped IPv6 loopback"],
		["::ffff:169.254.169.254", "IPv4-mapped IPv6 metadata"],
		["::ffff:10.0.0.1", "IPv4-mapped IPv6 private"],
	])("rejects %s (%s)", (address) => {
		expect(isBlockedAddress(address)).toBe(true);
	});

	it.each([
		"8.8.8.8",
		"172.15.255.255",
		"172.32.0.0",
		"1.1.1.1",
		"2001:4860:4860::8888",
		"::ffff:8.8.8.8",
	])("allows public address %s", (address) => {
		expect(isBlockedAddress(address)).toBe(false);
	});
});
