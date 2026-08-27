import Parser from "../packages/shared/node_modules/tree-sitter";
import Bash from "../packages/shared/node_modules/tree-sitter-bash";
import C from "../packages/shared/node_modules/tree-sitter-c";
import Cpp from "../packages/shared/node_modules/tree-sitter-cpp";
import Go from "../packages/shared/node_modules/tree-sitter-go";
import Java from "../packages/shared/node_modules/tree-sitter-java";
import Kotlin from "../packages/shared/node_modules/tree-sitter-kotlin";
import Python from "../packages/shared/node_modules/tree-sitter-python";
import Ruby from "../packages/shared/node_modules/tree-sitter-ruby";
import Rust from "../packages/shared/node_modules/tree-sitter-rust";
import Swift from "../packages/shared/node_modules/tree-sitter-swift";

const grammars = [
	["bash", Bash, "probe() { :; }"],
	["c", C, "int probe(void) { return 0; }"],
	["cpp", Cpp, "class Probe {};"],
	["go", Go, "package probe\nfunc Probe() {}"],
	["java", Java, "class Probe {}"],
	["kotlin", Kotlin, "class Probe"],
	["python", Python, "class Probe:\n    pass"],
	["ruby", Ruby, "class Probe; end"],
	["rust", Rust, "struct Probe;"],
	["swift", Swift, "struct Probe {}"],
] as const;

for (const [name, language, source] of grammars) {
	const parser = new Parser();
	parser.setLanguage(language);
	if (parser.parse(source).rootNode.hasError) throw new Error(`${name}: probe parse failed`);
}

console.log(`loaded ${grammars.length} structure-reader grammar addons`);
