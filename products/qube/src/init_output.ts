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

export interface InitOutputOptions {
  readonly scope: "global" | "repository";
  readonly mode: "plan" | "apply";
  readonly changed: boolean;
  readonly answers: readonly PublicInitAnswer[];
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
  ) {
    return `${options.scope === "global" ? "Global" : "Repository"} QUBE initialization is already current.\n`;
  }

  const lines = [
    `${options.scope === "global" ? "Global" : "Repository"} QUBE initialization ${options.mode === "plan" ? "plan is ready" : "is complete"}.`,
    `Mode: ${options.mode}.`,
    `Persistent values changed: ${options.changed ? "yes" : "no"}.`,
    "",
    "Choices:",
  ];

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
