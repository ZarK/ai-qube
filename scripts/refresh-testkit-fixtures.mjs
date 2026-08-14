import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repoRoot, "packages", "qube-testkit");
const command = process.argv[2] ?? "check";
const relativePath = process.argv[3];

if (command !== "check" && command !== "write") {
  process.stderr.write("Usage: node scripts/refresh-testkit-fixtures.mjs check|write <relative-fixture-path>\n");
  process.exit(2);
}

if (!relativePath) {
  process.stderr.write("A repository-relative fixture path is required.\n");
  process.exit(2);
}

let resolved;
try {
  resolved = resolveContained(fixtureRoot, relativePath);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (!existsSync(resolved) || !statSync(resolved).isFile()) {
  process.stderr.write(`Fixture file is missing: ${relativePath}\n`);
  process.exit(1);
}

const bytes = readFileSync(resolved);
const digest = createHash("sha256").update(bytes).digest("hex");
if (command === "write") {
  writeFileSync(`${resolved}.sha256`, `${digest}\n`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  command: "refresh-testkit-fixtures",
  path: relativePath,
  sha256: digest,
  wrote: command === "write"
})}\n`);

function resolveContained(root, relative) {
  const normalized = relative.replace(/\\/g, "/");
  if (normalized === "" || normalized.includes("\0") || path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Fixture path must be relative to the testkit package.");
  }
  const segments = normalized.split("/").filter(segment => segment !== "");
  if (segments.some(segment => segment === ".." || segment === ".")) {
    throw new Error("Fixture path must not include parent-directory segments.");
  }
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    const realCurrent = realpathSync(current);
    const escaped = path.relative(realRoot, realCurrent);
    if (escaped.startsWith("..") || path.isAbsolute(escaped)) {
      throw new Error("Fixture path must not escape the testkit package through a symlink.");
    }
  }
  return current;
}
