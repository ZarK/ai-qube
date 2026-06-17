import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const cliDist = path.join(workspaceRoot, "packages", "cli", "dist");

const internalModules = [
  ["benchmark", "benchmark"],
  ["config-schema", "config"],
  ["engine", "engine"],
  ["model", "model"],
  ["reporters", "reporters"],
];

for (const [workspaceName, exportName] of internalModules) {
  const source = path.join(workspaceRoot, "packages", workspaceName, "dist");
  const target = path.join(cliDist, exportName);
  await rm(target, { force: true, recursive: true });
  await cp(source, target, { recursive: true });
}
