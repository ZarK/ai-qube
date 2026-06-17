import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const engineRequire = createRequire(
  path.join(workspaceRoot, "packages", "engine", "package.json"),
);
const entryPoint = path.join(workspaceRoot, "packages", "github-action", "src", "main.ts");
const outfile = path.join(workspaceRoot, "packages", "github-action", "dist", "main.mjs");
const stylelintPackageJsonPath = engineRequire.resolve("stylelint/package.json");
const stylelintRequire = createRequire(stylelintPackageJsonPath);
const cssTreePackageJsonPath = stylelintRequire.resolve("css-tree/package.json");
const cssTreePatchSource = path.join(
  path.dirname(cssTreePackageJsonPath),
  "data",
  "patch.json",
);
const cssTreePatchTarget = path.join(
  workspaceRoot,
  "packages",
  "github-action",
  "dist",
  "data",
  "patch.json",
);

await mkdir(path.dirname(outfile), { recursive: true });
await mkdir(path.dirname(cssTreePatchTarget), { recursive: true });

await build({
  absWorkingDir: workspaceRoot,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  bundle: true,
  entryPoints: [entryPoint],
  format: "esm",
  logLevel: "warning",
  outfile,
  platform: "node",
  target: "node20",
});

const [{ version: cssTreeVersion }, { version: stylelintVersion }] = await Promise.all([
  readPackageVersion(cssTreePackageJsonPath),
  readPackageVersion(stylelintPackageJsonPath),
]);
const bundleSource = await readFile(outfile, "utf8");
const patchedBundleSource = applyRequiredPatternReplacement(
  applyRequiredPatternReplacement(
    applyRequiredPatternReplacement(
      bundleSource,
      /var pkg = JSON\.parse\([A-Za-z_$][\w$]*\(new URL\("\.\.\/\.\.\/package\.json", import\.meta\.url\), "utf8"\)\);/,
      `var pkg = { version: ${JSON.stringify(stylelintVersion)} };`,
      "stylelint package metadata read",
    ),
    /patch = (?<requireName>[A-Za-z_$][\w$]*)\("\.\.\/data\/patch\.json"\);/,
    'patch = $<requireName>("./data/patch.json");',
    "css-tree patch asset path",
  ),
  /\(\{ version(?:: (?<versionName>[A-Za-z_$][\w$]*))? \} = (?<requireName>[A-Za-z_$][\w$]*)\("\.\.\/package\.json"\)\);/,
  (...args) => {
    const groups = args.at(-1);
    return `${groups.versionName ?? "version"} = ${JSON.stringify(cssTreeVersion)};`;
  },
  "css-tree package metadata read",
);
const normalizedBundleSource = patchedBundleSource.replace(/[ \t]+$/gmu, "");

await writeFile(outfile, normalizedBundleSource, "utf8");
await copyFile(cssTreePatchSource, cssTreePatchTarget);

async function readPackageVersion(packageJsonPath) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof packageJson.version !== "string") {
    throw new Error(`Expected ${packageJsonPath} to contain a string version.`);
  }

  return { version: packageJson.version };
}

function applyRequiredReplacement(source, searchValue, replacementValue, description) {
  if (!source.includes(searchValue)) {
    throw new Error(`Expected bundled output to include ${description}.`);
  }

  return source.replace(searchValue, replacementValue);
}

function applyRequiredPatternReplacement(source, pattern, replacementValue, description) {
  const globalPattern = createGlobalPattern(pattern);
  const matches = [...source.matchAll(globalPattern)];
  if (matches.length === 0) {
    throw new Error(`Expected bundled output to include ${description}.`);
  }

  if (matches.length !== 1) {
    throw new Error(`Expected bundled output to include exactly one ${description} match.`);
  }

  return source.replace(pattern, replacementValue);
}

function createGlobalPattern(pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}
