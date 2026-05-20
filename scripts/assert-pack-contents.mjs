import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const expectedFiles = [
  "dist/index.d.ts",
  "dist/index.d.ts.map",
  "dist/index.js",
  "dist/index.js.map",
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
