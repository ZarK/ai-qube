import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GUIDED_INIT_DOCS_BASE_URL,
  GUIDED_INIT_UNPINNED_MODEL,
  buildGuidedInitAnswerSummary,
  buildGuidedInitQuestions,
  normalizeGuidedInitAnswers,
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
  reviewPublisher: "user",
});

describe("guided QUBE init questions", () => {
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
      "review-publisher",
    ]);
    assert.deepEqual(questions.map(question => question.step), [1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8]);
    for (const question of questions) {
      assert.ok(question.explanation.length > 20, question.id);
      assert.ok(question.recommendationReason.length > 20, question.id);
      assert.match(question.docsUrl, new RegExp(`^${escapeRegExp(GUIDED_INIT_DOCS_BASE_URL)}#`), question.id);
      assert.doesNotMatch(`${question.prompt} ${question.explanation} ${question.recommendationReason}`, /host surface|model routing|review tier|Generic terminal/i);
    }
    assert.equal(questions.find(question => question.id === "external-reviewer").applicable, false);
    assert.equal(questions.find(question => question.id === "review-harness").applicable, true);
    assert.equal(questions.find(question => question.id === "review-model").answerLabel, "Claude Code default (not pinned)");
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
    assert.equal(buildGuidedInitAnswerSummary(questions).length, 10);
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
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
