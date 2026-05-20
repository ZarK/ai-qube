import { describe, it } from "node:test";
import assert from "node:assert/strict";

const interactiveTerminal = Object.freeze({
  stdinIsTTY: true,
  stdoutIsTTY: true,
  stderrIsTTY: true,
  ci: false,
  jsonMode: false,
  noColor: false,
  colorLevel: 1,
  color: true,
  interactive: true,
  progress: true,
  dynamic: true
});

const nonTtyTerminal = Object.freeze({
  ...interactiveTerminal,
  stdoutIsTTY: false,
  colorLevel: 0,
  color: false,
  interactive: false,
  progress: false,
  dynamic: false
});

describe("prompt helpers", () => {
  it("blocks prompts in JSON, CI, non-TTY, and explicit non-interactive modes", async () => {
    const { evaluatePromptGate } = await import("../dist/index.js");

    assert.deepEqual(evaluatePromptGate({ jsonMode: true }), {
      allowed: false,
      reason: "json",
      message: "Prompts are disabled in JSON output mode."
    });
    assert.equal(evaluatePromptGate({ terminal: { ...interactiveTerminal, ci: true, interactive: false } }).reason, "ci");
    assert.equal(evaluatePromptGate({ terminal: nonTtyTerminal }).reason, "non-tty");
    assert.equal(evaluatePromptGate({ nonInteractive: true, terminal: interactiveTerminal }).reason, "non-interactive");
    assert.equal(evaluatePromptGate({ command: { kind: "command", name: "cache inspect", description: "Inspect cache.", interactions: { ttyPrompt: false } }, terminal: interactiveTerminal }).reason, "tty-prompt-disabled");
  });

  it("uses supplied values or deterministic defaults without invoking prompts", async () => {
    const { resolvePromptValue } = await import("../dist/index.js");
    let invoked = false;

    assert.equal(await resolvePromptValue({ value: "flag-value", prompt: () => { invoked = true; return "prompted"; } }), "flag-value");
    assert.equal(invoked, false);
    assert.equal(await resolvePromptValue({ terminal: nonTtyTerminal, defaults: true, defaultValue: "default-value", prompt: () => { invoked = true; return "prompted"; } }), "default-value");
    assert.equal(invoked, false);
  });

  it("exposes Clack-backed prompt wrappers with the same gating behavior", async () => {
    const { promptText, promptConfirm } = await import("../dist/index.js");

    assert.equal(await promptText({ value: "flag-value", clack: { message: "Cache value?" } }), "flag-value");
    assert.equal(await promptConfirm({ terminal: nonTtyTerminal, defaultValue: true, clack: { message: "Continue?" } }), true);
  });

  it("throws structured prompt-blocked errors when no equivalent value exists", async () => {
    const { resolvePromptValue } = await import("../dist/index.js");

    await assert.rejects(
      () => resolvePromptValue({ command: "cache prompt", terminal: nonTtyTerminal, promptName: "cache value", prompt: () => "prompted" }),
      /prompt cache value: Prompts are disabled when stdin or stdout is not a TTY\./
    );
  });
});
