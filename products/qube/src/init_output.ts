import type { QubeInitFieldPlan } from "./init_config.js";
import { repositoryPrerequisiteStatusFor, type RepositoryPrerequisites } from "@tjalve/aie";

export interface PublicInitAnswer {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly reason: string;
}

export type InitPublisherReadinessState = "ready" | "degraded" | "unavailable" | "unconfigured";

export interface InitPublisherReadiness {
  readonly state: InitPublisherReadinessState;
  readonly nextAction?: string;
}

export interface InitHarnessPrompt {
  readonly displayName: string;
  readonly makeItSo: string;
}

export interface InitQuestionOutputOptions {
  readonly step: number;
  readonly label: string;
  readonly explanation: string;
  readonly userGlobal: string;
  readonly repository: string;
  readonly effective: string;
  readonly source: string;
  readonly recommendation: string;
  readonly reason: string;
  readonly docsUrl: string;
}

export interface InitOutputOptions {
  readonly scope: "global" | "repository";
  readonly mode: "plan" | "apply";
  readonly changed: boolean;
  readonly answers: readonly PublicInitAnswer[];
  readonly prerequisites?: RepositoryPrerequisites;
  readonly configuration?: {
    readonly scope: "repository";
    readonly action: "edit" | "inherit" | "inherit-all";
    readonly fields: readonly QubeInitFieldPlan[];
  };
  readonly primaryHarness?: InitHarnessPrompt;
  readonly pendingNextActions?: readonly string[];
  readonly reviewPublisherReadiness?: InitPublisherReadiness;
}

export const INIT_ACTION_LABELS = Object.freeze({
  aie: "Agent harness and Review setup",
  aib: "Project planning setup",
  aiq: "Quality checks setup",
  aiu: "Umpire setup",
  labels: "Issue tracker labels",
  config: "Repository setup choices",
  git: "Git initialization",
  packages: "Package requirements",
} as const);

export type InitActionId = keyof typeof INIT_ACTION_LABELS;

export interface InitFailureOptions {
  readonly actionId: string;
  readonly reason: string;
  readonly nextAction: string;
}

const READINESS_LABELS = Object.freeze({
  ready: "ready",
  degraded: "needs attention",
  unavailable: "unavailable",
  unconfigured: "not configured",
} satisfies Readonly<Record<InitPublisherReadinessState, string>>);

export function publicInitActionLabel(actionId: string): string {
  return Object.hasOwn(INIT_ACTION_LABELS, actionId)
    ? INIT_ACTION_LABELS[actionId as InitActionId]
    : "QUBE setup";
}

export function renderInitOutput(options: InitOutputOptions): string {
  if (
    options.mode === "apply"
    && !options.changed
    && (options.pendingNextActions?.length ?? 0) === 0
    && (!options.reviewPublisherReadiness || options.reviewPublisherReadiness.state === "ready")
    && !options.configuration
  ) {
    return `${options.scope === "global" ? "Global" : "Repository"} QUBE initialization is already current.\n${options.prerequisites ? `\n${renderInitPrerequisites(options.prerequisites)}` : ""}`;
  }

  const lines = [
    `${options.scope === "global" ? "Global" : "Repository"} QUBE initialization ${options.mode === "plan" ? "plan is ready" : "is complete"}.`,
    `Mode: ${options.mode}.`,
    `Persistent values changed: ${options.changed ? "yes" : "no"}.`,
  ];

  if (options.prerequisites) lines.push("", renderInitPrerequisites(options.prerequisites).trimEnd());

  if (options.configuration) {
    const userGlobalFound = options.configuration.fields.some(field => field.userGlobal.present);
    const repositoryOverrides = options.configuration.fields.filter(field => field.repository.present).length;
    const requiresRepositorySetup = options.configuration.fields.some(field => (
      !field.userGlobal.present
      && field.planned.source === "repository"
      && field.planned.repositoryAction === "add"
    ));
    const sourceCounts = new Map<string, number>();
    for (const field of options.configuration.fields) {
      sourceCounts.set(field.planned.source, (sourceCounts.get(field.planned.source) ?? 0) + 1);
    }
    lines.push(
      "",
      "Setup scope: This repository",
      `User-global setup: ${userGlobalFound ? "Found" : "Not found"}`,
      `Repository overrides: ${repositoryOverrides}`,
      `Effective sources: ${[...sourceCounts.entries()].map(([source, count]) => `${count} ${source}`).join(", ")}`,
      "",
      "User-global setup is inherited automatically.",
      "This repository stores only differences.",
      "",
      "Available actions:",
      requiresRepositorySetup
        ? "- Complete repository setup (recommended)."
        : repositoryOverrides === 0
          ? "- Use user-global setup (recommended)."
          : "- Keep effective setup (recommended).",
      "- Review or customize this repository with the guided setup or selection options.",
      ...(repositoryOverrides > 0 ? ["- Inherit all user-global settings with `qube init --inherit-all`."] : []),
      "",
      `Configuration action: ${options.configuration.action}`,
      "Configuration fields:",
    );
    for (const field of options.configuration.fields) {
      lines.push(
        `- ${field.id}`,
        `  User-global: ${field.userGlobal.present ? formatInitValue(field.userGlobal.value) : "—"}`,
        `  Repository: ${field.repository.present ? formatInitValue(field.repository.value) : "—"}`,
        `  Effective: ${formatInitValue(field.planned.effectiveValue)}`,
        `  Source: ${formatInitSource(field.planned.source, field.planned.derivedFrom)}`,
        `  Plan: ${field.planned.repositoryAction}`,
      );
    }
  }

  lines.push("", "Choices:");

  for (const answer of options.answers) {
    lines.push(`- ${answer.label}: ${answer.value}`);
    lines.push(`  Reason: ${answer.reason}`);
  }

  const readiness = options.reviewPublisherReadiness;
  if (readiness) {
    lines.push("", `GitHub review publisher: ${READINESS_LABELS[readiness.state]}.`);
  }

  if (options.mode === "apply" && options.scope === "repository" && options.primaryHarness) {
    lines.push(
      "",
      `Start a new ${options.primaryHarness.displayName} session so it loads the setup.`,
      `In the new session, run ${formatInvocation(options.primaryHarness.makeItSo)}.`,
    );
  }

  const followUps = uniqueNonEmpty([
    ...(options.pendingNextActions ?? []),
    ...(readiness && readiness.state !== "ready" && readiness.nextAction ? [readiness.nextAction] : []),
  ]);
  if (followUps.length > 0) {
    lines.push("", "Next actions:");
    for (const followUp of followUps) lines.push(`- ${followUp}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderInitPrerequisites(prerequisites: RepositoryPrerequisites): string {
  const lines = ["Prerequisites:"];
  for (const prerequisite of prerequisites.checks) {
    const reason = prerequisite.reasonCode ? ` (${prerequisite.reasonCode})` : "";
    lines.push(`- ${prerequisite.id}: ${prerequisite.status}${reason}`);
    lines.push(`  Required for: ${prerequisite.requiredFor.join(", ")}`);
    lines.push(`  ${prerequisite.summary}`);
    if (prerequisite.nextAction) lines.push(`  Next: ${prerequisite.nextAction}`);
    lines.push(`  Guide: ${prerequisite.docsUrl}`);
  }
  const localSetupStatus = repositoryPrerequisiteStatusFor(prerequisites, "local-setup");
  lines.push(`Local setup: ${localSetupStatus}. Later workflow stages can still need action.`);
  return `${lines.join("\n")}\n`;
}

export function renderInitQuestion(options: InitQuestionOutputOptions): string {
  return [
    "",
    `${options.step}. ${options.label}`,
    options.explanation,
    `User-global: ${options.userGlobal}`,
    `Repository: ${options.repository}`,
    `Effective: ${options.effective}`,
    `Source: ${options.source}`,
    `Recommended: ${options.recommendation}`,
    `Reason: ${options.reason}`,
    `Documentation: ${options.docsUrl}`,
    "",
  ].join("\n");
}

function formatInitValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  if (value === undefined) return "not set";
  return String(value);
}

function formatInitSource(source: string, derivedFrom: readonly string[] | undefined): string {
  if (source === "derived") return `derived${derivedFrom && derivedFrom.length > 0 ? ` from ${derivedFrom.join(", ")}` : ""}`;
  return source;
}

export function renderInitFailure(options: InitFailureOptions): string {
  return [
    `Action: ${publicInitActionLabel(options.actionId)}`,
    `Reason: ${options.reason}`,
    `Next action: ${options.nextAction}`,
    "",
  ].join("\n");
}

function formatInvocation(invocation: string): string {
  return `\`${invocation.trim()}\``;
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
