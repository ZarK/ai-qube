import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("terminal helpers", () => {
  it("detects non-interactive JSON and CI capabilities", async () => {
    const { detectTerminalCapabilities } = await import("../dist/index.js");

    assert.deepEqual(detectTerminalCapabilities({ argv: ["--json"], env: {}, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true }), {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
      ci: false,
      jsonMode: true,
      noColor: true,
      colorLevel: 0,
      color: false,
      interactive: false,
      progress: false,
      dynamic: false
    });
    assert.equal(detectTerminalCapabilities({ env: { CI: "true" }, stdinIsTTY: true, stdoutIsTTY: true }).interactive, false);
  });

  it("honors no-color and force-color conventions", async () => {
    const { detectTerminalCapabilities, formatStatus, stripAnsi } = await import("../dist/index.js");

    assert.equal(detectTerminalCapabilities({ env: { NO_COLOR: "1", FORCE_COLOR: "3" }, stdoutIsTTY: true }).colorLevel, 0);
    assert.equal(detectTerminalCapabilities({ env: { FORCE_COLOR: "2" }, stdoutIsTTY: false }).colorLevel, 2);
    assert.equal(detectTerminalCapabilities({ env: { FORCE_COLOR: "0" }, stdoutIsTTY: true }).color, false);
    assert.equal(formatStatus("success", "done", detectTerminalCapabilities({ env: {}, stdoutIsTTY: false })), "[OK] done");
    assert.equal(stripAnsi(formatStatus("error", "failed", detectTerminalCapabilities({ env: { FORCE_COLOR: "1" }, stdoutIsTTY: false }))), "✖ failed");
  });
});
