import { createRequire } from "node:module";

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

const requirePackage = createRequire(import.meta.url);

export const packageJson = requirePackage("../package.json") as PackageJson;
