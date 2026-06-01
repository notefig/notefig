const { mkdirSync, writeFileSync } = require("node:fs");
const { resolve, dirname } = require("node:path");
const {
  getProjectConfigV1JsonSchema,
} = require("../dist/config/project-config.schema.js");

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function main() {
  const schema = getProjectConfigV1JsonSchema();

  const outputPath = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "schemas",
    "project-config",
    "v1.schema.json",
  );

  ensureDir(outputPath);
  writeFileSync(outputPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  console.log(`Generated schema: ${outputPath}`);
}

main();
