import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

describe("version audit", () => {
  it("keeps package versions above audited npm-published versions", () => {
    const result = spawnSync(process.execPath, ["scripts/check-version-audit.mjs"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      auditPath: "docs/release/version-audit.json",
      packageCount: 6
    });
  });
});
