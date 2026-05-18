import { Database } from "bun:sqlite";
import { applySchema } from "@bound/core";
import { InMemoryFs } from "just-bash";
import { createSkillTool } from "./packages/agent/src/tools/skill.ts";

const db = new Database(":memory:");
applySchema(db);

const fs = new InMemoryFs();
const siteId = "test-site";
const toolContext = {
	db,
	siteId,
	eventBus: { on: () => {}, off: () => {}, emit: () => {}, once: () => {} },
	logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
	fs,
};

const skillContent = "---\nname: my-skill\ndescription: Test skill\n---\n# My Skill\nBody here.";

await fs.writeFile("/home/user/skills/my-skill/SKILL.md", skillContent);

const tool = createSkillTool(toolContext);
const activateResult = await tool.execute({ action: "activate", name: "my-skill" });
console.log("Activate:", activateResult);

const readResult = await tool.execute({ action: "read", name: "my-skill" });
console.log("Read result:", readResult);

const files = db.prepare("SELECT path FROM files WHERE deleted = 0").all();
console.log("Stored files:", JSON.stringify(files));

const skill = db.prepare("SELECT skill_root FROM skills WHERE name = ?").get("my-skill");
console.log("skill_root:", JSON.stringify(skill));

db.close();
