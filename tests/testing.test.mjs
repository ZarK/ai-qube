import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("testing helpers", () => {
  it("asserts CLI text and JSON results with useful defaults", async () => {
    const { assertCliJsonSuccess, assertCliResult } = await import("../dist/testing/index.js");
    const result = Object.freeze({
      command: "fixture",
      args: Object.freeze(["--json"]),
      status: 0,
      signal: null,
      stdout: '{"ok":true,"command":"fixture"}\n',
      stderr: ""
    });

    assertCliResult(result, { status: 0, stdout: /"ok":true/, stderr: "" });
    assert.deepEqual(assertCliJsonSuccess(result), { ok: true, command: "fixture" });
  });

  it("parses noisy pack JSON and rejects unsafe files", async () => {
    const { assertPackSafety, getPackFilePaths, parsePackJson } = await import("../dist/testing/index.js");
    const entry = parsePackJson('ignored lifecycle text\n[{"files":[{"path":"package/dist/index.js"},{"path":"package/README.md"},{"path":"package/LICENSE"},{"path":"package/package.json"}]}]');

    assert.deepEqual(getPackFilePaths(entry), ["LICENSE", "README.md", "dist/index.js", "package.json"]);
    assert.deepEqual(assertPackSafety(entry), ["LICENSE", "README.md", "dist/index.js", "package.json"]);
    assert.throws(
      () => assertPackSafety(parsePackJson('[{"files":[{"path":"src/index.ts"},{"path":"README.md"},{"path":"LICENSE"},{"path":"package.json"}]}]')),
      /Unsafe: src\/index\.ts/
    );
  });
});
