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

describe("installer choice helpers", () => {
  it("defines, validates, and renders reusable installer choices", async () => {
    const { defineInstallerChoice, defineInstallerChoiceGroup, renderInstallerChoices } = await import("../dist/index.js");

    const choices = [
      defineInstallerChoice({
        value: "local",
        label: "Project-local",
        description: "Install into the current project.",
        recommended: true
      }),
      defineInstallerChoice({
        value: "global",
        label: "Global manual",
        description: "Install for a user shell."
      })
    ];
    const group = defineInstallerChoiceGroup({
      name: "scope",
      message: "How should this package be installed?",
      choices,
      defaultValue: "local"
    });

    assert.equal(group.defaultValue, "local");
    assert.equal(
      renderInstallerChoices(choices),
      "* local: Project-local - Install into the current project.\n- global: Global manual - Install for a user shell.\n"
    );
  });

  it("resolves explicit and default installer choices without prompting", async () => {
    const { promptInstallerChoice } = await import("../dist/index.js");
    const choices = [
      { value: "pnpm", label: "pnpm", recommended: true },
      { value: "npm", label: "npm" }
    ];

    assert.equal(await promptInstallerChoice({ message: "Package manager?", choices, value: "npm" }), "npm");
    assert.equal(
      await promptInstallerChoice({
        message: "Package manager?",
        choices,
        defaultValue: "pnpm",
        yes: true,
        terminal: nonTtyTerminal
      }),
      "pnpm"
    );
  });

  it("rejects invalid selections and duplicate choice values", async () => {
    const { promptInstallerChoice, validateInstallerChoices } = await import("../dist/index.js");

    assert.throws(
      () => validateInstallerChoices([
        { value: "local", label: "Local" },
        { value: "local", label: "Local again" }
      ]),
      /duplicate value "local"/
    );

    await assert.rejects(
      () => promptInstallerChoice({
        command: "install",
        promptName: "package manager",
        message: "Package manager?",
        choices: [{ value: "pnpm", label: "pnpm" }],
        value: "npm"
      }),
      error => {
        assert.equal(error.command, "install");
        assert.equal(error.operation, "validate package manager");
        assert.equal(error.likelyCause, 'Unsupported choice "npm".');
        return true;
      }
    );
  });

  it("blocks missing installer choices in automation when no default is allowed", async () => {
    const { promptInstallerChoice } = await import("../dist/index.js");

    await assert.rejects(
      () => promptInstallerChoice({
        command: "install",
        promptName: "install scope",
        message: "Install scope?",
        choices: [{ value: "local", label: "Local" }],
        terminal: nonTtyTerminal
      }),
      /prompt install scope: Prompts are disabled when stdin or stdout is not a TTY\./
    );
  });
});
