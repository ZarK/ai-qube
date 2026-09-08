import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

describe("QUBE public docs site", () => {
  it("keeps QUBE release examples and command references consistent", () => {
    const releaseVersion = "0.2.12";
    const releaseReference = "https://github.com/ZarK/ai-qube/blob/51eb90562ac9c27590d3b647a515ef9ff9c8c884/docs/qube-command-surfaces.md";
    const publicDocs = [
      ["README.md", read("README.md")],
      ["products/qube/README.md", read("products/qube/README.md")],
      ["docs/qube-init.md", read("docs/qube-init.md")],
      ["docs/index.html", read("docs/index.html")],
    ];

    for (const [docPath, content] of publicDocs) {
      const installVersions = [...content.matchAll(/@tjalve\/qube@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
      assert.ok(installVersions.length > 0, `${docPath} must contain a pinned QUBE install example`);
      assert.deepEqual([...new Set(installVersions)], [releaseVersion], docPath);
      assert.match(content, /development/i, docPath);
      assert.ok(content.includes(releaseReference), docPath);
      assert.doesNotMatch(content, /\bqube status\b/, docPath);
    }

    for (const [docPath, content] of publicDocs.slice(0, 3)) {
      assert.match(content, /npm exec -- qube init\b/, docPath);
      assert.match(content, /pnpm exec qube init\b/, docPath);
      assert.match(content, /global install/i, docPath);
    }
    assert.match(publicDocs[3][1], /pnpm exec qube init\b/);
    assert.match(publicDocs[3][1], /qube continue --json/);

    const commandReference = read("docs/qube-command-surfaces.md");
    assert.match(commandReference, /development/i);
    assert.ok(commandReference.includes(releaseReference));

    const rootReadme = publicDocs[0][1];
    assert.doesNotMatch(rootReadme, /docs\/version-audit\.json/);
    const auditLinks = [...rootReadme.matchAll(/docs\/release\/version-audit\.json/g)];
    assert.ok(auditLinks.length > 0);
    assert.equal(existsSync(new URL("../docs/release/version-audit.json", import.meta.url)), true);
    assert.doesNotThrow(() => JSON.parse(read("docs/release/version-audit.json")));
  });

  it("keeps the landing page public-ready and linked from package docs", () => {
    const page = read("docs/index.html");
    const rootReadme = read("README.md");
    const packageReadmes = [
      "packages/qube-core/README.md",
      "packages/qube-cli/README.md",
      "adapters/github/README.md",
      "adapters/codex/README.md",
      "adapters/opencode/README.md",
      "adapters/claude-code/README.md",
      "adapters/gitlab/README.md",
      "adapters/linear/README.md",
      "adapters/jira/README.md",
      "adapters/jenkins/README.md",
      "products/aib/README.md",
      "products/aie/README.md",
      "products/aiq/packages/cli/README.md",
      "products/aiu/README.md",
      "products/qube/README.md"
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

  it("serves malformed paths as not found without crashing", async (context) => {
    const port = 48000 + (process.pid % 1000);
    const child = spawn(process.execPath, ["scripts/serve-docs.mjs"], {
      cwd: rootPath,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    context.after(() => {
      if (!child.killed) child.kill();
    });

    await new Promise((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => {
        reject(new Error(`Preview server did not start. stderr: ${stderr}`));
      }, 5000);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("QUBE docs preview")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Preview server exited early with code ${code}. stderr: ${stderr}`));
      });
    });

    const malformed = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
    assert.equal(malformed.status, 404);

    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /QUBE moves ideas to completed implementation/);
  });
});
