import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PUBLISH_PACKAGES } from "../scripts/publish-packages.mjs";

describe("version audit", () => {
  it("keeps package versions at or above audited npm-published versions", () => {
    const result = spawnSync(process.execPath, ["scripts/check-version-audit.mjs"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.auditPath, "docs/release/version-audit.json");
    assert.equal(payload.packageCount, PUBLISH_PACKAGES.size);
    const audit = JSON.parse(readFileSync(new URL("../docs/release/version-audit.json", import.meta.url), "utf8"));
    assert.ok(audit.packages.some(entry => entry.packageJson === "adapters/cursor/package.json"));
  });
});
