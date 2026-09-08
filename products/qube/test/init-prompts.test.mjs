import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGuidedPresenter } from "@tjalve/qube-cli/guided";

import {
  collectGitIdentityPromptActions,
} from "../dist/init_prompts.js";

const interactiveTerminal = Object.freeze({
  stdinIsTTY: true,
  stdoutIsTTY: true,
  stderrIsTTY: true,
  ci: false,
  jsonMode: false,
  noColor: true,
  colorLevel: 0,
  color: false,
  interactive: true,
  progress: false,
  dynamic: false,
});

const missingIdentity = Object.freeze([
  Object.freeze({ key: "user.name", label: "Git author name" }),
  Object.freeze({ key: "user.email", label: "Git author email" }),
]);

function promptAdapter(answers) {
  const queue = [...answers];
  const calls = [];
  return {
    calls,
    adapter: {
      async text(options) {
        calls.push(["text", options]);
        return queue.shift();
      },
      async select(options) {
        calls.push(["select", options]);
        return queue.shift();
      },
      async confirm(options) {
        calls.push(["confirm", options]);
        return queue.shift();
      },
      isCancel(value) {
        return typeof value === "symbol";
      },
      spinner() {
        return { start() {}, stop() {}, error() {} };
      },
    },
  };
}

function presenterFor(answers, outputs = []) {
  const prompts = promptAdapter(answers);
  return {
    prompts,
    presenter: createGuidedPresenter({
      prompts: prompts.adapter,
      output: message => outputs.push(message),
      gate: { terminal: interactiveTerminal },
    }),
  };
}

describe("QUBE init prompts", () => {
  it("retries an invalid Git identity value and returns the confirmed actions", async () => {
    const outputs = [];
    const { presenter, prompts } = presenterFor([
      "repository",
      " \t ",
      " Ada Lovelace ",
      "ada@example.test",
      true,
    ], outputs);

    const actions = await collectGitIdentityPromptActions(presenter, missingIdentity);

    assert.deepEqual(actions, [
      { key: "user.name", scope: "repository", value: "Ada Lovelace" },
      { key: "user.email", scope: "repository", value: "ada@example.test" },
    ]);
    const scopeCall = prompts.calls.find(([kind]) => kind === "select");
    assert.deepEqual(scopeCall[1].options.map(option => option.label), [
      "This repository (recommended)",
      "All repositories",
    ]);
    assert.equal(prompts.calls.filter(([kind]) => kind === "text").length, 3);
    assert.match(outputs.join("\n"), /Git author name must be non-empty/u);
  });

  it("stops Git identity collection when the user cancels any prompt", async () => {
    const cases = [
      [Symbol("scope")],
      ["repository", Symbol("name")],
      ["repository", "Ada Lovelace", "ada@example.test", Symbol("confirm")],
    ];

    for (const answers of cases) {
      const { presenter } = presenterFor(answers);
      await assert.rejects(
        collectGitIdentityPromptActions(presenter, missingIdentity),
        error => error?.name === "CliError"
          && error.kind === "prompt-cancelled"
          && error.likelyCause === "The guided interaction was cancelled."
          && error.suggestedNextAction === "Rerun qube init and answer the prompt, or provide explicit non-interactive options.",
      );
    }
  });
});
