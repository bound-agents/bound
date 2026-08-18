import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import Python from "tree-sitter-python";
import Ruby from "tree-sitter-ruby";
import Rust from "tree-sitter-rust";
import Swift from "tree-sitter-swift";
import ts from "typescript";
import { computeLineHash } from "./hashline";

export interface StructureSymbol {
	name: string;
	anchor: string;
}

interface ExtractedSymbol {
	name: string;
	offset: number;
}

type StructureExtractor = (source: string, path: string) => ExtractedSymbol[];

export const MAX_STRUCTURE_OUTPUT_BYTES = 50_000;
/** Bound parser work before a source file can consume unbounded CPU or memory. */
export const MAX_SOURCE_STRUCTURE_INPUT_BYTES = 1_000_000;
export const SOURCE_STRUCTURE_INPUT_LIMIT_ERROR = "source file exceeds read_structure input limit";
export const SOURCE_STRUCTURE_PARSE_ERROR = "could not parse source structure";

/**
 * The declaration grammar emitted by read_structure for registered TS/JS files.
 *
 * At module top level, supported files emit named function, class, variable,
 * interface, type alias, enum, namespace/module, and named export declarations.
 * Imports, anonymous defaults, export stars, and nested declarations are omitted.
 */
export const SUPPORTED_SOURCE_STRUCTURE_GRAMMAR =
	"top-level function, class, variable, interface, type alias, enum, namespace, module, and named export declarations";

const PYTHON_EXTENSIONS = [".py", ".pyi"] as const;
const GO_EXTENSIONS = [".go"] as const;
const RUST_EXTENSIONS = [".rs"] as const;
const RUBY_EXTENSIONS = [".rb", ".rake", ".gemspec"] as const;
const PHP_EXTENSIONS = [".php", ".php3", ".php4", ".php5", ".phtml"] as const;
const JAVA_EXTENSIONS = [".java"] as const;
const KOTLIN_EXTENSIONS = [".kt", ".kts"] as const;
const C_EXTENSIONS = [".c", ".h"] as const;
const CPP_EXTENSIONS = [".cc", ".cp", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx"] as const;
const CSHARP_EXTENSIONS = [".cs", ".csx"] as const;
const SWIFT_EXTENSIONS = [".swift"] as const;
const LUA_EXTENSIONS = [".lua"] as const;
const SHELL_EXTENSIONS = [".sh", ".bash", ".zsh", ".ksh"] as const;
const SQL_EXTENSIONS = [".sql"] as const;

const TYPESCRIPT_EXTENSIONS = [
	".d.mts",
	".d.cts",
	".d.ts",
	".tsx",
	".jsx",
	".mjs",
	".cjs",
	".ts",
	".js",
] as const;

function extensionForPath(path: string): string | undefined {
	const lowerPath = path.toLowerCase();
	return [
		...TYPESCRIPT_EXTENSIONS,
		...PYTHON_EXTENSIONS,
		...GO_EXTENSIONS,
		...RUST_EXTENSIONS,
		...RUBY_EXTENSIONS,
		...PHP_EXTENSIONS,
		...JAVA_EXTENSIONS,
		...KOTLIN_EXTENSIONS,
		...C_EXTENSIONS,
		...CPP_EXTENSIONS,
		...CSHARP_EXTENSIONS,
		...SWIFT_EXTENSIONS,
		...LUA_EXTENSIONS,
		...SHELL_EXTENSIONS,
		...SQL_EXTENSIONS,
	].find((extension) => lowerPath.endsWith(extension));
}

function getDeclarationName(node: ts.Node): string | undefined {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isEnumDeclaration(node) ||
		ts.isModuleDeclaration(node)
	) {
		return node.name?.getText();
	}
	if (ts.isVariableStatement(node)) {
		const declaration = node.declarationList.declarations[0];
		return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
	}
	return undefined;
}

function declarationNames(node: ts.Node): string[] {
	if (ts.isVariableStatement(node)) {
		return node.declarationList.declarations.flatMap((declaration) =>
			ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
		);
	}
	if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
		return node.exportClause.elements.map((element) => element.name.text);
	}
	const name = getDeclarationName(node);
	return name ? [name] : [];
}

function scriptKindForExtension(extension: string): ts.ScriptKind {
	if (extension === ".tsx") return ts.ScriptKind.TSX;
	if (extension === ".jsx") return ts.ScriptKind.JSX;
	if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
		return ts.ScriptKind.JS;
	}
	return ts.ScriptKind.TS;
}

/** Extract supported top-level TypeScript/JavaScript declaration names as source offsets. */
function extractTypeScriptStructure(source: string, path: string): ExtractedSymbol[] {
	const extension = extensionForPath(path);
	if (!extension) return [];
	const sourceFile = ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForExtension(extension),
	);
	const parseDiagnostics = (
		sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
	).parseDiagnostics;
	if (parseDiagnostics.length > 0) throw new Error(SOURCE_STRUCTURE_PARSE_ERROR);
	const symbols: ExtractedSymbol[] = [];
	for (const statement of sourceFile.statements) {
		const offset = statement.getStart(sourceFile);
		for (const name of declarationNames(statement)) symbols.push({ name, offset });
	}
	return symbols;
}

function parserExtractor(
	language: Parameters<Parser["setLanguage"]>[0],
	nodeTypes: readonly string[],
	nameField = "name",
): StructureExtractor {
	return (source) => {
		const parser = new Parser();
		parser.setLanguage(language);
		const tree = parser.parse(source);
		if (tree.rootNode.hasError) throw new Error(SOURCE_STRUCTURE_PARSE_ERROR);
		return tree.rootNode.namedChildren.flatMap((node) => {
			if (node.type === "decorated_definition") {
				const definition = node.childForFieldName("definition");
				const name = definition?.childForFieldName(nameField);
				return definition &&
					name &&
					["class_definition", "function_definition"].includes(definition.type)
					? [{ name: name.text, offset: node.startIndex }]
					: [];
			}
			if (node.type === "expression_statement") {
				const assignment = node.namedChild(0);
				const name = assignment?.childForFieldName("left");
				return assignment?.type === "assignment" && name?.type === "identifier"
					? [{ name: name.text, offset: node.startIndex }]
					: [];
			}
			if (
				node.type === "const_declaration" ||
				node.type === "var_declaration" ||
				node.type === "type_declaration"
			) {
				const specs = node.namedChildren.flatMap((child) =>
					child.type.endsWith("_spec_list") ? child.namedChildren : [child],
				);
				return specs.flatMap((spec) => {
					const name = spec.childForFieldName(nameField);
					return name ? [{ name: name.text, offset: node.startIndex }] : [];
				});
			}
			if (!nodeTypes.includes(node.type)) return [];
			if (node.type === "impl_item") {
				const trait = node.childForFieldName("trait")?.text;
				const type = node.childForFieldName("type")?.text;
				const name = trait && type ? `${trait} for ${type}` : type;
				return name ? [{ name, offset: node.startIndex }] : [];
			}
			const name = node.childForFieldName(nameField);
			return name ? [{ name: name.text, offset: node.startIndex }] : [];
		});
	};
}

const extractPythonStructure = parserExtractor(Python, ["class_definition", "function_definition"]);
const extractGoStructure = parserExtractor(Go, [
	"type_declaration",
	"function_declaration",
	"method_declaration",
]);
const extractRustStructure = parserExtractor(Rust, [
	"struct_item",
	"enum_item",
	"union_item",
	"function_item",
	"trait_item",
	"impl_item",
	"type_item",
	"mod_item",
	"static_item",
	"const_item",
]);

const extractJavaStructure = parserExtractor(Java, [
	"class_declaration",
	"interface_declaration",
	"enum_declaration",
	"record_declaration",
	"annotation_type_declaration",
]);
const extractKotlinStructure: StructureExtractor = (source) => {
	const symbols: ExtractedSymbol[] = [];
	const declaration =
		/^(?:\s*(?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|companion|inline|suspend|tailrec|operator|infix|external|expect|actual)\s+)*(?:class|interface|object|fun|val|var|typealias)\s+([A-Za-z_][\w]*)/gm;
	for (const match of source.matchAll(declaration)) {
		const name = match[1];
		if (name) symbols.push({ name, offset: match.index ?? 0 });
	}
	return symbols;
};

const extractCStructure: StructureExtractor = (source) => {
	const symbols: ExtractedSymbol[] = [];
	const declaration =
		/^(?:\s*(?:typedef\s+)?(?:struct|union|enum)\s+([A-Za-z_][\w]*)|\s*(?:[A-Za-z_][\w]*(?:\s*\*+)?\s+)+([A-Za-z_][\w]*)\s*\()/gm;
	for (const match of source.matchAll(declaration)) {
		const name = match[1] ?? match[2];
		if (name) symbols.push({ name, offset: match.index ?? 0 });
	}
	return symbols;
};
const extractCppStructure: StructureExtractor = (source) => {
	const symbols: ExtractedSymbol[] = [];
	const declaration =
		/^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union|enum|namespace)\s+([A-Za-z_][\w]*)|^\s*(?:[A-Za-z_][\w:<>]*(?:\s*[*&]+)?\s+)+([A-Za-z_~][\w:]*)\s*\(/gm;
	for (const match of source.matchAll(declaration)) {
		const name = match[1] ?? match[2];
		if (name) symbols.push({ name, offset: match.index ?? 0 });
	}
	return symbols;
};

const extractCSharpStructure: StructureExtractor = (source) => {
	const symbols: ExtractedSymbol[] = [];
	const declaration =
		/^(?:\s*(?:public|private|protected|internal|static|abstract|sealed|partial|async|new|unsafe|readonly|ref|file)\s+)*(?:class|interface|struct|enum|record(?:\s+(?:class|struct))?|delegate)\s+([A-Za-z_][\w]*)|^\s*namespace\s+([A-Za-z_][\w.]*)/gm;
	for (const match of source.matchAll(declaration)) {
		const name = match[1] ?? match[2];
		if (name) symbols.push({ name, offset: match.index ?? 0 });
	}
	return symbols;
};
const extractSwiftStructure = parserExtractor(Swift, [
	"class_declaration",
	"protocol_declaration",
	"function_declaration",
	"property_declaration",
	"typealias_declaration",
]);

const extractLuaStructure: StructureExtractor = (source) => {
	const symbols: ExtractedSymbol[] = [];
	const declaration =
		/^(?:local\s+)?function\s+([A-Za-z_][\w]*(?:[.:][A-Za-z_][\w]*)?)|^(?:local\s+)?([A-Za-z_][\w]*)\s*=/gm;
	for (const match of source.matchAll(declaration)) {
		const name = match[1] ?? match[2];
		if (name) symbols.push({ name, offset: match.index ?? 0 });
	}
	return symbols;
};

const extractShellStructure: StructureExtractor = (source) => {
	const parser = new Parser();
	parser.setLanguage(Bash);
	const tree = parser.parse(source);
	if (tree.rootNode.hasError) throw new Error(SOURCE_STRUCTURE_PARSE_ERROR);
	return tree.rootNode.namedChildren.flatMap((node) => {
		if (node.type === "function_definition") {
			const name = node.childForFieldName("name");
			return name ? [{ name: name.text, offset: node.startIndex }] : [];
		}
		if (node.type === "variable_assignment") {
			const name = node.childForFieldName("name");
			return name ? [{ name: name.text, offset: node.startIndex }] : [];
		}
		return [];
	});
};

const extractSqlStructure: StructureExtractor = (source) => {
	const statement =
		/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|(?:UNIQUE\s+)?INDEX|(?:OR\s+REPLACE\s+)?FUNCTION|TYPE|DOMAIN)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z_][\w$]*\.)?([A-Za-z_][\w$]*)/gi;
	const symbols: ExtractedSymbol[] = [];
	for (const match of source.matchAll(statement)) {
		const name = match[1];
		if (name) symbols.push({ name, offset: match.index ?? 0 });
	}
	return symbols;
};

const extractRubyStructure: StructureExtractor = (source) => {
	const parser = new Parser();
	parser.setLanguage(Ruby);
	const tree = parser.parse(source);
	if (tree.rootNode.hasError) throw new Error(SOURCE_STRUCTURE_PARSE_ERROR);
	return tree.rootNode.namedChildren.flatMap((node) => {
		if (node.type === "assignment") {
			const name = node.childForFieldName("left");
			return name?.type === "constant" ? [{ name: name.text, offset: node.startIndex }] : [];
		}
		if (!["class", "module", "method", "singleton_method"].includes(node.type)) return [];
		const name = node.childForFieldName("name");
		return name ? [{ name: name.text, offset: node.startIndex }] : [];
	});
};

const extractPhpStructure: StructureExtractor = (source) => {
	const symbols: ExtractedSymbol[] = [];
	const declaration =
		/^\s*(?:namespace\s+([A-Za-z_][\w\\]*)|(?:abstract\s+|final\s+|readonly\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_][\w]*)|function\s+([A-Za-z_][\w]*)|const\s+([A-Za-z_][\w]*))/gm;
	for (const match of source.matchAll(declaration)) {
		const name = match[1] ?? match[2] ?? match[3] ?? match[4];
		if (name) symbols.push({ name, offset: match.index ?? 0 });
	}
	return symbols;
};

const EXTRACTORS: ReadonlyMap<string, StructureExtractor> = new Map([
	...TYPESCRIPT_EXTENSIONS.map((extension) => [extension, extractTypeScriptStructure] as const),
	...PYTHON_EXTENSIONS.map((extension) => [extension, extractPythonStructure] as const),
	...GO_EXTENSIONS.map((extension) => [extension, extractGoStructure] as const),
	...RUST_EXTENSIONS.map((extension) => [extension, extractRustStructure] as const),
	...RUBY_EXTENSIONS.map((extension) => [extension, extractRubyStructure] as const),
	...PHP_EXTENSIONS.map((extension) => [extension, extractPhpStructure] as const),
	...JAVA_EXTENSIONS.map((extension) => [extension, extractJavaStructure] as const),
	...KOTLIN_EXTENSIONS.map((extension) => [extension, extractKotlinStructure] as const),
	...C_EXTENSIONS.map((extension) => [extension, extractCStructure] as const),
	...CPP_EXTENSIONS.map((extension) => [extension, extractCppStructure] as const),
	...CSHARP_EXTENSIONS.map((extension) => [extension, extractCSharpStructure] as const),
	...SWIFT_EXTENSIONS.map((extension) => [extension, extractSwiftStructure] as const),
	...LUA_EXTENSIONS.map((extension) => [extension, extractLuaStructure] as const),
	...SHELL_EXTENSIONS.map((extension) => [extension, extractShellStructure] as const),
	...SQL_EXTENSIONS.map((extension) => [extension, extractSqlStructure] as const),
]);

function lineStarts(source: string): number[] {
	const starts = [0];
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "\n") starts.push(index + 1);
	}
	return starts;
}

function lineForOffset(starts: readonly number[], offset: number): number {
	let low = 0;
	let high = starts.length;
	while (low + 1 < high) {
		const middle = Math.floor((low + high) / 2);
		if ((starts[middle] ?? 0) <= offset) low = middle;
		else high = middle;
	}
	return low;
}

function assertInputSize(source: string): void {
	if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_STRUCTURE_INPUT_BYTES) {
		throw new Error(SOURCE_STRUCTURE_INPUT_LIMIT_ERROR);
	}
}

/**
 * Extract a flat, hashline-compatible outline. Unregistered extensions return
 * no symbols; parsing never falls through to another language extractor.
 */
export function extractSourceStructure(source: string, path = "structure.ts"): StructureSymbol[] {
	assertInputSize(source);
	const normalized = source.replace(/\r\n/g, "\n");
	const extension = extensionForPath(path);
	if (!extension) return [];
	const extractor = EXTRACTORS.get(extension);
	if (!extractor) return [];

	let extracted: ExtractedSymbol[];
	try {
		extracted = extractor(normalized, path);
	} catch {
		throw new Error(SOURCE_STRUCTURE_PARSE_ERROR);
	}

	const lines = normalized.split("\n");
	const starts = lineStarts(normalized);
	return extracted.map(({ name, offset }) => {
		const line = lineForOffset(starts, offset);
		return { name, anchor: `${line + 1}:${computeLineHash(lines[line] ?? "")}` };
	});
}

export function formatSourceStructure(
	source: string,
	path = "structure.ts",
	maxBytes = MAX_STRUCTURE_OUTPUT_BYTES,
): string {
	const lines: string[] = [];
	for (const symbol of extractSourceStructure(source, path)) {
		const line = `${symbol.anchor}|${symbol.name}`;
		if (Buffer.byteLength([...lines, line].join("\n"), "utf8") > maxBytes) {
			const marker = "[truncated; structure output limit reached]";
			while (
				lines.length > 0 &&
				Buffer.byteLength([...lines, marker].join("\n"), "utf8") > maxBytes
			) {
				lines.pop();
			}
			return [...lines, marker].join("\n");
		}
		lines.push(line);
	}
	return lines.join("\n");
}
