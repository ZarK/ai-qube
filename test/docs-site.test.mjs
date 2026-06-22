import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("..", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

describe("QUBE public docs site", () => {
  it("keeps the landing page public-ready and linked from package docs", () => {
    const page = read("docs/index.html");
    const rootReadme = read("README.md");
    const packageReadmes = [
      "products/aib/README.md",
      "products/aie/README.md",
      "products/aiq/packages/cli/README.md",
      "products/aiu/README.md",
      "products/qube/README.md",
      "packages/qube-cli/README.md"
    ].map((path) => [path, read(path)]);

    assert.match(page, /QUBE moves ideas to completed implementation/);
    assert.match(page, /qube make-it-so/);
    assert.match(page, /qube run aie -- queue --json/);
    assert.match(page, /qube-command-surface-visual\.html/);
    assert.match(rootReadme, /docs\/index\.html/);
    for (const [path, readme] of packageReadmes) {
      assert.match(readme, /https:\/\/zark\.github\.io\/ai-qube\//, path);
      assert.match(readme, /docs\/index\.html/, path);
    }
  });

  it("documents and exposes a dependency-free local preview command", () => {
    const packageJson = JSON.parse(read("package.json"));
    const server = read("scripts/serve-docs.mjs");
    const rootReadme = read("README.md");

    assert.equal(packageJson.scripts["site:preview"], "node scripts/serve-docs.mjs");
    assert.match(server, /createServer/);
    assert.match(rootReadme, /pnpm run site:preview/);
  });
});
