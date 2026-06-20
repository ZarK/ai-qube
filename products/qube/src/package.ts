import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as PackageJson;

export const packageName = packageJson.name;
export const packageVersion = packageJson.version;
export const packageDescription = packageJson.description;
