import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installAiUmpireIntoRepo } from "../src/installer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("installAiUmpireIntoRepo", () => {
  it("writes the plugin wrapper, queue policy, and executable scripts", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiu-install-"));
    tempDirs.push(repoDir);

    const result = await installAiUmpireIntoRepo({ targetDir: repoDir });

    expect(result.installed).toContain(path.join(".opencode", "plugins", "ai-umpire-continuation.ts"));
    expect(result.installed).toContain("queue-policy.json");
    expect(result.installed).toContain(path.join("scripts", "gh-priority-order.sh"));

    const wrapperSource = await readFile(
      path.join(repoDir, ".opencode", "plugins", "ai-umpire-continuation.ts"),
      "utf8",
    );
    expect(wrapperSource).toContain('import AiUmpireContinuationPlugin from "@tjalve/aiu/opencode";');

    const scriptStats = await stat(path.join(repoDir, "scripts", "gh-priority-order.sh"));
    expect(scriptStats.mode & 0o111).not.toBe(0);
  });

  it("does not overwrite existing assets unless force is enabled", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiu-install-"));
    tempDirs.push(repoDir);
    const queuePolicyPath = path.join(repoDir, "queue-policy.json");

    await writeFile(queuePolicyPath, "custom\n", "utf8");

    const initialResult = await installAiUmpireIntoRepo({ targetDir: repoDir });
    expect(initialResult.skipped).toContain("queue-policy.json");
    expect(await readFile(queuePolicyPath, "utf8")).toBe("custom\n");

    const forcedResult = await installAiUmpireIntoRepo({ force: true, targetDir: repoDir });
    expect(forcedResult.installed).toContain("queue-policy.json");
    expect(await readFile(queuePolicyPath, "utf8")).not.toBe("custom\n");
  });
});
