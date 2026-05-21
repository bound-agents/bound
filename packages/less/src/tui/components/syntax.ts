/**
 * Lightweight, regex-driven syntax highlighter for fenced code blocks.
 *
 * Pulling in `cli-highlight`/`highlight.js` would add ~250KB+ of
 * dependency for a use case where we only need to colorize keywords,
 * strings, comments, and numbers in a handful of languages. This module
 * is a config-driven tokenizer: per-language entries declare their
 * keywords, comment markers, and string delimiters, and a single generic
 * `tokenize` walks the input emitting typed tokens.
 *
 * It is intentionally permissive — we don't try to be a real lexer.
 * Mismatched edge cases (e.g. `/` inside template literals, regex
 * literals) are rendered as their best-guess token and that's fine for
 * a TUI that just wants a useful pop of color.
 */

export type TokenKind =
	| "keyword"
	| "builtin"
	| "type"
	| "string"
	| "comment"
	| "number"
	| "punct"
	| "ident"
	| "ws"
	| "other";

export interface Token {
	kind: TokenKind;
	text: string;
}

export interface LangConfig {
	keywords: Set<string>;
	/** Literals like `true`, `false`, `null`, `None`, `nil`. */
	builtins?: Set<string>;
	/** Common type names (rendered distinctly from keywords). */
	types?: Set<string>;
	/** e.g. "//" or "#" or "--" — null means no line comments. */
	lineComment?: string;
	/** e.g. ["/*", "*\/"] or ['"""', '"""'] — null means no block comments. */
	blockComment?: [string, string];
	/** Single-character string delimiters. e.g. ['"', "'", "`"]. */
	stringDelims: string[];
	/** Whether `\\` escapes within strings (true for most C-family languages). */
	stringEscape?: boolean;
}

const IDENT_HEAD = /[A-Za-z_$]/;
const IDENT_TAIL = /[A-Za-z0-9_$]/;
const NUMBER_RE = /^[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9_]+)?[a-zA-Z]*/;
const WS_RE = /^\s+/;

/**
 * Tokenize a block of source code under the given language config.
 * Returns a flat array of tokens whose `.text` joined yields the original
 * input verbatim — the tokenizer does not normalize or rewrite anything.
 */
export function tokenize(code: string, lang: LangConfig): Token[] {
	const tokens: Token[] = [];
	let pos = 0;
	const len = code.length;

	while (pos < len) {
		const rest = code.slice(pos);
		const ch = code[pos];

		// Whitespace
		const wsMatch = rest.match(WS_RE);
		if (wsMatch) {
			tokens.push({ kind: "ws", text: wsMatch[0] });
			pos += wsMatch[0].length;
			continue;
		}

		// Block comment
		if (lang.blockComment && rest.startsWith(lang.blockComment[0])) {
			const [open, close] = lang.blockComment;
			const start = pos;
			pos += open.length;
			const closeIdx = code.indexOf(close, pos);
			if (closeIdx === -1) {
				pos = len;
			} else {
				pos = closeIdx + close.length;
			}
			tokens.push({ kind: "comment", text: code.slice(start, pos) });
			continue;
		}

		// Line comment
		if (lang.lineComment && rest.startsWith(lang.lineComment)) {
			const start = pos;
			while (pos < len && code[pos] !== "\n") pos++;
			tokens.push({ kind: "comment", text: code.slice(start, pos) });
			continue;
		}

		// String
		if (lang.stringDelims.includes(ch)) {
			const delim = ch;
			const start = pos;
			pos++; // skip opening delim
			const allowEscape = lang.stringEscape !== false;
			while (pos < len) {
				const c = code[pos];
				if (allowEscape && c === "\\" && pos + 1 < len) {
					pos += 2;
					continue;
				}
				if (c === delim) {
					pos++;
					break;
				}
				if (c === "\n" && delim !== "`") {
					// Most stringDelims don't span newlines; bail to avoid
					// eating the rest of the file on an unterminated string.
					break;
				}
				pos++;
			}
			tokens.push({ kind: "string", text: code.slice(start, pos) });
			continue;
		}

		// Number
		if (ch >= "0" && ch <= "9") {
			const m = rest.match(NUMBER_RE);
			if (m) {
				tokens.push({ kind: "number", text: m[0] });
				pos += m[0].length;
				continue;
			}
		}

		// Identifier (then check keyword/builtin/type tables)
		if (IDENT_HEAD.test(ch)) {
			const start = pos;
			pos++;
			while (pos < len && IDENT_TAIL.test(code[pos])) pos++;
			const text = code.slice(start, pos);
			let kind: TokenKind = "ident";
			if (lang.keywords.has(text)) kind = "keyword";
			else if (lang.builtins?.has(text)) kind = "builtin";
			else if (lang.types?.has(text)) kind = "type";
			tokens.push({ kind, text });
			continue;
		}

		// Punctuation / anything else — single character.
		tokens.push({ kind: "punct", text: ch });
		pos++;
	}

	return tokens;
}

// --- Language configs -------------------------------------------------------

const TS_KEYWORDS = new Set([
	"abstract",
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"declare",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"finally",
	"for",
	"from",
	"function",
	"get",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"is",
	"keyof",
	"let",
	"namespace",
	"new",
	"of",
	"package",
	"private",
	"protected",
	"public",
	"readonly",
	"return",
	"satisfies",
	"set",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"try",
	"type",
	"typeof",
	"var",
	"void",
	"while",
	"yield",
]);
const TS_BUILTINS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
const TS_TYPES = new Set([
	"string",
	"number",
	"boolean",
	"object",
	"any",
	"unknown",
	"never",
	"void",
	"bigint",
	"symbol",
	"Array",
	"Map",
	"Set",
	"Promise",
	"Record",
	"Partial",
	"Readonly",
	"Required",
	"Pick",
	"Omit",
	"Exclude",
	"Extract",
	"ReturnType",
]);

const TS_CONFIG: LangConfig = {
	keywords: TS_KEYWORDS,
	builtins: TS_BUILTINS,
	types: TS_TYPES,
	lineComment: "//",
	blockComment: ["/*", "*/"],
	stringDelims: ['"', "'", "`"],
};

const PY_CONFIG: LangConfig = {
	keywords: new Set([
		"and",
		"as",
		"assert",
		"async",
		"await",
		"break",
		"class",
		"continue",
		"def",
		"del",
		"elif",
		"else",
		"except",
		"finally",
		"for",
		"from",
		"global",
		"if",
		"import",
		"in",
		"is",
		"lambda",
		"nonlocal",
		"not",
		"or",
		"pass",
		"raise",
		"return",
		"try",
		"while",
		"with",
		"yield",
		"match",
		"case",
	]),
	builtins: new Set([
		"True",
		"False",
		"None",
		"self",
		"cls",
		"print",
		"len",
		"range",
		"dict",
		"list",
		"tuple",
		"set",
		"str",
		"int",
		"float",
		"bool",
		"bytes",
	]),
	lineComment: "#",
	stringDelims: ['"', "'"],
};

const BASH_CONFIG: LangConfig = {
	keywords: new Set([
		"if",
		"then",
		"else",
		"elif",
		"fi",
		"case",
		"esac",
		"for",
		"while",
		"until",
		"do",
		"done",
		"function",
		"in",
		"select",
		"time",
		"return",
		"local",
		"export",
		"readonly",
		"declare",
		"typeset",
		"set",
		"unset",
		"shift",
		"source",
	]),
	builtins: new Set([
		"true",
		"false",
		"echo",
		"printf",
		"cd",
		"pwd",
		"test",
		"read",
		"exit",
		"trap",
	]),
	lineComment: "#",
	stringDelims: ['"', "'"],
};

const JSON_CONFIG: LangConfig = {
	keywords: new Set(),
	builtins: new Set(["true", "false", "null"]),
	stringDelims: ['"'],
};

const RUST_CONFIG: LangConfig = {
	keywords: new Set([
		"as",
		"async",
		"await",
		"break",
		"const",
		"continue",
		"crate",
		"dyn",
		"else",
		"enum",
		"extern",
		"fn",
		"for",
		"if",
		"impl",
		"in",
		"let",
		"loop",
		"match",
		"mod",
		"move",
		"mut",
		"pub",
		"ref",
		"return",
		"self",
		"Self",
		"static",
		"struct",
		"super",
		"trait",
		"type",
		"unsafe",
		"use",
		"where",
		"while",
		"box",
		"do",
		"final",
		"macro",
		"override",
		"priv",
		"typeof",
		"unsized",
		"virtual",
		"yield",
	]),
	builtins: new Set(["true", "false", "None", "Some", "Ok", "Err"]),
	types: new Set([
		"bool",
		"char",
		"str",
		"String",
		"i8",
		"i16",
		"i32",
		"i64",
		"i128",
		"isize",
		"u8",
		"u16",
		"u32",
		"u64",
		"u128",
		"usize",
		"f32",
		"f64",
		"Vec",
		"Option",
		"Result",
		"Box",
		"Rc",
		"Arc",
		"HashMap",
		"HashSet",
	]),
	lineComment: "//",
	blockComment: ["/*", "*/"],
	stringDelims: ['"'],
};

const GO_CONFIG: LangConfig = {
	keywords: new Set([
		"break",
		"case",
		"chan",
		"const",
		"continue",
		"default",
		"defer",
		"else",
		"fallthrough",
		"for",
		"func",
		"go",
		"goto",
		"if",
		"import",
		"interface",
		"map",
		"package",
		"range",
		"return",
		"select",
		"struct",
		"switch",
		"type",
		"var",
	]),
	builtins: new Set([
		"true",
		"false",
		"nil",
		"iota",
		"make",
		"new",
		"len",
		"cap",
		"append",
		"copy",
		"delete",
		"panic",
		"recover",
		"print",
		"println",
	]),
	types: new Set([
		"bool",
		"byte",
		"rune",
		"string",
		"int",
		"int8",
		"int16",
		"int32",
		"int64",
		"uint",
		"uint8",
		"uint16",
		"uint32",
		"uint64",
		"uintptr",
		"float32",
		"float64",
		"complex64",
		"complex128",
		"error",
	]),
	lineComment: "//",
	blockComment: ["/*", "*/"],
	stringDelims: ['"', "`"],
};

const YAML_CONFIG: LangConfig = {
	// YAML is mostly key:value — there's no real keyword set, but flagging
	// the boolean/null literals helps the eye.
	keywords: new Set(),
	builtins: new Set(["true", "false", "null", "yes", "no", "True", "False", "Null", "None"]),
	lineComment: "#",
	stringDelims: ['"', "'"],
};

const CONFIGS: Record<string, LangConfig> = {
	ts: TS_CONFIG,
	tsx: TS_CONFIG,
	typescript: TS_CONFIG,
	js: TS_CONFIG,
	jsx: TS_CONFIG,
	javascript: TS_CONFIG,
	mjs: TS_CONFIG,
	cjs: TS_CONFIG,
	py: PY_CONFIG,
	python: PY_CONFIG,
	sh: BASH_CONFIG,
	bash: BASH_CONFIG,
	shell: BASH_CONFIG,
	zsh: BASH_CONFIG,
	json: JSON_CONFIG,
	jsonc: JSON_CONFIG,
	rs: RUST_CONFIG,
	rust: RUST_CONFIG,
	go: GO_CONFIG,
	golang: GO_CONFIG,
	yaml: YAML_CONFIG,
	yml: YAML_CONFIG,
};

/** Look up a language config by fenced-block lang tag (case-insensitive). */
export function getLangConfig(lang: string | undefined | null): LangConfig | null {
	if (!lang) return null;
	return CONFIGS[lang.toLowerCase()] ?? null;
}
