import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { inspectReleaseCheckout, parseReleaseArgs, planRelease, runRelease } from "../scripts/release-set.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function publishedMapFromWorkspace(unpublishedKeys = ["qube"]) {
  const audit = JSON.parse(readFileSync(path.join(repoRoot, "docs/release/version-audit.json"), "utf8"));
  const map = new Map();
  for (const entry of audit.packages) {
    const key = entry.packageJson.includes("products/qube/package.json") ? "qube"
      : entry.packageJson.includes("products/aib/") ? "aib"
      : entry.packageJson.includes("products/aie/") ? "aie"
      : entry.name;
    const version = JSON.parse(readFileSync(path.join(repoRoot, entry.packageJson), "utf8")).version;
    map.set(entry.name, unpublishedKeys.includes(key) || unpublishedKeys.includes(entry.name) ? [] : [version]);
  }
  return map;
}

describe("release set", () => {
  it("prints the set tag and unpublished list without pushing", async () => {
    const report = await runRelease({
      repoRoot,
      dryRun: true,
      publishedByName: publishedMapFromWorkspace(["qube"]),
    });
    const qubeVersion = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8")).version;
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(report.pushed, false);
    assert.equal(report.tag, `publish-set-v${qubeVersion}`);
    assert.equal(report.packages.some(entry => entry.packageName === "@tjalve/qube"), true);
    assert.equal(report.packages.some(entry => entry.packageName === "@tjalve/aie"), false);
  });

  it("fails when every workspace version is already on npm", async () => {
    await assert.rejects(
      () => planRelease({ repoRoot, publishedByName: publishedMapFromWorkspace([]) }),
      { reasonCode: "nothing-to-publish" }
    );
  });

  it("refuses to push from a dirty or non-main checkout", () => {
    const calls = [];
    const git = {
      run(args) {
        calls.push(args);
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "issue/601-test";
        return "abc";
      },
    };
    assert.throws(() => inspectReleaseCheckout(repoRoot, git), { reasonCode: "not-main" });

    const dirty = {
      run(args) {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
        if (args[0] === "status") return " M scripts/release-set.mjs";
        return "abc";
      },
    };
    assert.throws(() => inspectReleaseCheckout(repoRoot, dirty), { reasonCode: "dirty-worktree" });
  });

  it("pushes the annotated set tag only from a clean current main", async () => {
    const commands = [];
    const git = {
      run(args) {
        commands.push(args.join(" "));
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "same-sha";
        if (args[0] === "tag" && args[1] === "--list") return "";
        return "";
      },
    };
    const report = await runRelease({
      repoRoot,
      publishedByName: publishedMapFromWorkspace(["qube"]),
      git,
    });
    assert.equal(report.ok, true);
    assert.equal(report.pushed, true);
    assert.equal(commands.some(line => line.startsWith("tag -a publish-set-v")), true);
    assert.equal(commands.some(line => line.startsWith("push origin publish-set-v")), true);
  });

  it("parses dry-run and rejects unknown flags", () => {
    assert.deepEqual(parseReleaseArgs(["--dry-run", "--json"]), {
      help: false,
      json: true,
      dryRun: true,
      repoRoot: undefined,
    });
    assert.throws(() => parseReleaseArgs(["--explode"]), { reasonCode: "usage" });
  });
});
