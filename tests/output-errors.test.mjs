import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("output and error helpers", () => {
  it("creates stable JSON success envelopes with consumer fields", async () => {
    const { createJsonSuccessEnvelope, renderJsonSuccess } = await import("../dist/index.js");

    assert.deepEqual(createJsonSuccessEnvelope("cache inspect", { zeta: 2, alpha: 1 }), {
      ok: true,
      command: "cache inspect",
      alpha: 1,
      zeta: 2
    });
    assert.equal(renderJsonSuccess("cache inspect", { key: "alpha" }), '{"ok":true,"command":"cache inspect","key":"alpha"}\n');
    assert.throws(() => createJsonSuccessEnvelope("cache inspect", { ok: true }), /reserved field "ok"/);
  });

  it("rejects values that cannot render as valid JSON", async () => {
    const { renderJsonLine } = await import("../dist/index.js");

    assert.throws(() => renderJsonLine(undefined), /must be serializable as valid JSON/);
    assert.throws(() => renderJsonLine(() => undefined), /must be serializable as valid JSON/);
    assert.throws(() => renderJsonLine(Symbol("fixture")), /must be serializable as valid JSON/);
  });

  it("renders structured CLI errors for JSON and human output", async () => {
    const { createCliError, exitCodeForCategory, renderCliErrorText, renderJsonError } = await import("../dist/index.js");
    const error = createCliError({
      command: "cache validate",
      kind: "cache-config-invalid",
      operation: "validate cache configuration",
      likelyCause: "The cache configuration is missing.",
      suggestedNextAction: "Create the cache configuration.",
      category: "validation"
    });

    assert.equal(error.exitCode, 3);
    assert.equal(exitCodeForCategory("success"), 0);
    assert.equal(exitCodeForCategory("usage"), 2);
    assert.equal(exitCodeForCategory("validation"), 3);
    assert.equal(exitCodeForCategory("external"), 4);
    assert.equal(exitCodeForCategory("safety"), 5);
    assert.equal(exitCodeForCategory("unexpected"), 70);
    assert.deepEqual(JSON.parse(renderJsonError(error)), {
      ok: false,
      command: "cache validate",
      error: {
        kind: "cache-config-invalid",
        operation: "validate cache configuration",
        likelyCause: "The cache configuration is missing.",
        suggestedNextAction: "Create the cache configuration.",
        category: "validation",
        exitCode: 3
      }
    });
    assert.match(renderCliErrorText(error), /Suggested next action: Create the cache configuration\./);
  });
});
