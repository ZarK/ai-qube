import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GUIDED_INIT_DOCS_BASE_URL,
  GUIDED_INIT_NO_BACKUP,
  GUIDED_INIT_UNPINNED_MODEL,
  buildGuidedInitAnswerSummary,
  buildGuidedInitQuestions,
  normalizeGuidedInitAnswers,
  sortReviewModels,
  validateGuidedInitQuestions,
} from "../dist/init_questions.js";

const capabilities = Object.freeze({
  agentHarnesses: Object.freeze([
    Object.freeze({
      value: "codex",
      label: "Codex",
      recommended: true,
      canRunPrimaryReview: true,
      canRunSeparateReview: true,
      reviewModels: Object.freeze({
        kind: "live",
        models: Object.freeze([
          Object.freeze({ value: "gpt-5.6", label: "GPT-5.6", recommended: true }),
          Object.freeze({ value: "gpt-5.6-mini", label: "GPT-5.6 mini" }),
        ]),
      }),
    }),
    Object.freeze({
      value: "claude-code",
      label: "Claude Code",
      canRunPrimaryReview: true,
      canRunSeparateReview: true,
      reviewModels: Object.freeze({
        kind: "unpinned",
        label: "Claude Code default (not pinned)",
        reason: "Claude Code does not provide a live model list, so QUBE leaves its review model unpinned.",
      }),
    }),
    Object.freeze({
      value: "cursor",
      label: "Cursor",
      available: false,
      canRunPrimaryReview: false,
      canRunSeparateReview: false,
      reviewModels: Object.freeze({ kind: "unavailable", reason: "Review is unavailable." }),
    }),
  ]),
  issueTrackers: Object.freeze([
    Object.freeze({ value: "github", label: "GitHub", recommended: true, supportsContinuousShipping: true }),
    Object.freeze({ value: "gitlab", label: "GitLab", supportsContinuousShipping: false }),
  ]),
  automatedChecks: Object.freeze([
    Object.freeze({ value: "github", label: "GitHub Actions", forIssueTrackers: Object.freeze(["github"]) }),
    Object.freeze({ value: "gitlab", label: "GitLab CI", forIssueTrackers: Object.freeze(["gitlab"]) }),
    Object.freeze({ value: "jenkins", label: "Jenkins" }),
  ]),
  umpireScopes: Object.freeze([
    Object.freeze({ value: "ready", label: "Ready issues only", recommended: true }),
    Object.freeze({ value: "standard", label: "Standard post-queue work" }),
    Object.freeze({ value: "custom", label: "Custom set" }),
  ]),
  qualityStages: Object.freeze([
    Object.freeze({ value: "unit", label: "Unit", recommended: true }),
    Object.freeze({ value: "security", label: "Security" }),
  ]),
  externalReviewers: Object.freeze([
    Object.freeze({
      value: "coderabbit",
      label: "CodeRabbit",
      recommended: true,
      forIssueTrackers: Object.freeze(["github"]),
    }),
  ]),
  reviewPublishers: Object.freeze([
    Object.freeze({ value: "user", label: "Current GitHub account", recommended: true, forIssueTrackers: Object.freeze(["github"]) }),
    Object.freeze({ value: "github-app", label: "QUBE Reviewer App", forIssueTrackers: Object.freeze(["github"]) }),
  ]),
});

const completeHarnessAnswers = Object.freeze({
  agentHarnesses: Object.freeze(["codex", "claude-code"]),
  issueTracker: "github",
  automatedChecks: "github",
  continuousShipping: true,
  umpireScope: "ready",
  qualityStages: Object.freeze(["unit"]),
  reviewSource: "harness",
  reviewHarness: "claude-code",
  reviewModel: null,
  reviewBackupHarness: null,
  reviewPublisher: "user",
});

describe("guided QUBE init questions", () => {
  it("shows disabled CI choices, rejects attempts, and recommends a working choice", () => {
    const reason = "Jenkins CI is not available in the Executor workflow yet. Use GitHub or GitLab CI.";
    const limited = {
      ...capabilities,
      automatedChecks: capabilities.automatedChecks.map(choice => choice.value === "jenkins"
        ? { ...choice, disabled: true, recommended: true, description: reason }
        : choice),
    };
    const questions = buildGuidedInitQuestions({ capabilities: limited, answers: { issueTracker: "github" } });
    const checks = questions.find(question => question.id === "automated-checks");
    assert.equal(checks.options.find(choice => choice.value === "jenkins").disabled, true);
    assert.equal(checks.recommendedValue, "github");
    const rejected = normalizeGuidedInitAnswers({
      capabilities: limited,
      answers: { ...completeHarnessAnswers, automatedChecks: "jenkins" },
    });
    assert.equal(rejected.validation.ok, false);
    assert.ok(rejected.validation.errors.some(error => error.message.includes(reason)));
    const supported = normalizeGuidedInitAnswers({ capabilities: limited, answers: completeHarnessAnswers });
    assert.equal(supported.validation.ok, true);
  });

  it("explains unavailable separate review while keeping native host review usable", () => {
    const reason = "Claude Code isolated review is not available yet. Use native host review.";
    const limited = {
      ...capabilities,
      agentHarnesses: capabilities.agentHarnesses.map(choice => choice.value === "claude-code"
        ? { ...choice, canRunSeparateReview: false, separateReviewUnavailableReason: reason }
        : choice.value === "cursor"
          ? { ...choice, available: true, canRunSeparateReview: true }
          : choice),
    };
    const questions = buildGuidedInitQuestions({
      capabilities: limited,
      answers: { ...completeHarnessAnswers, agentHarnesses: ["codex", "claude-code", "cursor"] },
    });
    const review = questions.find(question => question.id === "review-harness");
    assert.equal(review.options.find(choice => choice.value === "claude-code").disabled, true);
    assert.match(review.validationError, /Claude Code isolated review is not available yet/);
    assert.equal(review.recommendedValue, "cursor");
    const native = normalizeGuidedInitAnswers({
      capabilities: limited,
      answers: { ...completeHarnessAnswers, agentHarnesses: ["claude-code"], reviewSource: "primary" },
    });
    assert.equal(native.validation.ok, true);
    assert.equal(native.answers.reviewSource, "primary");
    const backup = buildGuidedInitQuestions({
      capabilities: limited,
      answers: { agentHarnesses: ["claude-code", "codex"], issueTracker: "github", reviewSource: "harness", reviewHarness: "codex" },
    }).find(question => question.id === "review-backup-harness");
    assert.equal(backup.selectedValue, GUIDED_INIT_NO_BACKUP);
    assert.equal(backup.promptNeeded, false);
  });

  it("keeps the public question order and complete guidance metadata", () => {
    const questions = buildGuidedInitQuestions({ capabilities, answers: completeHarnessAnswers });

    assert.deepEqual(questions.map(question => question.id), [
      "agent-harnesses",
      "issue-tracker",
      "automated-checks",
      "continuous-shipping",
      "umpire-scope",
      "quality-checks",
      "review-source",
      "external-reviewer",
      "review-harness",
      "review-model",
      "review-backup-harness",
      "review-backup-model",
      "review-backup-effort",
      "review-publisher",
    ]);
    assert.deepEqual(questions.map(question => question.step), [1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 8, 8, 8]);
    for (const question of questions) {
      assert.ok(question.explanation.length > 20, question.id);
      assert.ok(question.recommendationReason.length > 20, question.id);
      assert.match(question.docsUrl, new RegExp(`^${escapeRegExp(GUIDED_INIT_DOCS_BASE_URL)}#`), question.id);
      assert.doesNotMatch(`${question.prompt} ${question.explanation} ${question.recommendationReason}`, /host surface|model routing|review tier|Generic terminal/i);
    }
    assert.equal(questions.find(question => question.id === "external-reviewer").applicable, false);
    assert.equal(questions.find(question => question.id === "review-harness").applicable, true);
    assert.equal(questions.find(question => question.id === "review-model").answerLabel, "Claude Code default (not pinned)");
    assert.equal(questions.find(question => question.id === "review-backup-harness").answerLabel, "None");
  });

  it("filters unavailable capabilities and exposes only supported review sources", () => {
    const questions = buildGuidedInitQuestions({
      capabilities,
      answers: {
        agentHarnesses: ["codex"],
        issueTracker: "gitlab",
      },
    });

    assert.deepEqual(
      questions.find(question => question.id === "agent-harnesses").options.map(option => option.value),
      ["codex", "claude-code"],
    );
    assert.deepEqual(
      questions.find(question => question.id === "automated-checks").options.map(option => option.value),
      ["gitlab", "jenkins"],
    );
    assert.deepEqual(
      questions.find(question => question.id === "review-source").options.map(option => option.value),
      ["primary"],
    );
    assert.equal(questions.find(question => question.id === "review-source").answeredBy, "automatic");
    assert.equal(questions.find(question => question.id === "review-publisher").applicable, false);
  });

  it("uses only the Umpire scopes supplied by the runtime capability", () => {
    const scopedCapabilities = {
      ...capabilities,
      umpireScopes: [
        { value: "ready", label: "Ready queue", recommended: true },
        { value: "custom", label: "Repository selection", available: false },
      ],
    };
    const questions = buildGuidedInitQuestions({
      capabilities: scopedCapabilities,
      answers: { ...completeHarnessAnswers, umpireScope: "standard" },
    });
    const umpire = questions.find(question => question.id === "umpire-scope");

    assert.deepEqual(umpire.options.map(option => [option.value, option.label]), [["ready", "Ready queue"]]);
    assert.equal(umpire.recommendedValue, "ready");
    assert.equal(umpire.promptNeeded, true);
    assert.match(umpire.validationError, /unavailable choice: standard/);
  });

  it("uses only live model choices and rejects a free-text model value", () => {
    const questions = buildGuidedInitQuestions({
      capabilities,
      answers: {
        ...completeHarnessAnswers,
        reviewSource: "primary",
        reviewHarness: undefined,
        reviewModel: "invented-model",
      },
    });
    const model = questions.find(question => question.id === "review-model");

    assert.deepEqual(model.options.map(option => option.value), ["gpt-5.6", "gpt-5.6-mini"]);
    assert.equal(model.options.some(option => option.value === GUIDED_INIT_UNPINNED_MODEL), false);
    assert.equal(model.options[0].recommended, true);
    assert.equal(model.options[1].recommended, false);
    assert.equal(model.recommendedValue, "gpt-5.6");
    assert.equal(model.promptNeeded, true);
    assert.match(model.validationError, /unavailable choice: invented-model/);
    const validation = validateGuidedInitQuestions(questions);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some(error => error.questionId === "review-model"));
  });

  it("maps the unpinned model path to a null normalized model", () => {
    const result = normalizeGuidedInitAnswers({ capabilities, answers: completeHarnessAnswers });

    assert.equal(result.validation.ok, true);
    assert.deepEqual(result.answers, completeHarnessAnswers);
    assert.equal(result.answers.reviewModel, null);
    const modelSummary = result.summary.find(answer => answer.id === "review-model");
    assert.equal(modelSummary.value, GUIDED_INIT_UNPINNED_MODEL);
    assert.equal(modelSummary.answer, "Claude Code default (not pinned)");
  });

  it("turns Continuous Shipping off when the issue tracker cannot continue lifecycle work", () => {
    const questions = buildGuidedInitQuestions({
      capabilities,
      answers: {
        agentHarnesses: ["codex"],
        issueTracker: "gitlab",
        continuousShipping: true,
      },
    });
    const shipping = questions.find(question => question.id === "continuous-shipping");

    assert.deepEqual(shipping.options.map(option => option.value), ["off"]);
    assert.equal(shipping.recommendedValue, "off");
    assert.equal(shipping.promptNeeded, true);
    assert.match(shipping.validationError, /unavailable choice: on/);
  });

  it("reports a configured model pin when the chosen harness catalog is unavailable", () => {
    const unavailableCapabilities = {
      ...capabilities,
      agentHarnesses: capabilities.agentHarnesses.map(harness => harness.value === "codex"
        ? {
            ...harness,
            reviewModels: { kind: "unavailable", reason: "The live model list is unavailable." },
          }
        : harness),
    };
    const current = {
      ...completeHarnessAnswers,
      agentHarnesses: ["codex"],
      reviewSource: "primary",
      reviewHarness: undefined,
      reviewModel: "gpt-5.6",
    };
    const questions = buildGuidedInitQuestions({ capabilities: unavailableCapabilities, current });
    const model = questions.find(question => question.id === "review-model");

    assert.equal(model.applicable, true);
    assert.deepEqual(model.options, []);
    assert.equal(model.promptNeeded, false);
    assert.match(model.validationError, /live model list is unavailable/);

    const unpinned = buildGuidedInitQuestions({
      capabilities: unavailableCapabilities,
      current: { ...current, reviewModel: null },
    }).find(question => question.id === "review-model");
    assert.equal(unpinned.applicable, true);
    assert.equal(unpinned.promptNeeded, false);
    assert.match(unpinned.validationError, /live model list is unavailable/);
  });

  it("stops when a selected review harness cannot provide its live model list", () => {
    const unavailableCapabilities = {
      ...capabilities,
      agentHarnesses: capabilities.agentHarnesses.map(harness => harness.value === "codex"
        ? { ...harness, reviewModels: { kind: "unavailable", reason: "The provider catalog could not be reached." } }
        : harness),
    };
    const result = normalizeGuidedInitAnswers({
      capabilities: unavailableCapabilities,
      defaults: { ...completeHarnessAnswers, agentHarnesses: ["codex"], reviewSource: "primary" },
      resolveDefaults: true,
    });

    assert.equal(result.validation.ok, false);
    assert.match(result.validation.errors.find(error => error.questionId === "review-model")?.message, /provider catalog could not be reached/);
  });

  it("reports when no Review source matches the selected harness and tracker", () => {
    const cursor = {
      value: "cursor",
      label: "Cursor",
      canRunPrimaryReview: false,
      canRunSeparateReview: false,
      reviewModels: { kind: "live", models: [] },
    };
    const noReviewCapabilities = {
      ...capabilities,
      agentHarnesses: [cursor],
    };
    const questions = buildGuidedInitQuestions({
      capabilities: noReviewCapabilities,
      answers: { agentHarnesses: ["cursor"], issueTracker: "gitlab" },
    });
    const review = questions.find(question => question.id === "review-source");

    assert.deepEqual(review.options, []);
    assert.equal(review.promptNeeded, false);
    assert.match(review.validationError, /no available Review source/);
  });

  it("shows the external-service branch without harness or model questions", () => {
    const result = normalizeGuidedInitAnswers({
      capabilities,
      answers: {
        agentHarnesses: ["codex"],
        issueTracker: "github",
        automatedChecks: "github",
        continuousShipping: false,
        umpireScope: "standard",
        qualityStages: ["unit", "security"],
        reviewSource: "external",
        externalReviewers: ["coderabbit"],
        reviewPublisher: "github-app",
      },
    });

    assert.equal(result.validation.ok, true);
    assert.deepEqual(result.answers.externalReviewers, ["coderabbit"]);
    assert.equal(Object.hasOwn(result.answers, "reviewHarness"), false);
    assert.equal(Object.hasOwn(result.answers, "reviewModel"), false);
    assert.equal(result.questions.find(question => question.id === "external-reviewer").applicable, true);
    assert.equal(result.questions.find(question => question.id === "review-harness").applicable, false);
    assert.equal(result.questions.find(question => question.id === "review-model").applicable, false);
  });

  it("preserves a complete current setup without asking again", () => {
    const questions = buildGuidedInitQuestions({ capabilities, current: completeHarnessAnswers });

    assert.deepEqual(
      questions.filter(question => question.applicable && question.promptNeeded).map(question => question.id),
      [],
    );
    for (const question of questions.filter(question => question.applicable)) {
      assert.equal(question.answeredBy, "current", question.id);
      assert.equal(question.reason, "The current valid setup is preserved.", question.id);
      assert.deepEqual(question.preselectedValue, question.currentValue, question.id);
    }
    assert.equal(buildGuidedInitAnswerSummary(questions).length, 11);
  });

  it("asks for editable saved values and keeps each saved value preselected", () => {
    const questions = buildGuidedInitQuestions({
      capabilities,
      current: completeHarnessAnswers,
      promptCurrent: true,
    });
    const applicable = questions.filter(question => question.applicable);

    assert.ok(applicable.some(question => question.promptNeeded));
    for (const question of applicable) {
      assert.equal(question.answeredBy, "current", question.id);
      assert.deepEqual(question.preselectedValue, question.currentValue, question.id);
      const enabledChoices = question.options.filter(option => !option.disabled);
      assert.equal(question.promptNeeded, enabledChoices.length > 1, question.id);
    }
  });

  it("does not ask again for an explicit answer during interactive init", () => {
    const questions = buildGuidedInitQuestions({
      capabilities,
      answers: { issueTracker: "gitlab" },
      current: completeHarnessAnswers,
      promptCurrent: true,
    });
    const tracker = questions.find(question => question.id === "issue-tracker");

    assert.equal(tracker.answeredBy, "answer");
    assert.equal(tracker.selectedValue, "gitlab");
    assert.equal(tracker.promptNeeded, false);
  });

  it("requires a new choice when a saved model is absent from the live list", () => {
    const cursorCapabilities = {
      ...capabilities,
      agentHarnesses: [{
        value: "cursor",
        label: "Cursor",
        canRunPrimaryReview: true,
        canRunSeparateReview: true,
        reviewModels: {
          kind: "live",
          models: [{ value: "cursor-grok-4.6-high-fast", label: "Grok 4.6 high fast" }],
        },
      }],
    };
    const questions = buildGuidedInitQuestions({
      capabilities: cursorCapabilities,
      current: {
        ...completeHarnessAnswers,
        agentHarnesses: ["cursor"],
        reviewSource: "primary",
        reviewHarness: undefined,
        reviewModel: "cursor-grok-4.6-medium-fast",
      },
      promptCurrent: true,
    });
    const model = questions.find(question => question.id === "review-model");

    assert.deepEqual(model.options.map(option => option.value), ["cursor-grok-4.6-high-fast"]);
    assert.equal(model.currentValue, null);
    assert.equal(model.selectedValue, null);
    assert.equal(model.promptNeeded, true);
    assert.match(model.validationError, /current value selects unavailable choice: cursor-grok-4\.6-medium-fast/);
  });

  it("resolves noninteractive defaults through the same question model", () => {
    const result = normalizeGuidedInitAnswers({
      capabilities,
      defaults: completeHarnessAnswers,
      resolveDefaults: true,
    });

    assert.equal(result.validation.ok, true);
    assert.deepEqual(result.answers, completeHarnessAnswers);
    assert.deepEqual(result.validation.unresolvedQuestionIds, []);
    assert.ok(result.questions.filter(question => question.applicable).every(question => question.answeredBy === "default"));
  });

  it("reports an unavailable current capability as a conflict that needs an answer", () => {
    const questions = buildGuidedInitQuestions({
      capabilities,
      current: { ...completeHarnessAnswers, agentHarnesses: ["cursor"] },
    });
    const harnesses = questions.find(question => question.id === "agent-harnesses");

    assert.equal(harnesses.currentValue, null);
    assert.equal(harnesses.promptNeeded, true);
    assert.match(harnesses.validationError, /current value includes unavailable choice: cursor/);
  });

  it("puts native model IDs first and sorts both groups", () => {
    const choices = [
      { value: "zeta/model", label: "Zeta" },
      { value: "composer-2", label: "Composer 2" },
      { value: "alpha/model", label: "Alpha" },
      { value: "cursor-grok-4.6", label: "Grok" },
    ];

    assert.deepEqual(sortReviewModels("cursor", choices).map(choice => choice.value), [
      "composer-2",
      "cursor-grok-4.6",
      "alpha/model",
      "zeta/model",
    ]);
    assert.deepEqual(sortReviewModels("codex", [
      { value: "vendor/model", label: "Vendor" },
      { value: "o3", label: "o3" },
      { value: "gpt-5.6", label: "GPT" },
    ]).map(choice => choice.value), ["gpt-5.6", "o3", "vendor/model"]);
    assert.deepEqual(choices.map(choice => choice.value), ["zeta/model", "composer-2", "alpha/model", "cursor-grok-4.6"]);
  });

  it("selects an explicit backup model and effort and warns for the implementation host", () => {
    const result = normalizeGuidedInitAnswers({
      capabilities,
      answers: {
        ...completeHarnessAnswers,
        reviewBackupHarness: "codex",
        reviewBackupModel: "gpt-5.6-mini",
        reviewBackupEffort: "high",
      },
    });

    assert.equal(result.validation.ok, true);
    assert.equal(result.answers.reviewBackupHarness, "codex");
    assert.equal(result.answers.reviewBackupModel, "gpt-5.6-mini");
    assert.equal(result.answers.reviewBackupEffort, "high");
    const backup = result.questions.find(question => question.id === "review-backup-harness");
    const implementationHost = backup.options.find(option => option.value === "codex");
    assert.match(implementationHost.label, /implementation host/i);
    assert.match(implementationHost.description, /implementation work/i);
    assert.equal(backup.options[0].value, GUIDED_INIT_NO_BACKUP);
    assert.equal(backup.options[0].recommended, true);
    assert.deepEqual(
      result.questions.find(question => question.id === "review-backup-effort").options.map(option => option.value),
      ["low", "medium", "high"],
    );
  });

  it("rejects an unavailable backup model and effort", () => {
    const result = normalizeGuidedInitAnswers({
      capabilities,
      answers: {
        ...completeHarnessAnswers,
        reviewBackupHarness: "codex",
        reviewBackupModel: "invented-model",
        reviewBackupEffort: "extreme",
      },
    });

    assert.equal(result.validation.ok, false);
    assert.match(result.validation.errors.find(error => error.questionId === "review-backup-model")?.message, /invented-model/);
    assert.match(result.validation.errors.find(error => error.questionId === "review-backup-effort")?.message, /extreme/);
  });

  it("rejects a backup harness that is not an eligible selected host", () => {
    const questions = buildGuidedInitQuestions({
      capabilities,
      answers: { ...completeHarnessAnswers, reviewBackupHarness: "cursor" },
    });

    assert.match(
      questions.find(question => question.id === "review-backup-harness").validationError,
      /unavailable choice: cursor/,
    );
  });

  it("clears saved model and effort values when the backup harness changes", () => {
    const questions = buildGuidedInitQuestions({
      capabilities,
      answers: { reviewBackupHarness: "codex" },
      current: {
        ...completeHarnessAnswers,
        reviewBackupHarness: "claude-code",
        reviewBackupModel: "gpt-5.6",
        reviewBackupEffort: "high",
      },
    });
    const model = questions.find(question => question.id === "review-backup-model");
    const effort = questions.find(question => question.id === "review-backup-effort");

    assert.equal(model.currentValue, null);
    assert.equal(model.promptNeeded, true);
    assert.equal(effort.currentValue, null);
    assert.equal(effort.promptNeeded, true);
  });

  it("requires a live model list for a backup harness", () => {
    const result = normalizeGuidedInitAnswers({
      capabilities,
      answers: {
        ...completeHarnessAnswers,
        agentHarnesses: ["claude-code", "codex"],
        reviewHarness: "codex",
        reviewModel: "gpt-5.6",
        reviewBackupHarness: "claude-code",
      },
    });

    assert.equal(result.validation.ok, false);
    assert.match(result.validation.errors.find(error => error.questionId === "review-backup-model")?.message, /live model list/);
  });

  it("does not ask for separate effort when the Cursor model ID carries it", () => {
    const cursorCapabilities = {
      ...capabilities,
      agentHarnesses: [
        ...capabilities.agentHarnesses.filter(harness => harness.value !== "cursor"),
        {
          value: "cursor",
          label: "Cursor",
          canRunPrimaryReview: false,
          canRunSeparateReview: true,
          reviewModels: { kind: "live", models: [{ value: "cursor-grok-4.6-high-fast", label: "Grok high fast" }] },
        },
      ],
    };
    const result = normalizeGuidedInitAnswers({
      capabilities: cursorCapabilities,
      answers: {
        ...completeHarnessAnswers,
        agentHarnesses: ["claude-code", "codex", "cursor"],
        reviewHarness: "codex",
        reviewModel: "gpt-5.6",
        reviewBackupHarness: "cursor",
        reviewBackupModel: "cursor-grok-4.6-high-fast",
      },
    });

    assert.equal(result.validation.ok, true);
    assert.equal(result.answers.reviewBackupEffort, null);
    assert.equal(result.questions.find(question => question.id === "review-backup-effort").applicable, false);
  });
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
