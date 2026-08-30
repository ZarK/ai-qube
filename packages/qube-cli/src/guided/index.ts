import {
  confirm as clackConfirm,
  isCancel,
  log,
  select as clackSelect,
  spinner as clackSpinner,
  text as clackText,
  type ConfirmOptions,
  type Option,
  type SelectOptions,
  type TextOptions
} from "@clack/prompts";

import { validateInstallerChoices, type InstallerChoice } from "../installer/index.js";
import { evaluatePromptGate, type PromptGateOptions } from "../prompts/index.js";
import { redactText } from "../redaction/index.js";

export interface GuidedSection {
  readonly number: number;
  readonly title: string;
}

export interface GuidedRecommendation<Value> {
  readonly value: Value;
  readonly reason: string;
}

export interface GuidedDocumentation {
  readonly label: string;
  readonly url: string;
}

export interface GuidedApplicability {
  readonly applies: boolean;
  readonly reason?: string;
}

export type GuidedValidationState = "unchecked" | "valid" | "invalid";

export type GuidedValidator<Value> = (value: Value) => string | undefined | Promise<string | undefined>;

export interface GuidedValidation<Value> {
  readonly state?: GuidedValidationState;
  readonly message?: string;
  readonly check?: GuidedValidator<Value>;
}

/** A safe, human-facing question. Callers remain responsible for never supplying secret material. */
export interface GuidedQuestion<Value> {
  readonly section: GuidedSection;
  readonly label: string;
  readonly explanation: string;
  readonly recommendation?: GuidedRecommendation<Value>;
  readonly documentation?: GuidedDocumentation;
  readonly currentValue?: Value;
  readonly valueSource?: string;
  readonly applicability?: GuidedApplicability;
  readonly validation?: GuidedValidation<Value>;
  readonly answerSource?: string;
  readonly formatValue?: (value: Value) => string;
}

export type GuidedChoice<Value extends string = string> = InstallerChoice<Value>;

export interface GuidedAnswer<Value> {
  readonly status: "answered";
  readonly value: Value;
  readonly source: string;
}

export interface GuidedCancellation {
  readonly status: "cancelled";
  readonly reason: string;
  readonly writeAllowed: false;
}

export interface GuidedSkip {
  readonly status: "skipped";
  readonly reason: string;
  readonly writeAllowed: false;
}

export type GuidedPromptResult<Value> = GuidedAnswer<Value> | GuidedCancellation | GuidedSkip;

export interface GuidedProgressIndicator {
  start(message?: string): void;
  stop(message?: string): void;
  error(message?: string): void;
}

export interface GuidedPromptAdapter {
  text(options: TextOptions): Promise<string | symbol>;
  select<Value extends string>(options: SelectOptions<Value>): Promise<Value | symbol>;
  confirm(options: ConfirmOptions): Promise<boolean | symbol>;
  isCancel(value: unknown): value is symbol;
  spinner(): GuidedProgressIndicator;
}

export interface GuidedPresenterOptions {
  readonly output?: (message: string) => void;
  readonly prompts?: GuidedPromptAdapter;
  readonly gate?: Omit<PromptGateOptions<never>, "value" | "defaultValue">;
}

export interface GuidedProgressOptions {
  readonly action: string;
  readonly success?: string;
  readonly failure?: string;
}

export interface GuidedDecision {
  readonly label: string;
  readonly value: string;
  readonly reason?: string;
  readonly source?: string;
}

export interface GuidedSummary {
  readonly title?: string;
  readonly scope: string;
  readonly decisions?: readonly GuidedDecision[];
  readonly applied: "changed" | "unchanged" | "not-written";
  readonly readiness?: "ready" | "degraded" | "unavailable";
  readonly nextAction?: string;
}

export interface GuidedFailure {
  readonly action: string;
  readonly reason: string;
  readonly nextAction: string;
}

export interface GuidedPresenter {
  askText(question: GuidedQuestion<string>): Promise<GuidedPromptResult<string>>;
  choose<Value extends string>(question: GuidedQuestion<Value>, choices: readonly GuidedChoice<Value>[]): Promise<GuidedPromptResult<Value>>;
  confirm(question: GuidedQuestion<boolean>): Promise<GuidedPromptResult<boolean>>;
  progress<Value>(options: GuidedProgressOptions, operation: () => Promise<Value> | Value): Promise<Value>;
  cancel(reason?: string): GuidedCancellation;
  summarize(summary: GuidedSummary): void;
  fail(failure: GuidedFailure): void;
}

export function defineGuidedQuestion<Value>(question: GuidedQuestion<Value>): Readonly<GuidedQuestion<Value>> {
  validateQuestion(question);
  return Object.freeze(question);
}

export function renderGuidedQuestion<Value>(question: GuidedQuestion<Value>, options: { readonly includeSection?: boolean } = {}): string {
  validateQuestion(question);
  const formatValue = question.formatValue ?? String;
  const lines = options.includeSection === false ? [] : [`${question.section.number}. ${question.section.title}`];
  lines.push(question.label, question.explanation);
  if (question.recommendation !== undefined) {
    lines.push(`Recommended: ${safe(formatValue(question.recommendation.value))}`);
    lines.push(`Why: ${safe(question.recommendation.reason)}`);
  }
  if (question.documentation !== undefined) {
    lines.push(`Documentation: ${safe(question.documentation.label)} (${safe(question.documentation.url)})`);
  }
  if (question.currentValue !== undefined) {
    lines.push(`Current value: ${safe(formatValue(question.currentValue))}`);
  }
  if (question.valueSource !== undefined) {
    lines.push(`Value source: ${safe(question.valueSource)}`);
  }
  if (question.validation?.state !== undefined) {
    lines.push(`Validation: ${question.validation.state}${question.validation.message ? ` - ${safe(question.validation.message)}` : ""}`);
  }
  if (question.answerSource !== undefined) {
    lines.push(`Answer source: ${safe(question.answerSource)}`);
  }
  if (question.applicability?.applies === false) {
    lines.push(`Not applicable${question.applicability.reason ? `: ${safe(question.applicability.reason)}` : "."}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderGuidedSummary(summary: GuidedSummary): string {
  requireText(summary.scope, "summary.scope");
  const lines = [summary.title ?? "Summary", `Scope: ${safe(summary.scope)}`];
  for (const decision of summary.decisions ?? []) {
    requireText(decision.label, "decision.label");
    requireText(decision.value, "decision.value");
    lines.push(`${safe(decision.label)}: ${safe(decision.value)}`);
    if (decision.reason !== undefined) lines.push(`Reason: ${safe(decision.reason)}`);
    if (decision.source !== undefined) lines.push(`Source: ${safe(decision.source)}`);
  }
  lines.push(`Applied: ${summary.applied}`);
  if (summary.readiness !== undefined) lines.push(`Readiness: ${summary.readiness}`);
  if (summary.nextAction !== undefined) lines.push(`Next action: ${safe(summary.nextAction)}`);
  return `${lines.join("\n")}\n`;
}

export function renderGuidedFailure(failure: GuidedFailure): string {
  requireText(failure.action, "failure.action");
  requireText(failure.reason, "failure.reason");
  requireText(failure.nextAction, "failure.nextAction");
  return `Action: ${safe(failure.action)}\nReason: ${safe(failure.reason)}\nNext action: ${safe(failure.nextAction)}\n`;
}

export function createGuidedPresenter(options: GuidedPresenterOptions = {}): GuidedPresenter {
  const output = options.output ?? (message => log.message(message.trimEnd()));
  const prompts = options.prompts ?? defaultPrompts;
  const shownSections = new Set<string>();

  const present = <Value>(question: GuidedQuestion<Value>): void => {
    const sectionKey = `${question.section.number}:${question.section.title}`;
    const includeSection = !shownSections.has(sectionKey);
    shownSections.add(sectionKey);
    output(renderGuidedQuestion(question, { includeSection }));
  };

  const prepare = <Value>(question: GuidedQuestion<Value>): GuidedPromptResult<Value> | undefined => {
    validateQuestion(question);
    if (question.applicability?.applies === false) {
      return Object.freeze({
        status: "skipped",
        reason: question.applicability.reason ?? `${question.label} does not apply.`,
        writeAllowed: false
      });
    }
    if (question.currentValue !== undefined && question.validation?.state === "valid") {
      return Object.freeze({ status: "answered", value: question.currentValue, source: question.answerSource ?? "current" });
    }
    const gate = evaluatePromptGate(options.gate ?? {});
    if (!gate.allowed) {
      throw new Error(renderGuidedFailure({
        action: `Answer ${question.label}`,
        reason: gate.message,
        nextAction: "Provide an explicit value or rerun in an interactive terminal."
      }).trimEnd());
    }
    present(question);
    return undefined;
  };

  const validate = async <Value>(question: GuidedQuestion<Value>, value: Value): Promise<string | undefined> => {
    return question.validation?.check?.(value);
  };

  const invalid = <Value>(question: GuidedQuestion<Value>, reason: string): void => {
    output(renderGuidedFailure({
      action: `Answer ${question.label}`,
      reason,
      nextAction: `Correct ${question.label} and try again.`
    }));
  };

  const presenter: GuidedPresenter = {
    async askText(question: GuidedQuestion<string>): Promise<GuidedPromptResult<string>> {
      const prepared = prepare(question);
      if (prepared !== undefined) return prepared;
      while (true) {
        const value = await prompts.text({
          message: question.label,
          ...(question.currentValue !== undefined ? { initialValue: question.currentValue } : {}),
          ...(question.recommendation !== undefined ? { defaultValue: question.recommendation.value } : {})
        });
        if (prompts.isCancel(value)) return cancellation();
        const message = await validate(question, value);
        if (message === undefined) return Object.freeze({ status: "answered", value, source: "prompt" });
        invalid(question, message);
      }
    },

    async choose<Value extends string>(question: GuidedQuestion<Value>, choices: readonly GuidedChoice<Value>[]) {
      validateInstallerChoices(choices);
      const prepared = prepare(question);
      if (prepared !== undefined) return prepared;
      const choiceOptions: Option<Value>[] = choices.map(choice => ({
          value: choice.value,
          label: choice.recommended === true ? `${choice.label} (recommended)` : choice.label,
          ...(choice.description === undefined ? {} : { hint: choice.description })
        }) as Option<Value>);
      while (true) {
        const value = await prompts.select({
          message: question.label,
          options: choiceOptions,
          ...(question.currentValue !== undefined ? { initialValue: question.currentValue } : question.recommendation !== undefined ? { initialValue: question.recommendation.value } : {})
        });
        if (prompts.isCancel(value)) return cancellation();
        const message = await validate(question, value);
        if (message === undefined) return Object.freeze({ status: "answered", value, source: "prompt" });
        invalid(question, message);
      }
    },

    async confirm(question: GuidedQuestion<boolean>): Promise<GuidedPromptResult<boolean>> {
      const prepared = prepare(question);
      if (prepared !== undefined) return prepared;
      while (true) {
        const value = await prompts.confirm({
          message: question.label,
          ...(question.currentValue !== undefined ? { initialValue: question.currentValue } : question.recommendation !== undefined ? { initialValue: question.recommendation.value } : {})
        });
        if (prompts.isCancel(value)) return cancellation();
        const message = await validate(question, value);
        if (message === undefined) return Object.freeze({ status: "answered", value, source: "prompt" });
        invalid(question, message);
      }
    },

    async progress<Value>(progressOptions: GuidedProgressOptions, operation: () => Promise<Value> | Value): Promise<Value> {
      requireText(progressOptions.action, "progress.action");
      const indicator = prompts.spinner();
      indicator.start(progressOptions.action);
      try {
        const value = await operation();
        indicator.stop(progressOptions.success ?? progressOptions.action);
        return value;
      } catch (error) {
        indicator.error(progressOptions.failure ?? `${progressOptions.action} failed.`);
        throw error;
      }
    },

    cancel(reason = "The guided interaction was cancelled.") {
      return cancellation(reason);
    },

    summarize(summary: GuidedSummary): void {
      output(renderGuidedSummary(summary));
    },

    fail(failure: GuidedFailure): void {
      output(renderGuidedFailure(failure));
    }
  };
  return Object.freeze(presenter);
}

const defaultPrompts: GuidedPromptAdapter = Object.freeze({
  text: clackText,
  select: clackSelect,
  confirm: clackConfirm,
  isCancel,
  spinner: () => clackSpinner()
});

function cancellation(reason = "The guided interaction was cancelled."): GuidedCancellation {
  return Object.freeze({ status: "cancelled", reason, writeAllowed: false });
}

function validateQuestion<Value>(question: GuidedQuestion<Value>): void {
  if (!Number.isSafeInteger(question.section.number) || question.section.number < 1) {
    throw new TypeError("question.section.number must be a positive integer.");
  }
  requireText(question.section.title, "question.section.title");
  requireText(question.label, "question.label");
  requireText(question.explanation, "question.explanation");
  if (question.recommendation !== undefined) requireText(question.recommendation.reason, "question.recommendation.reason");
  if (question.documentation !== undefined) {
    requireText(question.documentation.label, "question.documentation.label");
    requireText(question.documentation.url, "question.documentation.url");
  }
  if (question.valueSource !== undefined) requireText(question.valueSource, "question.valueSource");
  if (question.answerSource !== undefined) requireText(question.answerSource, "question.answerSource");
  if (question.validation?.state === "invalid" && question.validation.message === undefined) {
    throw new TypeError("question.validation.message is required when validation state is invalid.");
  }
}

function safe(value: string): string {
  return redactText(value);
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} must not be empty.`);
}
