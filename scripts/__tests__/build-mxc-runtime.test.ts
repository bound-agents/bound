import { describe, expect, it } from "bun:test";
import { pickKoffiSubdir } from "../build-mxc-runtime";

describe("pickKoffiSubdir", () => {
	// Directory order from readdirSync is filesystem-dependent; ext4 on the
	// release runner listed musl_x64 first, which shipped a musl addon into a
	// glibc binary ("libc.musl-x86_64.so.1: cannot open shared object file").
	it("picks the glibc build on a glibc Linux host even when musl is listed first", () => {
		expect(pickKoffiSubdir(["musl_x64", "linux_x64"], "linux", "x64", false)).toBe("linux_x64");
		expect(pickKoffiSubdir(["musl_arm64", "linux_arm64"], "linux", "arm64", false)).toBe(
			"linux_arm64",
		);
	});

	it("picks the musl build on a musl Linux host", () => {
		expect(pickKoffiSubdir(["linux_x64", "musl_x64"], "linux", "x64", true)).toBe("musl_x64");
	});

	it("never falls back to a musl build on a glibc host", () => {
		expect(pickKoffiSubdir(["musl_x64"], "linux", "x64", false)).toBeUndefined();
	});

	it("picks the platform build on macOS", () => {
		expect(pickKoffiSubdir(["darwin_arm64"], "darwin", "arm64", false)).toBe("darwin_arm64");
	});

	it("accepts a single unexpectedly named candidate", () => {
		expect(pickKoffiSubdir(["darwin_universal"], "darwin", "arm64", false)).toBe(
			"darwin_universal",
		);
	});
});
