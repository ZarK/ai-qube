import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const expectedFiles = [
  "dist/fixtures/cli.d.ts",
  "dist/fixtures/cli.d.ts.map",
  "dist/fixtures/cli.js",
  "dist/fixtures/cli.js.map",
  "dist/fixtures/metadata.d.ts",
  "dist/fixtures/metadata.d.ts.map",
  "dist/fixtures/metadata.js",
  "dist/fixtures/metadata.js.map",
  "dist/errors/index.d.ts",
  "dist/errors/index.d.ts.map",
  "dist/errors/index.js",
  "dist/errors/index.js.map",
  "dist/help/index.d.ts",
  "dist/help/index.d.ts.map",
  "dist/help/index.js",
  "dist/help/index.js.map",
  "dist/index.d.ts",
  "dist/index.d.ts.map",
  "dist/index.js",
  "dist/index.js.map",
  "dist/metadata/define.d.ts",
  "dist/metadata/define.d.ts.map",
  "dist/metadata/define.js",
  "dist/metadata/define.js.map",
  "dist/metadata/index.d.ts",
  "dist/metadata/index.d.ts.map",
  "dist/metadata/index.js",
  "dist/metadata/index.js.map",
  "dist/metadata/types.d.ts",
  "dist/metadata/types.d.ts.map",
  "dist/metadata/types.js",
  "dist/metadata/types.js.map",
  "dist/mutation/index.d.ts",
  "dist/mutation/index.d.ts.map",
  "dist/mutation/index.js",
  "dist/mutation/index.js.map",
  "dist/output/index.d.ts",
  "dist/output/index.d.ts.map",
  "dist/output/index.js",
  "dist/output/index.js.map",
  "dist/prompts/index.d.ts",
  "dist/prompts/index.d.ts.map",
  "dist/prompts/index.js",
  "dist/prompts/index.js.map",
  "dist/redaction/index.d.ts",
  "dist/redaction/index.d.ts.map",
  "dist/redaction/index.js",
  "dist/redaction/index.js.map",
  "dist/registry/index.d.ts",
  "dist/registry/index.d.ts.map",
  "dist/registry/index.js",
  "dist/registry/index.js.map",
  "dist/runtime/index.d.ts",
  "dist/runtime/index.d.ts.map",
  "dist/runtime/index.js",
  "dist/runtime/index.js.map",
  "dist/schema/index.d.ts",
  "dist/schema/index.d.ts.map",
  "dist/schema/index.js",
  "dist/schema/index.js.map",
  "dist/terminal/index.d.ts",
  "dist/terminal/index.d.ts.map",
  "dist/terminal/index.js",
  "dist/terminal/index.js.map",
  "LICENSE",
  "package.json",
  "README.md"
];

const { stdout } = await execFileAsync("pnpm", ["pack", "--dry-run", "--json"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0"
  },
  maxBuffer: 1024 * 1024
});

const packOutput = JSON.parse(stdout);
const packEntries = Array.isArray(packOutput) ? packOutput : [packOutput];
if (packEntries.length !== 1) {
  throw new Error("Expected pack dry-run JSON to return one package entry.");
}

const [packEntry] = packEntries;
if (typeof packEntry !== "object" || packEntry === null || !Array.isArray(packEntry.files)) {
  throw new Error("Unexpected pack dry-run JSON shape.");
}

const actualFiles = packEntry.files.map((file) => file.path).sort();
const missingFiles = expectedFiles.filter((file) => !actualFiles.includes(file));
const extraFiles = actualFiles.filter((file) => !expectedFiles.includes(file));

if (missingFiles.length > 0 || extraFiles.length > 0) {
  throw new Error(
    [
      "Pack contents did not match the allowed publish file list.",
      `Missing: ${missingFiles.length === 0 ? "none" : missingFiles.join(", ")}`,
      `Extra: ${extraFiles.length === 0 ? "none" : extraFiles.join(", ")}`
    ].join("\n")
  );
}

console.log(`Pack contents verified: ${actualFiles.join(", ")}`);
