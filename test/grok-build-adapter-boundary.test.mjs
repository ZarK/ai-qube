import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PRODUCT_SRC = [
  path.join(repoRoot, "products", "aie", "src"),
  path.join(repoRoot, "products", "qube", "src"),
  path.join(repoRoot, "products", "aiu", "src"),
];
const ARGV_PATTERNS = [
  /--permission-mode/,
  /dontAsk/,
  /Available models/,
  /parseGrokModelCatalog/,
  /parseCodexModelCatalog/,
  /--no-subagents/,
  /--disable-web-search/,
  /--ignore-user-config/,
  /--strict-config/,
  /--output-schema/,
  /--skip-git-repo-check/,
  /mcp_servers=\{\}/,
  /web_search="disabled"/,
];
const HOOK_WRITER = /\.grok[\\/]+hooks/;

function listSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && statSync(full).isFile()) files.push(full);
    }
  };
  walk(root);
  return files;
}

describe("isolated review adapter boundary", () => {
  it("keeps Grok and Codex isolated-review argv, catalog parsers, and .grok/hooks writers out of products", () => {
    const hits = [];
    for (const root of PRODUCT_SRC) {
      for (const file of listSourceFiles(root)) {
        const text = readFileSync(file, "utf8");
        const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
        for (const pattern of ARGV_PATTERNS) {
          if (pattern.test(text)) hits.push(`${relative} contains ${pattern}`);
        }
        if (HOOK_WRITER.test(text)) hits.push(`${relative} contains a .grok/hooks writer`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
