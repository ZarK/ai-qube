import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);

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
