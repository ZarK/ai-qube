import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { inspectReleaseCheckout, parseReleaseArgs, planRelease, planRetryTag, runRelease } from "../scripts/release-set.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const prepared = Object.freeze({ needsWrite: false, baselineTag: "publish-set-v0.2.8" });

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
      preparation: prepared,
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
      () => planRelease({ repoRoot, publishedByName: publishedMapFromWorkspace([]), preparation: prepared }),
      { reasonCode: "nothing-to-publish" }
    );
  });

  it("reports a brand-new package before release tag creation", async () => {
    await assert.rejects(
      () => planRelease({
        repoRoot,
        publishedByName: publishedMapFromWorkspace(["qube", "@tjalve/qube-adapter-cursor"]),
        missingPackageNames: ["@tjalve/qube-adapter-cursor"],
        preparation: prepared,
      }),
      error => error?.reasonCode === "package-bootstrap"
        && /qube-adapter-cursor/.test(error.message)
        && /one-time direct bootstrap/.test(error.message)
    );
  });

  it("selects a new immutable retry tag after the original set tag", () => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8")).version;
    const originalTag = `publish-set-v${version}`;
    const git = {
      run(args) {
        if (args[0] === "ls-remote" && args.at(-1) === `refs/tags/${originalTag}^{}`) {
          return `tag-object\trefs/tags/${originalTag}\nbase-sha\trefs/tags/${originalTag}^{}`;
        }
        if (args[0] === "tag" && args[2] === originalTag) return originalTag;
        if (args[0] === "rev-parse") return "base-sha";
        if (args[0] === "merge-base") return "";
        if (args[0] === "tag") return `${originalTag}-retry.1`;
        if (args[0] === "ls-remote") return `retry-object\trefs/tags/${originalTag}-retry.2`;
        return "";
      },
    };
    assert.deepEqual(planRetryTag(repoRoot, version, git), {
      originalTag,
      originalCommit: "base-sha",
      retry: 3,
      tag: `${originalTag}-retry.3`,
    });
  });

  it("plans only unpublished versions for a partial set retry", async () => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8")).version;
    const originalTag = `publish-set-v${version}`;
    const git = {
      run(args) {
        if (args[0] === "ls-remote" && args.at(-1) === `refs/tags/${originalTag}^{}`) {
          return `base-sha\trefs/tags/${originalTag}`;
        }
        if (args[0] === "merge-base") return "";
        return "";
      },
    };
    const report = await planRelease({
      repoRoot,
      retry: true,
      publishedByName: publishedMapFromWorkspace(["qube"]),
      git,
    });
    assert.equal(report.tag, `${originalTag}-retry.1`);
    assert.deepEqual(report.packages.map(entry => entry.packageName), ["@tjalve/qube"]);
    assert.equal(report.skipped.length > 0, true);
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

    const untracked = {
      run(args) {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
        if (args[0] === "status") {
          assert.ok(args.includes("--untracked-files=normal"));
          return "?? scratch.txt";
        }
        return "abc";
      },
    };
    assert.throws(() => inspectReleaseCheckout(repoRoot, untracked), { reasonCode: "dirty-worktree" });
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
      preparation: prepared,
      git,
    });
    assert.equal(report.ok, true);
    assert.equal(report.pushed, true);
    assert.equal(commands.some(line => line.startsWith("tag -a publish-set-v")), true);
    assert.equal(commands.some(line => line.startsWith("push origin publish-set-v")), true);
  });

  it("refuses an incomplete generated release preparation", async () => {
    await assert.rejects(
      () => planRelease({
        repoRoot,
        publishedByName: publishedMapFromWorkspace(["qube"]),
        preparation: { needsWrite: true, baselineTag: "publish-set-v0.2.8" },
      }),
      { reasonCode: "release-unprepared" }
    );
  });

  it("refuses to move an existing set tag to another commit", async () => {
    const git = {
      run(args) {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse" && args[1]?.endsWith("^{}")) return "other-sha";
        if (args[0] === "rev-parse") return "same-sha";
        if (args[0] === "tag" && args[1] === "--list") return args[2];
        return "";
      },
    };
    await assert.rejects(
      () => runRelease({
        repoRoot,
        publishedByName: publishedMapFromWorkspace(["qube"]),
        preparation: prepared,
        git,
      }),
      { reasonCode: "tag-mismatch" }
    );
  });

  it("parses dry-run and rejects unknown flags", () => {
    assert.deepEqual(parseReleaseArgs(["--retry", "--dry-run", "--json"]), {
      help: false,
      json: true,
      dryRun: true,
      retry: true,
      repoRoot: undefined,
    });
    assert.throws(() => parseReleaseArgs(["--explode"]), { reasonCode: "usage" });
  });
});
