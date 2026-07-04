import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(repoRoot, "products/qube");
const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const tarballName = `tjalve-qube-${packageJson.version}.tgz`;
const tarballPath = path.join(packageDir, tarballName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["pack"], { cwd: packageDir });
run("npm", ["install", "-g", "--ignore-scripts", tarballPath]);

process.stdout.write(`Installed ${packageJson.name}@${packageJson.version} from ${tarballPath}\n`);