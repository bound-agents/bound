import { describe, expect, it } from "bun:test";
import { getLangConfig, tokenize } from "../tui/components/syntax";

/** Helper: tokenize and return flat (kind, text) pairs for easy assertions. */
function lex(code: string, langTag: string): Array<[string, string]> {
	const cfg = getLangConfig(langTag);
	if (!cfg) throw new Error(`unknown lang: ${langTag}`);
	return tokenize(code, cfg).map((t) => [t.kind, t.text]);
}

/** Helper: round-trip — joined token text must equal the original input. */
function roundtrip(code: string, langTag: string): boolean {
	const cfg = getLangConfig(langTag);
	if (!cfg) throw new Error(`unknown lang: ${langTag}`);
	const tokens = tokenize(code, cfg);
	return tokens.map((t) => t.text).join("") === code;
}

describe("getLangConfig", () => {
	it("resolves common lang tag aliases", () => {
		expect(getLangConfig("ts")).not.toBeNull();
		expect(getLangConfig("typescript")).not.toBeNull();
		expect(getLangConfig("tsx")).toBe(getLangConfig("ts"));
		expect(getLangConfig("javascript")).toBe(getLangConfig("js"));
		expect(getLangConfig("python")).toBe(getLangConfig("py"));
		expect(getLangConfig("bash")).toBe(getLangConfig("sh"));
		expect(getLangConfig("rust")).toBe(getLangConfig("rs"));
		expect(getLangConfig("golang")).toBe(getLangConfig("go"));
		expect(getLangConfig("yml")).toBe(getLangConfig("yaml"));
	});

	it("is case-insensitive on the lang tag", () => {
		expect(getLangConfig("TS")).toBe(getLangConfig("ts"));
		expect(getLangConfig("Python")).toBe(getLangConfig("python"));
	});

	it("returns null for unknown or missing langs", () => {
		expect(getLangConfig(undefined)).toBeNull();
		expect(getLangConfig(null)).toBeNull();
		expect(getLangConfig("")).toBeNull();
		expect(getLangConfig("brainfuck")).toBeNull();
	});
});

describe("tokenize / TypeScript", () => {
	it("classifies keywords, types, strings, and numbers", () => {
		const tokens = lex("const x: number = 42;", "ts");
		// We don't enumerate every whitespace token — just check the content tokens.
		const content = tokens.filter(([k]) => k !== "ws");
		expect(content).toContainEqual(["keyword", "const"]);
		expect(content).toContainEqual(["ident", "x"]);
		expect(content).toContainEqual(["punct", ":"]);
		expect(content).toContainEqual(["type", "number"]);
		expect(content).toContainEqual(["punct", "="]);
		expect(content).toContainEqual(["number", "42"]);
		expect(content).toContainEqual(["punct", ";"]);
	});

	it("captures double-quoted, single-quoted, and template strings", () => {
		expect(lex(`"hi"`, "ts")).toEqual([["string", `"hi"`]]);
		expect(lex(`'hi'`, "ts")).toEqual([["string", `'hi'`]]);
		expect(lex("`hi`", "ts")).toEqual([["string", "`hi`"]]);
	});

	it("respects backslash escapes inside strings", () => {
		expect(lex(`"a\\"b"`, "ts")).toEqual([["string", `"a\\"b"`]]);
	});

	it("captures line and block comments", () => {
		expect(lex("// hi\n", "ts")).toEqual([
			["comment", "// hi"],
			["ws", "\n"],
		]);
		expect(lex("/* a\nb */", "ts")).toEqual([["comment", "/* a\nb */"]]);
	});

	it("classifies builtin literals true/false/null/undefined as builtins", () => {
		const tokens = lex("true false null undefined", "ts");
		const content = tokens.filter(([k]) => k !== "ws");
		expect(content.every(([k]) => k === "builtin")).toBe(true);
	});

	it("preserves the original source verbatim across all tokens", () => {
		const code = `function foo(a: string): boolean {\n  // hi\n  return a === "x";\n}`;
		expect(roundtrip(code, "ts")).toBe(true);
	});
});

describe("tokenize / Python", () => {
	it("recognizes Python keywords and # comments", () => {
		const tokens = lex("def foo():\n    # comment\n    return None", "py");
		const content = tokens.filter(([k]) => k !== "ws");
		expect(content).toContainEqual(["keyword", "def"]);
		expect(content).toContainEqual(["ident", "foo"]);
		expect(content).toContainEqual(["comment", "# comment"]);
		expect(content).toContainEqual(["keyword", "return"]);
		expect(content).toContainEqual(["builtin", "None"]);
	});

	it("does not interpret // as a comment in Python", () => {
		const tokens = lex("a // b", "py");
		// `//` is two punct tokens in Python (no line-comment marker).
		expect(tokens.filter(([k]) => k === "comment")).toEqual([]);
	});
});

describe("tokenize / Bash", () => {
	it("recognizes bash keywords and # comments", () => {
		const tokens = lex("if true; then\n  echo hi # done\nfi", "sh");
		const content = tokens.filter(([k]) => k !== "ws");
		expect(content).toContainEqual(["keyword", "if"]);
		expect(content).toContainEqual(["builtin", "true"]);
		expect(content).toContainEqual(["keyword", "then"]);
		expect(content).toContainEqual(["builtin", "echo"]);
		expect(content).toContainEqual(["comment", "# done"]);
		expect(content).toContainEqual(["keyword", "fi"]);
	});
});

describe("tokenize / JSON", () => {
	it("classifies the three JSON literals as builtins", () => {
		const tokens = lex("true false null", "json");
		const content = tokens.filter(([k]) => k !== "ws");
		expect(content.every(([k]) => k === "builtin")).toBe(true);
	});

	it("treats double-quoted keys as strings", () => {
		const tokens = lex(`{"k": 1}`, "json");
		const content = tokens.filter(([k]) => k !== "ws");
		expect(content).toEqual([
			["punct", "{"],
			["string", `"k"`],
			["punct", ":"],
			["number", "1"],
			["punct", "}"],
		]);
	});
});

describe("tokenize / Rust", () => {
	it("recognizes Rust keywords and primitive types", () => {
		const tokens = lex("fn main() -> Result<u32, String> { 42 }", "rs");
		const content = tokens.filter(([k]) => k !== "ws");
		expect(content).toContainEqual(["keyword", "fn"]);
		expect(content).toContainEqual(["ident", "main"]);
		expect(content).toContainEqual(["type", "Result"]);
		expect(content).toContainEqual(["type", "u32"]);
		expect(content).toContainEqual(["type", "String"]);
		expect(content).toContainEqual(["number", "42"]);
	});
});

describe("tokenize / Go", () => {
	it("recognizes Go keywords, types, and backtick strings", () => {
		const tokens = lex("func main() { var x int = 1; s := `raw` }", "go");
		const content = tokens.filter(([k]) => k !== "ws");
		expect(content).toContainEqual(["keyword", "func"]);
		expect(content).toContainEqual(["keyword", "var"]);
		expect(content).toContainEqual(["type", "int"]);
		expect(content).toContainEqual(["string", "`raw`"]);
	});
});

describe("tokenize / edge cases", () => {
	it("returns an empty array for empty input", () => {
		const cfg = getLangConfig("ts");
		if (!cfg) throw new Error("ts config missing");
		expect(tokenize("", cfg)).toEqual([]);
	});

	it("does not eat past EOL on an unterminated single-quoted string", () => {
		// 'foo' is fine; 'foo (no close) should bail at the newline so the
		// rest of the file still tokenizes as code.
		const tokens = lex(`'foo\nlet x = 1`, "ts");
		// Find the let — it must still parse as a keyword, not be swallowed
		// inside the unterminated string.
		expect(tokens).toContainEqual(["keyword", "let"]);
	});

	it("rounds-trips arbitrary code across all configured languages", () => {
		const samples: Array<[string, string]> = [
			["ts", "const f = (x: number) => x * 2; // doubles"],
			["py", "for x in range(10):\n    print(x)"],
			["sh", `for f in *.txt; do echo "$f"; done`],
			["json", `[1, 2, "three", null]`],
			["rs", "let v: Vec<u8> = vec![1, 2, 3];"],
			["go", `m := map[string]int{"a": 1}`],
			["yaml", "key: true\nlist:\n  - 1\n  - 2"],
		];
		for (const [lang, code] of samples) {
			expect(roundtrip(code, lang)).toBe(true);
		}
	});
});
