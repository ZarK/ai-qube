import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
  dynamic: false
});

function promptAdapter(answers = []) {
  const queue = [...answers];
  const calls = [];
  const progress = [];
  return {
    calls,
    progress,
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
        return {
          start(message) { progress.push(["start", message]); },
          stop(message) { progress.push(["stop", message]); },
          error(message) { progress.push(["error", message]); }
        };
      }
    }
  };
}

describe("guided interaction presenter", () => {
  it("renders the complete safe question model and redacts accidental tokens", async () => {
    const { defineGuidedQuestion, renderGuidedQuestion } = await import("../dist/guided/index.js");
    const question = defineGuidedQuestion({
      section: { number: 2, title: "Publishing identity" },
      label: "App ID",
      explanation: "Use the numeric App ID, not the Client ID.",
      recommendation: { value: "123", reason: "Keep the verified repository value." },
      documentation: { label: "GitHub App settings", url: "https://example.test/app" },
      currentValue: "123",
      valueSource: "repository config",
      applicability: { applies: true },
      validation: { state: "valid", message: "Numeric App ID." },
      answerSource: "current"
    });

    assert.equal(renderGuidedQuestion(question), [
      "2. Publishing identity",
      "App ID",
      "Use the numeric App ID, not the Client ID.",
      "Recommended: 123",
      "Why: Keep the verified repository value.",
      "Documentation: GitHub App settings (https://example.test/app)",
      "Current value: 123",
      "Value source: repository config",
      "Validation: valid - Numeric App ID.",
      "Answer source: current",
      ""
    ].join("\n"));
  });

  it("presents named choices and retries validation at the affected question", async () => {
    const outputs = [];
    const prompts = promptAdapter(["client-id", "app-id"]);
    const { createGuidedPresenter } = await import("../dist/guided/index.js");
    const presenter = createGuidedPresenter({
      output: message => outputs.push(message),
      prompts: prompts.adapter,
      gate: { terminal: interactiveTerminal }
    });
    const result = await presenter.choose({
      section: { number: 1, title: "Application" },
      label: "Application identifier",
      explanation: "Choose the identifier QUBE should use.",
      recommendation: { value: "app-id", reason: "The App ID is required for signing." },
      validation: {
        check: value => value === "client-id" ? "That looks like a Client ID." : undefined
      }
    }, [
      { value: "app-id", label: "App ID", recommended: true },
      { value: "client-id", label: "Client ID", description: "Not valid for signing." }
    ]);

    assert.deepEqual(result, { status: "answered", value: "app-id", source: "prompt" });
    assert.equal(prompts.calls.length, 2);
    assert.deepEqual(prompts.calls[0][1].options.map(option => option.label), ["App ID (recommended)", "Client ID"]);
    assert.match(outputs[1], /^Action: Answer Application identifier\nReason: That looks like a Client ID\.\nNext action:/);
  });

  it("returns cancellation and non-applicability as explicit no-write outcomes", async () => {
    const prompts = promptAdapter([Symbol("cancel")]);
    const { createGuidedPresenter } = await import("../dist/guided/index.js");
    const presenter = createGuidedPresenter({ prompts: prompts.adapter, output: () => {}, gate: { terminal: interactiveTerminal } });
    const question = {
      section: { number: 1, title: "Credentials" },
      label: "Key reference",
      explanation: "Choose a safe key reference."
    };

    assert.deepEqual(await presenter.askText(question), {
      status: "cancelled",
      reason: "The guided interaction was cancelled.",
      writeAllowed: false
    });
    assert.deepEqual(await presenter.askText({
      ...question,
      applicability: { applies: false, reason: "The current-account publisher does not use an App key." }
    }), {
      status: "skipped",
      reason: "The current-account publisher does not use an App key.",
      writeAllowed: false
    });
  });

  it("preserves valid current values without prompting", async () => {
    const prompts = promptAdapter([]);
    const { createGuidedPresenter } = await import("../dist/guided/index.js");
    const presenter = createGuidedPresenter({ prompts: prompts.adapter, output: () => {} });
    const result = await presenter.askText({
      section: { number: 1, title: "Application" },
      label: "App ID",
      explanation: "Use the existing verified App ID.",
      currentValue: "123",
      valueSource: "user-global config",
      validation: { state: "valid" },
      answerSource: "current"
    });

    assert.deepEqual(result, { status: "answered", value: "123", source: "current" });
    assert.equal(prompts.calls.length, 0);
  });

  it("supports confirmation and visible progress", async () => {
    const prompts = promptAdapter([true]);
    const { createGuidedPresenter } = await import("../dist/guided/index.js");
    const presenter = createGuidedPresenter({ prompts: prompts.adapter, output: () => {}, gate: { terminal: interactiveTerminal } });
    const confirmation = await presenter.confirm({
      section: { number: 3, title: "Apply" },
      label: "Write user-global config?",
      explanation: "This writes only the selected config layer.",
      recommendation: { value: true, reason: "The plan contains only public identifiers and secret references." }
    });
    const result = await presenter.progress({ action: "Verify publisher", success: "Publisher verified" }, async () => 42);

    assert.deepEqual(confirmation, { status: "answered", value: true, source: "prompt" });
    assert.equal(result, 42);
    assert.deepEqual(prompts.progress, [["start", "Verify publisher"], ["stop", "Publisher verified"]]);
  });

  it("renders compact summaries and Action/Reason/Next action failures", async () => {
    const outputs = [];
    const { createGuidedPresenter, renderGuidedFailure } = await import("../dist/guided/index.js");
    const presenter = createGuidedPresenter({ output: message => outputs.push(message) });
    presenter.summarize({
      scope: "user-global",
      decisions: [{ label: "Private key", value: "QUBE_REVIEWER_KEY", reason: "Environment references are portable.", source: "prompt" }],
      applied: "changed",
      readiness: "ready",
      nextAction: "Run review doctor in the target repository."
    });
    presenter.fail({ action: "Verify publisher", reason: "The installation cannot access this repository.", nextAction: "Install the App for this repository." });

    assert.match(outputs[0], /Scope: user-global[\s\S]*Applied: changed[\s\S]*Readiness: ready[\s\S]*Next action:/);
    assert.equal(outputs[1], renderGuidedFailure({
      action: "Verify publisher",
      reason: "The installation cannot access this repository.",
      nextAction: "Install the App for this repository."
    }));
  });
});
