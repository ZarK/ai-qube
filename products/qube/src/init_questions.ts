export const GUIDED_INIT_DOCS_BASE_URL = "https://github.com/ZarK/ai-qube/blob/main/docs/qube-init.md";
export const GUIDED_INIT_UNPINNED_MODEL = "unpinned";

export type GuidedInitQuestionId =
  | "agent-harnesses"
  | "issue-tracker"
  | "automated-checks"
  | "continuous-shipping"
  | "umpire-scope"
  | "quality-checks"
  | "review-source"
  | "external-reviewer"
  | "review-harness"
  | "review-model"
  | "review-publisher";

export type GuidedInitSelection = "single" | "multiple";
export type GuidedInitAnswerSource = "answer" | "current" | "default" | "automatic";
export type GuidedReviewSource = "external" | "primary" | "harness";
export type GuidedUmpireScope = "ready" | "standard" | "custom";
export type GuidedReviewPublisher = "user" | "github-app";
export type GuidedInitQuestionValue = string | readonly string[] | null;

export interface GuidedInitChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
  readonly available?: boolean;
  /** Limit this choice to repositories that use one of these issue trackers. */
  readonly forIssueTrackers?: readonly string[];
}

export type GuidedReviewModelCapability =
  | {
      readonly kind: "live";
      readonly models: readonly GuidedInitChoice[];
    }
  | {
      /** The harness can review, but normal setup must leave its model unpinned. */
      readonly kind: "unpinned";
      readonly label?: string;
      readonly reason?: string;
    }
  | {
      /** Review can run, but this init run cannot validate a model selection. */
      readonly kind: "unavailable";
      readonly reason: string;
    };

export interface GuidedHarnessChoice extends GuidedInitChoice {
  readonly canRunPrimaryReview: boolean;
  readonly canRunSeparateReview: boolean;
  readonly reviewModels: GuidedReviewModelCapability;
}

export interface GuidedIssueTrackerChoice extends GuidedInitChoice {
  /** True when QUBE can complete an issue and continue to another Ready issue. */
  readonly supportsContinuousShipping: boolean;
}

export interface GuidedUmpireScopeChoice extends GuidedInitChoice {
  readonly value: GuidedUmpireScope;
}

export interface GuidedInitCapabilities {
  readonly agentHarnesses: readonly GuidedHarnessChoice[];
  readonly issueTrackers: readonly GuidedIssueTrackerChoice[];
  readonly automatedChecks: readonly GuidedInitChoice[];
  readonly umpireScopes: readonly GuidedUmpireScopeChoice[];
  readonly qualityStages: readonly GuidedInitChoice[];
  readonly externalReviewers: readonly GuidedInitChoice[];
  readonly reviewPublishers: readonly GuidedInitChoice[];
}

export interface GuidedInitAnswers {
  readonly agentHarnesses?: readonly string[];
  readonly issueTracker?: string;
  readonly automatedChecks?: string;
  readonly continuousShipping?: boolean;
  readonly umpireScope?: GuidedUmpireScope;
  readonly qualityStages?: readonly string[];
  readonly reviewSource?: GuidedReviewSource;
  readonly externalReviewers?: readonly string[];
  readonly reviewHarness?: string;
  /** Null selects the harness default without pinning a model. */
  readonly reviewModel?: string | null;
  readonly reviewPublisher?: GuidedReviewPublisher;
}

export interface GuidedInitQuestion {
  readonly id: GuidedInitQuestionId;
  readonly step: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly label: string;
  readonly prompt: string;
  readonly explanation: string;
  readonly docsUrl: string;
  readonly selection: GuidedInitSelection;
  readonly options: readonly GuidedInitChoice[];
  readonly applicable: boolean;
  readonly promptNeeded: boolean;
  readonly currentValue: GuidedInitQuestionValue;
  readonly selectedValue: GuidedInitQuestionValue;
  readonly preselectedValue: GuidedInitQuestionValue;
  readonly recommendedValue: GuidedInitQuestionValue;
  readonly recommendation: string;
  readonly recommendationReason: string;
  readonly answerLabel: string | null;
  readonly reason: string | null;
  readonly answeredBy: GuidedInitAnswerSource | null;
  readonly validationError: string | null;
}

export interface GuidedInitQuestionInput {
  readonly capabilities: GuidedInitCapabilities;
  readonly answers?: GuidedInitAnswers;
  readonly current?: GuidedInitAnswers;
  readonly defaults?: GuidedInitAnswers;
  /** Select recommendations without prompts. Use this for --yes and --defaults. */
  readonly resolveDefaults?: boolean;
}

export interface GuidedInitAnswerSummary {
  readonly id: GuidedInitQuestionId;
  readonly step: number;
  readonly label: string;
  readonly value: GuidedInitQuestionValue;
  readonly answer: string;
  readonly reason: string;
  readonly docsUrl: string;
}

export interface GuidedInitValidationError {
  readonly questionId: GuidedInitQuestionId;
  readonly message: string;
}

export interface GuidedInitValidation {
  readonly ok: boolean;
  readonly errors: readonly GuidedInitValidationError[];
  readonly unresolvedQuestionIds: readonly GuidedInitQuestionId[];
}

export interface NormalizedGuidedInitAnswers {
  readonly agentHarnesses: readonly string[];
  readonly issueTracker: string;
  readonly automatedChecks: string;
  readonly continuousShipping: boolean;
  readonly umpireScope: GuidedUmpireScope;
  readonly qualityStages: readonly string[];
  readonly reviewSource: GuidedReviewSource;
  readonly externalReviewers?: readonly string[];
  readonly reviewHarness?: string;
  readonly reviewModel?: string | null;
  readonly reviewPublisher?: GuidedReviewPublisher;
}

export interface GuidedInitNormalization {
  readonly answers: NormalizedGuidedInitAnswers | null;
  readonly questions: readonly GuidedInitQuestion[];
  readonly summary: readonly GuidedInitAnswerSummary[];
  readonly validation: GuidedInitValidation;
}

const QUESTION_DOCS: Readonly<Record<GuidedInitQuestionId, string>> = Object.freeze({
  "agent-harnesses": `${GUIDED_INIT_DOCS_BASE_URL}#agent-harnesses`,
  "issue-tracker": `${GUIDED_INIT_DOCS_BASE_URL}#issue-tracker`,
  "automated-checks": `${GUIDED_INIT_DOCS_BASE_URL}#automated-checks-ci`,
  "continuous-shipping": `${GUIDED_INIT_DOCS_BASE_URL}#continuous-shipping`,
  "umpire-scope": `${GUIDED_INIT_DOCS_BASE_URL}#umpire`,
  "quality-checks": `${GUIDED_INIT_DOCS_BASE_URL}#quality-checks`,
  "review-source": `${GUIDED_INIT_DOCS_BASE_URL}#review`,
  "external-reviewer": `${GUIDED_INIT_DOCS_BASE_URL}#review`,
  "review-harness": `${GUIDED_INIT_DOCS_BASE_URL}#review`,
  "review-model": `${GUIDED_INIT_DOCS_BASE_URL}#review-publisher`,
  "review-publisher": `${GUIDED_INIT_DOCS_BASE_URL}#review-publisher`,
});

const CONTINUOUS_SHIPPING_OPTIONS: readonly GuidedInitChoice[] = Object.freeze([
  Object.freeze({ value: "on", label: "On", recommended: true }),
  Object.freeze({ value: "off", label: "Off" }),
]);

const REVIEW_SOURCE_LABELS: Readonly<Record<GuidedReviewSource, string>> = Object.freeze({
  external: "External review service",
  primary: "Primary-harness subagents",
  harness: "Another installed harness",
});

export function buildGuidedInitQuestions(input: GuidedInitQuestionInput): readonly GuidedInitQuestion[] {
  const capabilities = normalizeCapabilities(input.capabilities);
  const answers = input.answers ?? {};
  const current = input.current ?? {};
  const defaults = input.defaults ?? {};
  const resolveDefaults = input.resolveDefaults === true;
  const questions: GuidedInitQuestion[] = [];

  const harnessOptions = capabilities.agentHarnesses;
  const harnessRecommendation = listRecommendation(defaults.agentHarnesses, harnessOptions);
  const agentHarnessQuestion = resolveQuestion({
    id: "agent-harnesses",
    step: 1,
    label: "Agent harnesses",
    prompt: "Which agent harnesses should this repository use?",
    explanation: "QUBE supplies instructions, workflow state, commands, and supported continuation hooks. Each agent harness still controls execution, trust, and permissions.",
    selection: "multiple",
    options: harnessOptions,
    applicable: true,
    answer: answerValue(answers, "agentHarnesses"),
    current: answerValue(current, "agentHarnesses"),
    recommendedValue: harnessRecommendation,
    recommendationReason: "Select the harness for the next session. Add another only when you plan to use it for work or Review. The first harness is the primary harness.",
    resolveDefaults,
  });
  questions.push(agentHarnessQuestion);
  const selectedHarnesses = selectedList(agentHarnessQuestion);

  const trackerOptions = capabilities.issueTrackers;
  const trackerRecommendation = singleRecommendation(defaults.issueTracker, trackerOptions);
  const trackerQuestion = resolveQuestion({
    id: "issue-tracker",
    step: 2,
    label: "Issue tracker",
    prompt: "Which issue tracker should QUBE use?",
    explanation: "The issue tracker stores the work queue and pull request state that QUBE uses.",
    selection: "single",
    options: trackerOptions,
    applicable: true,
    answer: answerValue(answers, "issueTracker"),
    current: answerValue(current, "issueTracker"),
    recommendedValue: trackerRecommendation,
    recommendationReason: "Use the issue tracker that owns this repository's active work queue.",
    resolveDefaults,
  });
  questions.push(trackerQuestion);
  const selectedTracker = selectedString(trackerQuestion);

  const checkOptions = compatibleChoices(capabilities.automatedChecks, selectedTracker);
  const matchingCheck = selectedTracker && checkOptions.some(option => option.value === selectedTracker)
    ? selectedTracker
    : undefined;
  const checkRecommendation = singleRecommendation(defaults.automatedChecks ?? matchingCheck, checkOptions);
  const checkQuestion = resolveQuestion({
    id: "automated-checks",
    step: 3,
    label: "Automated checks (CI)",
    prompt: "Which automated checks (CI) provider runs the required checks?",
    explanation: "Automated checks (CI) provide the build and test results that QUBE reads before merge.",
    selection: "single",
    options: checkOptions,
    applicable: true,
    answer: answerValue(answers, "automatedChecks"),
    current: answerValue(current, "automatedChecks"),
    recommendedValue: checkRecommendation,
    recommendationReason: matchingCheck
      ? "Use the same provider as the issue tracker because it can report this repository's checks directly."
      : "Use the provider that reports the required checks for this repository.",
    resolveDefaults,
  });
  questions.push(checkQuestion);

  const selectedTrackerChoice = selectedTracker
    ? trackerOptions.find(option => option.value === selectedTracker)
    : undefined;
  const shippingSupported = selectedTrackerChoice?.supportsContinuousShipping === true;
  const shippingOptions = shippingSupported
    ? CONTINUOUS_SHIPPING_OPTIONS
    : Object.freeze([CONTINUOUS_SHIPPING_OPTIONS[1]!]);
  const shippingDefault = shippingSupported && (defaults.continuousShipping ?? true);
  const shippingQuestion = resolveQuestion({
    id: "continuous-shipping",
    step: 4,
    label: "Continuous Shipping",
    prompt: "Should Continuous Shipping be on or off?",
    explanation: "Continuous Shipping lets QUBE complete an issue, merge it when gates pass, and continue to the next Ready issue.",
    selection: "single",
    options: shippingOptions,
    applicable: selectedTracker !== null,
    answer: booleanAnswerValue(answers, "continuousShipping"),
    current: booleanAnswerValue(current, "continuousShipping"),
    recommendedValue: shippingDefault ? "on" : "off",
    recommendationReason: !shippingSupported
      ? "Keep Continuous Shipping off because the selected issue tracker cannot complete and continue the issue lifecycle."
      : shippingDefault
      ? "Keep Continuous Shipping on so QUBE can complete the full development cycle without routine pauses."
      : "Keep Continuous Shipping off because the supplied repository default requires a pause after each issue.",
    resolveDefaults,
  });
  questions.push(shippingQuestion);

  const umpireOptions = capabilities.umpireScopes;
  const umpireRecommendation = singleRecommendation(defaults.umpireScope, umpireOptions);
  const umpireQuestion = resolveQuestion({
    id: "umpire-scope",
    step: 5,
    label: "Umpire",
    prompt: "What can Umpire start after the active issue is complete?",
    explanation: "Umpire controls what QUBE can start after the active issue is complete.",
    selection: "single",
    options: umpireOptions,
    applicable: true,
    answer: answerValue(answers, "umpireScope"),
    current: answerValue(current, "umpireScope"),
    recommendedValue: umpireRecommendation,
    recommendationReason: umpireRecommendation === "ready"
      ? "Use Ready issues only. This keeps continuation inside the reviewed issue queue."
      : "Use the supplied repository default because it preserves the current valid Umpire scope.",
    resolveDefaults,
  });
  questions.push(umpireQuestion);

  const stageOptions = capabilities.qualityStages;
  const stageRecommendation = listRecommendation(defaults.qualityStages, stageOptions);
  const qualityQuestion = resolveQuestion({
    id: "quality-checks",
    step: 6,
    label: "Quality checks",
    prompt: "Which Quality checks should QUBE run?",
    explanation: "Select one stage to run that stage and all earlier stages. Select multiple stages to run exactly those stages.",
    selection: "multiple",
    options: stageOptions,
    applicable: true,
    answer: answerValue(answers, "qualityStages"),
    current: answerValue(current, "qualityStages"),
    recommendedValue: stageRecommendation,
    recommendationReason: "Use the recommended stage as a cumulative baseline. Select multiple stages only when the repository needs an exact set.",
    resolveDefaults,
  });
  questions.push(qualityQuestion);

  const primaryHarness = selectedHarnesses[0];
  const primaryHarnessChoice = primaryHarness
    ? harnessOptions.find(option => option.value === primaryHarness)
    : undefined;
  const separateHarnesses = harnessOptions.filter(option => (
    selectedHarnesses.includes(option.value)
      && option.value !== primaryHarness
      && option.canRunSeparateReview
  ));
  const externalReviewers = compatibleChoices(capabilities.externalReviewers, selectedTracker);
  const reviewSourceOptions = buildReviewSourceOptions({
    externalAvailable: externalReviewers.length > 0,
    primaryAvailable: primaryHarnessChoice?.canRunPrimaryReview === true,
    separateAvailable: separateHarnesses.length > 0,
  });
  const computedReviewSource = separateHarnesses.length > 0
    ? "harness"
    : primaryHarnessChoice?.canRunPrimaryReview
      ? "primary"
      : "external";
  const reviewSourceRecommendation = singleRecommendation(defaults.reviewSource ?? computedReviewSource, reviewSourceOptions);
  let reviewSourceQuestion = resolveQuestion({
    id: "review-source",
    step: 7,
    label: "Review",
    prompt: "Where should Review run?",
    explanation: "The Review source decides where review work runs and which account or service it uses.",
    selection: "single",
    options: reviewSourceOptions,
    applicable: true,
    answer: answerValue(answers, "reviewSource"),
    current: answerValue(current, "reviewSource"),
    recommendedValue: reviewSourceRecommendation,
    recommendationReason: reviewSourceReason(reviewSourceRecommendation, primaryHarnessChoice, separateHarnesses[0]),
    resolveDefaults,
  });
  if (reviewSourceOptions.length === 0) {
    reviewSourceQuestion = {
      ...reviewSourceQuestion,
      promptNeeded: false,
      validationError: "Review: no available Review source matches the selected Agent harnesses and issue tracker.",
    };
  }
  questions.push(reviewSourceQuestion);
  const selectedReviewSource = selectedString(reviewSourceQuestion) as GuidedReviewSource | null;

  const externalQuestion = resolveQuestion({
    id: "external-reviewer",
    step: 8,
    label: "External review service",
    prompt: "Which external review services should QUBE request?",
    explanation: "An external review service reviews the pull request. Its own plan or usage policy pays for that work.",
    selection: "multiple",
    options: externalReviewers,
    applicable: selectedReviewSource === "external",
    answer: answerValue(answers, "externalReviewers"),
    current: answerValue(current, "externalReviewers"),
    recommendedValue: listRecommendation(defaults.externalReviewers, externalReviewers),
    recommendationReason: "Use a service that is already enabled for this repository. Its own plan pays for review work.",
    resolveDefaults,
  });
  questions.push(externalQuestion);

  const reviewHarnessQuestion = resolveQuestion({
    id: "review-harness",
    step: 8,
    label: "Review harness",
    prompt: "Which other agent harness should run Review?",
    explanation: "Another selected agent harness can run Review. Review usage goes to the account used by that harness.",
    selection: "single",
    options: separateHarnesses,
    applicable: selectedReviewSource === "harness",
    answer: answerValue(answers, "reviewHarness"),
    current: answerValue(current, "reviewHarness"),
    recommendedValue: singleRecommendation(defaults.reviewHarness, separateHarnesses),
    recommendationReason: separateHarnesses[0]
      ? `Use ${separateHarnesses[0].label} so Review usage goes to the account used by that harness instead of the primary harness account.`
      : "Use another selected harness that can run Review in a separate session.",
    resolveDefaults,
  });
  questions.push(reviewHarnessQuestion);

  const selectedReviewHarness = selectedReviewSource === "primary"
    ? primaryHarness
    : selectedString(reviewHarnessQuestion);
  const selectedReviewHarnessChoice = selectedReviewHarness
    ? harnessOptions.find(option => option.value === selectedReviewHarness)
    : undefined;
  const modelState = buildModelState(selectedReviewHarnessChoice);
  const modelAnswer = reviewModelAnswerValue(answers);
  const currentModel = reviewModelAnswerValue(current);
  const defaultModel = reviewModelDefaultValue(defaults, modelState);
  let modelQuestion = resolveQuestion({
    id: "review-model",
    step: 8,
    label: "Review model",
    prompt: "Which listed model should Review use?",
    explanation: modelState.kind === "unpinned"
      ? "This harness does not provide a live model list. QUBE leaves the model unpinned and the harness uses its current default."
      : "Choose only a model that the selected harness currently lists. Model availability and price can change in that harness.",
    selection: "single",
    options: modelState.options,
    applicable: selectedReviewSource === "primary" || selectedReviewSource === "harness",
    answer: modelAnswer,
    current: currentModel,
    recommendedValue: defaultModel,
    recommendationReason: modelState.recommendationReason,
    resolveDefaults,
    autoSelectOnlyChoice: modelState.kind === "unpinned",
  });
  if ((selectedReviewSource === "primary" || selectedReviewSource === "harness") && modelState.kind === "unavailable") {
    modelQuestion = {
      ...modelQuestion,
      promptNeeded: false,
      validationError: `Review model: ${modelState.recommendationReason}`,
    };
  }
  questions.push(modelQuestion);

  const publisherOptions = compatibleChoices(capabilities.reviewPublishers, selectedTracker);
  const publisherQuestion = resolveQuestion({
    id: "review-publisher",
    step: 8,
    label: "Review publisher",
    prompt: "Which identity should publish GitHub reviews?",
    explanation: "The QUBE Reviewer App gives reviews a separate identity and enables formal verdicts and inline comments. Its approval does not always satisfy branch protection.",
    selection: "single",
    options: publisherOptions,
    applicable: publisherOptions.length > 0,
    answer: answerValue(answers, "reviewPublisher"),
    current: answerValue(current, "reviewPublisher"),
    recommendedValue: singleRecommendation(defaults.reviewPublisher ?? "user", publisherOptions),
    recommendationReason: "Use the current GitHub account when a separate review identity is not required. It needs no additional credentials.",
    resolveDefaults,
  });
  questions.push(publisherQuestion);

  return Object.freeze(questions.map(freezeQuestion));
}

export function validateGuidedInitQuestions(questions: readonly GuidedInitQuestion[]): GuidedInitValidation {
  const errors: GuidedInitValidationError[] = questions.flatMap(question => (
    question.validationError
      ? [{ questionId: question.id, message: question.validationError }]
      : []
  ));
  const unresolvedQuestionIds = questions
    .filter(question => question.applicable && question.promptNeeded)
    .map(question => question.id);
  return Object.freeze({
    ok: errors.length === 0 && unresolvedQuestionIds.length === 0,
    errors: Object.freeze(errors.map(error => Object.freeze(error))),
    unresolvedQuestionIds: Object.freeze(unresolvedQuestionIds),
  });
}

export function buildGuidedInitAnswerSummary(questions: readonly GuidedInitQuestion[]): readonly GuidedInitAnswerSummary[] {
  return Object.freeze(questions.flatMap(question => {
    if (!question.applicable || question.selectedValue === null || !question.answerLabel || !question.reason) return [];
    return [Object.freeze({
      id: question.id,
      step: question.step,
      label: question.label,
      value: cloneValue(question.selectedValue),
      answer: question.answerLabel,
      reason: question.reason,
      docsUrl: question.docsUrl,
    })];
  }));
}

export function normalizeGuidedInitAnswers(input: GuidedInitQuestionInput): GuidedInitNormalization {
  const questions = buildGuidedInitQuestions(input);
  const validation = validateGuidedInitQuestions(questions);
  const summary = buildGuidedInitAnswerSummary(questions);
  if (!validation.ok) return Object.freeze({ answers: null, questions, summary, validation });

  const byId = new Map(questions.map(question => [question.id, question]));
  const agentHarnesses = requiredList(byId, "agent-harnesses");
  const issueTracker = requiredString(byId, "issue-tracker");
  const automatedChecks = requiredString(byId, "automated-checks");
  const continuousShipping = requiredString(byId, "continuous-shipping") === "on";
  const umpireScope = requiredString(byId, "umpire-scope") as GuidedUmpireScope;
  const qualityStages = requiredList(byId, "quality-checks");
  const reviewSource = requiredString(byId, "review-source") as GuidedReviewSource;
  const externalReviewers = selectedList(byId.get("external-reviewer"));
  const reviewHarness = selectedString(byId.get("review-harness"));
  const modelValue = selectedString(byId.get("review-model"));
  const reviewPublisher = selectedString(byId.get("review-publisher")) as GuidedReviewPublisher | null;

  const normalized: NormalizedGuidedInitAnswers = Object.freeze({
    agentHarnesses: Object.freeze(agentHarnesses),
    issueTracker,
    automatedChecks,
    continuousShipping,
    umpireScope,
    qualityStages: Object.freeze(qualityStages),
    reviewSource,
    ...(reviewSource === "external" ? { externalReviewers: Object.freeze(externalReviewers) } : {}),
    ...(reviewSource === "harness" && reviewHarness ? { reviewHarness } : {}),
    ...((reviewSource === "primary" || reviewSource === "harness") && modelValue
      ? { reviewModel: modelValue === GUIDED_INIT_UNPINNED_MODEL ? null : modelValue }
      : {}),
    ...(reviewPublisher ? { reviewPublisher } : {}),
  });
  return Object.freeze({ answers: normalized, questions, summary, validation });
}

interface ResolveQuestionInput {
  readonly id: GuidedInitQuestionId;
  readonly step: GuidedInitQuestion["step"];
  readonly label: string;
  readonly prompt: string;
  readonly explanation: string;
  readonly selection: GuidedInitSelection;
  readonly options: readonly GuidedInitChoice[];
  readonly applicable: boolean;
  readonly answer: PresentValue;
  readonly current: PresentValue;
  readonly recommendedValue: GuidedInitQuestionValue;
  readonly recommendationReason: string;
  readonly resolveDefaults: boolean;
  readonly autoSelectOnlyChoice?: boolean;
}

interface PresentValue {
  readonly present: boolean;
  readonly value: unknown;
}

function resolveQuestion(input: ResolveQuestionInput): GuidedInitQuestion {
  const options = Object.freeze(input.options.filter(option => option.available !== false));
  const recommendation = validQuestionValue(input.recommendedValue, input.selection, options).value;
  if (!input.applicable) {
    return {
      id: input.id,
      step: input.step,
      label: input.label,
      prompt: input.prompt,
      explanation: input.explanation,
      docsUrl: QUESTION_DOCS[input.id],
      selection: input.selection,
      options,
      applicable: false,
      promptNeeded: false,
      currentValue: null,
      selectedValue: null,
      preselectedValue: null,
      recommendedValue: recommendation,
      recommendation: answerLabel(recommendation, options),
      recommendationReason: input.recommendationReason,
      answerLabel: null,
      reason: null,
      answeredBy: null,
      validationError: null,
    };
  }

  const answer = input.answer.present
    ? validQuestionValue(input.answer.value, input.selection, options)
    : { value: null, error: null };
  const current = input.current.present
    ? validQuestionValue(input.current.value, input.selection, options)
    : { value: null, error: null };
  let selectedValue: GuidedInitQuestionValue = null;
  let answeredBy: GuidedInitAnswerSource | null = null;
  let reason: string | null = null;
  let validationError: string | null = null;

  if (input.answer.present) {
    if (answer.error) validationError = `${input.label}: ${answer.error}`;
    else {
      selectedValue = answer.value;
      answeredBy = "answer";
      reason = "Selected for this init run.";
    }
  } else if (input.current.present) {
    if (current.error) validationError = `${input.label}: the current value ${current.error}`;
    else {
      selectedValue = current.value;
      answeredBy = "current";
      reason = "The current valid setup is preserved.";
    }
  } else if (input.resolveDefaults && recommendation !== null) {
    selectedValue = recommendation;
    answeredBy = "default";
    reason = input.recommendationReason;
  } else if ((input.autoSelectOnlyChoice ?? true) && options.length === 1) {
    selectedValue = input.selection === "multiple"
      ? Object.freeze([options[0]!.value])
      : options[0]!.value;
    answeredBy = "automatic";
    reason = "This is the only available choice.";
  }

  const promptNeeded = selectedValue === null;
  return {
    id: input.id,
    step: input.step,
    label: input.label,
    prompt: input.prompt,
    explanation: input.explanation,
    docsUrl: QUESTION_DOCS[input.id],
    selection: input.selection,
    options,
    applicable: true,
    promptNeeded,
    currentValue: current.error ? null : cloneValue(current.value),
    selectedValue: cloneValue(selectedValue),
    preselectedValue: cloneValue(selectedValue ?? recommendation),
    recommendedValue: cloneValue(recommendation),
    recommendation: answerLabel(recommendation, options),
    recommendationReason: input.recommendationReason,
    answerLabel: selectedValue === null ? null : answerLabel(selectedValue, options),
    reason,
    answeredBy,
    validationError,
  };
}

function normalizeCapabilities(capabilities: GuidedInitCapabilities): GuidedInitCapabilities {
  return {
    agentHarnesses: freezeChoices(capabilities.agentHarnesses),
    issueTrackers: freezeChoices(capabilities.issueTrackers),
    automatedChecks: freezeChoices(capabilities.automatedChecks),
    umpireScopes: freezeChoices(capabilities.umpireScopes),
    qualityStages: freezeChoices(capabilities.qualityStages),
    externalReviewers: freezeChoices(capabilities.externalReviewers),
    reviewPublishers: freezeChoices(capabilities.reviewPublishers),
  };
}

function freezeChoices<Choice extends GuidedInitChoice>(choices: readonly Choice[]): readonly Choice[] {
  const values = new Set<string>();
  return Object.freeze(choices.flatMap(choice => {
    const value = choice.value.trim();
    const label = choice.label.trim();
    if (!value || !label || values.has(value) || choice.available === false) return [];
    values.add(value);
    return [Object.freeze({
      ...choice,
      value,
      label,
      ...(choice.forIssueTrackers ? { forIssueTrackers: Object.freeze([...choice.forIssueTrackers]) } : {}),
    }) as Choice];
  }));
}

function compatibleChoices(choices: readonly GuidedInitChoice[], tracker: string | null): readonly GuidedInitChoice[] {
  return Object.freeze(choices.filter(choice => (
    !choice.forIssueTrackers
      || (tracker !== null && choice.forIssueTrackers.includes(tracker))
  )));
}

function buildReviewSourceOptions(input: {
  readonly externalAvailable: boolean;
  readonly primaryAvailable: boolean;
  readonly separateAvailable: boolean;
}): readonly GuidedInitChoice[] {
  const options: GuidedInitChoice[] = [];
  if (input.externalAvailable) options.push({
    value: "external",
    label: REVIEW_SOURCE_LABELS.external,
    description: "The external service's plan pays for review work.",
  });
  if (input.primaryAvailable) options.push({
    value: "primary",
    label: REVIEW_SOURCE_LABELS.primary,
    description: "Review usage goes to the account used by the primary harness.",
  });
  if (input.separateAvailable) options.push({
    value: "harness",
    label: REVIEW_SOURCE_LABELS.harness,
    description: "Review usage goes to the account used by the other harness.",
  });
  return Object.freeze(options.map(option => Object.freeze(option)));
}

function reviewSourceReason(
  source: GuidedInitQuestionValue,
  primary: GuidedHarnessChoice | undefined,
  separate: GuidedHarnessChoice | undefined,
): string {
  if (source === "harness" && separate) {
    return `Use ${separate.label} so Review usage goes to the account used by that harness instead of the primary harness account.`;
  }
  if (source === "primary" && primary) {
    return `Use ${primary.label} subagents so Review usage goes to the account used by the primary harness.`;
  }
  return "Use an external service when the selected harnesses cannot run Review. The service's own plan pays for that work.";
}

function buildModelState(harness: GuidedHarnessChoice | undefined): {
  readonly kind: GuidedReviewModelCapability["kind"];
  readonly options: readonly GuidedInitChoice[];
  readonly recommendationReason: string;
} {
  const modelCapability = harness?.reviewModels;
  if (!modelCapability || modelCapability.kind === "unavailable") {
    return {
      kind: "unavailable",
      options: Object.freeze([]),
      recommendationReason: modelCapability?.reason ?? "No review harness is selected.",
    };
  }
  if (modelCapability.kind === "unpinned") {
    return {
      kind: "unpinned",
      options: Object.freeze([Object.freeze({
        value: GUIDED_INIT_UNPINNED_MODEL,
        label: modelCapability.label ?? "Harness default (not pinned)",
        recommended: true,
      })]),
      recommendationReason: modelCapability.reason
        ?? "Leave the model unpinned because this harness does not provide a live model list.",
    };
  }
  const catalogModels = modelCapability.models
    .filter(model => model.value !== GUIDED_INIT_UNPINNED_MODEL)
    .map((model, index) => ({ ...model, recommended: index === 0 }));
  const options = freezeChoices(catalogModels);
  return {
    kind: "live",
    options,
    recommendationReason: "Use the first model in the live account catalog unless this repository requires another listed model. The catalog does not provide comparable price or quality data.",
  };
}

function reviewModelDefaultValue(
  defaults: GuidedInitAnswers,
  modelState: ReturnType<typeof buildModelState>,
): GuidedInitQuestionValue {
  if (Object.hasOwn(defaults, "reviewModel")) {
    if (defaults.reviewModel !== null) return defaults.reviewModel ?? null;
    return modelState.kind === "unpinned"
      ? GUIDED_INIT_UNPINNED_MODEL
      : singleRecommendation(undefined, modelState.options);
  }
  if (modelState.kind === "unpinned") return GUIDED_INIT_UNPINNED_MODEL;
  return singleRecommendation(undefined, modelState.options);
}

function validQuestionValue(
  raw: unknown,
  selection: GuidedInitSelection,
  options: readonly GuidedInitChoice[],
): { readonly value: GuidedInitQuestionValue; readonly error: string | null } {
  const allowed = new Set(options.map(option => option.value));
  if (selection === "multiple") {
    if (!Array.isArray(raw)) return { value: null, error: "must be a list." };
    const values = [...new Set(raw.flatMap(value => typeof value === "string" && value.trim() ? [value.trim()] : []))];
    if (values.length === 0) return { value: null, error: "must select at least one available choice." };
    const unavailable = values.filter(value => !allowed.has(value));
    if (unavailable.length > 0) return { value: null, error: `includes unavailable choice${unavailable.length === 1 ? "" : "s"}: ${unavailable.join(", ")}.` };
    return { value: Object.freeze(values), error: null };
  }
  if (typeof raw !== "string" || raw.trim() === "") return { value: null, error: "must select one available choice." };
  const value = raw.trim();
  if (!allowed.has(value)) return { value: null, error: `selects unavailable choice: ${value}.` };
  return { value, error: null };
}

function answerLabel(value: GuidedInitQuestionValue, options: readonly GuidedInitChoice[]): string {
  if (value === null) return "";
  const labels = new Map(options.map(option => [option.value, option.label]));
  if (Array.isArray(value)) return value.map(item => labels.get(item) ?? item).join(", ");
  return labels.get(value as string) ?? String(value);
}

function singleRecommendation(value: string | undefined, options: readonly GuidedInitChoice[]): string | null {
  if (value && options.some(option => option.value === value)) return value;
  return options.find(option => option.recommended)?.value ?? options[0]?.value ?? null;
}

function listRecommendation(values: readonly string[] | undefined, options: readonly GuidedInitChoice[]): readonly string[] | null {
  if (values && values.length > 0 && values.every(value => options.some(option => option.value === value))) {
    return Object.freeze([...new Set(values)]);
  }
  const recommended = options.filter(option => option.recommended).map(option => option.value);
  const fallback = recommended.length > 0 ? recommended : options[0] ? [options[0].value] : [];
  return fallback.length > 0 ? Object.freeze(fallback) : null;
}

function answerValue<Answers extends object, Key extends keyof Answers>(answers: Answers, key: Key): PresentValue {
  return Object.hasOwn(answers, key)
    ? { present: true, value: answers[key] }
    : { present: false, value: undefined };
}

function booleanAnswerValue<Answers extends object, Key extends keyof Answers>(answers: Answers, key: Key): PresentValue {
  const value = answerValue(answers, key);
  if (!value.present) return value;
  return {
    present: true,
    value: value.value === true ? "on" : value.value === false ? "off" : value.value,
  };
}

function reviewModelAnswerValue(answers: GuidedInitAnswers): PresentValue {
  const value = answerValue(answers, "reviewModel");
  if (!value.present) return value;
  return { present: true, value: value.value === null ? GUIDED_INIT_UNPINNED_MODEL : value.value };
}

function selectedList(question: GuidedInitQuestion | undefined): string[] {
  return question && Array.isArray(question.selectedValue) ? [...question.selectedValue] : [];
}

function selectedString(question: GuidedInitQuestion | undefined): string | null {
  return question && typeof question.selectedValue === "string" ? question.selectedValue : null;
}

function requiredList(
  questions: ReadonlyMap<GuidedInitQuestionId, GuidedInitQuestion>,
  id: GuidedInitQuestionId,
): string[] {
  const value = questions.get(id)?.selectedValue;
  if (!Array.isArray(value)) throw new TypeError(`Guided init answer ${id} is unresolved.`);
  return [...value];
}

function requiredString(
  questions: ReadonlyMap<GuidedInitQuestionId, GuidedInitQuestion>,
  id: GuidedInitQuestionId,
): string {
  const value = questions.get(id)?.selectedValue;
  if (typeof value !== "string") throw new TypeError(`Guided init answer ${id} is unresolved.`);
  return value;
}

function cloneValue(value: GuidedInitQuestionValue): GuidedInitQuestionValue {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

function freezeQuestion(question: GuidedInitQuestion): GuidedInitQuestion {
  return Object.freeze({
    ...question,
    options: freezeChoices(question.options),
    currentValue: cloneValue(question.currentValue),
    selectedValue: cloneValue(question.selectedValue),
    preselectedValue: cloneValue(question.preselectedValue),
    recommendedValue: cloneValue(question.recommendedValue),
  });
}
