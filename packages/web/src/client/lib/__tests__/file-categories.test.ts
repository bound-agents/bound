import { describe, expect, it } from "bun:test";
import { extensionToLanguage, getFileCategory } from "../file-categories";

describe("getFileCategory", () => {
	it("detects TypeScript as code", () => {
		expect(getFileCategory("index.ts", 0)).toBe("code");
	});

	it("detects markdown", () => {
		expect(getFileCategory("readme.md", 0)).toBe("markdown");
	});

	it("detects PNG as image", () => {
		expect(getFileCategory("photo.png", 0)).toBe("image");
	});

	it("detects plain text", () => {
		expect(getFileCategory("notes.txt", 0)).toBe("text");
	});

	it("treats unknown non-binary as text", () => {
		expect(getFileCategory("data.xyz", 0)).toBe("text");
	});

	it("treats unknown binary as binary", () => {
		expect(getFileCategory("data.bin", 1)).toBe("binary");
	});

	it("treats binary non-image as binary", () => {
		expect(getFileCategory("archive.zip", 1)).toBe("binary");
	});

	it("handles files without extension", () => {
		expect(getFileCategory("Makefile", 0)).toBe("text");
	});
});

describe("extensionToLanguage", () => {
	it("maps .ts to typescript", () => {
		expect(extensionToLanguage(".ts")).toBe("typescript");
	});

	it("maps .py to python", () => {
		expect(extensionToLanguage(".py")).toBe("python");
	});

	it("maps .sh to bash", () => {
		expect(extensionToLanguage(".sh")).toBe("bash");
	});

	it("returns null for unknown", () => {
		expect(extensionToLanguage(".xyz")).toBeNull();
	});

	it("returns null for non-code", () => {
		expect(extensionToLanguage(".png")).toBeNull();
	});
});
