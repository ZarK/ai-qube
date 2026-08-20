import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { executorCiProviders, executorHostSurfaces, executorWorkProviders, type QubeDiscoveryOption } from "./components.js";

export type InstallQuestionOption = {
  readonly value: string;
  readonly label: string;
  readonly available?: boolean;
};

export type InstallQuestion = {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly InstallQuestionOption[];
  readonly recommendation: string;
  readonly recommendedValue: string | readonly string[] | boolean | null;
  readonly answered: boolean;
  readonly value: string | readonly string[] | boolean | null;
  readonly reason: string;
};

export const ISOLATED_REVIEW_HOSTS = Object.freeze(
  executorHostSurfaces
    .filter(option => option.capabilities.some(capability => capability.id === "isolated-review" && capability.support !== "unsupported"))
    .map(option => option.id),
);
export const HOST_REVIEW_HOSTS = Object.freeze(
  executorHostSurfaces
    .filter(option => option.capabilities.some(capability => capability.id === "local-review" && capability.support !== "unsupported"))
    .map(option => option.id),
);
export const INSTALL_REVIEW_MODES = Object.freeze(["isolated", "host", "external"] as const);
export const DEFAULT_INSTALL_UI_AUDIT_EVIDENCE_ROOT = "~/.qube/verification";
export type InstallReviewMode = (typeof INSTALL_REVIEW_MODES)[number];

export function recommendedInstallPackageManager(cwd: string): "pnpm" | "npm" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  try {
    const raw = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { packageManager?: string };
    if (typeof raw.packageManager === "string" && raw.packageManager.startsWith("pnpm@")) return "pnpm";
  } catch {
    // no package.json or invalid JSON
  }
  return existsSync(join(cwd, "package-lock.json")) ? "npm" : "pnpm";
}

export function isolatedReviewAvailable(
  selectedHosts: readonly string[],
  installedReviewHosts: readonly string[],
): boolean {
  const installed = new Set(installedReviewHosts);
  return selectedHosts.slice(1).some(host => (
    installed.has(host) && (ISOLATED_REVIEW_HOSTS as readonly string[]).includes(host)
  ));
}

export function hostReviewAvailable(selectedHosts: readonly string[]): boolean {
  const primaryHost = selectedHosts[0];
  return primaryHost !== undefined && (HOST_REVIEW_HOSTS as readonly string[]).includes(primaryHost);
}

export function isInstallReviewMode(value: string): value is InstallReviewMode {
  return (INSTALL_REVIEW_MODES as readonly string[]).includes(value);
}

export function availableInstallReviewModes(
  selectedHosts: readonly string[],
  installedReviewHosts: readonly string[],
  workProvider: string | undefined,
): readonly InstallReviewMode[] {
  return Object.freeze([
    ...(isolatedReviewAvailable(selectedHosts, installedReviewHosts) ? ["isolated" as const] : []),
    ...(hostReviewAvailable(selectedHosts) ? ["host" as const] : []),
    ...(workProvider !== "gitlab" ? ["external" as const] : []),
  ]);
}

export function recommendedInstallReviewMode(
  selectedHosts: readonly string[],
  installedReviewHosts: readonly string[],
  workProvider: string | undefined,
): InstallReviewMode | null {
  if (isolatedReviewAvailable(selectedHosts, installedReviewHosts)) return "isolated";
  if (hostReviewAvailable(selectedHosts)) return "host";
  return workProvider === "gitlab" ? null : "external";
}

export function installQuestionGuideComplete(
  flags: Readonly<Record<string, unknown>>,
  cwd: string,
  installedReviewHosts: readonly string[],
): boolean {
  return buildInstallQuestions({ flags, cwd, installedReviewHosts }).unansweredQuestionIds.length === 0;
}

export function invalidInstallGuideFlag(
  flags: Readonly<Record<string, unknown>>,
  installedReviewHosts: readonly string[],
): string | undefined {
  const hosts = readList(flags.host);
  const useDefaults = flags.yes === true || flags.defaults === true;
  const selectedHosts = hosts.length > 0 ? hosts : (useDefaults ? ["codex"] : []);
  const workProviders = readList(flags["work-provider"]);
  const workProvider = workProviders[0] ?? (useDefaults ? "github" : undefined);
  const availableModes = availableInstallReviewModes(selectedHosts, installedReviewHosts, workProvider);
  const reviewMode = flags["review-mode"];
  if (typeof reviewMode === "string") {
    if (!isInstallReviewMode(reviewMode)) {
      return `Invalid install option --review-mode=${reviewMode}. Use one of: ${INSTALL_REVIEW_MODES.join(", ")}.`;
    }
    if (reviewMode === "isolated" && selectedHosts.length > 0 && !isolatedReviewAvailable(selectedHosts, installedReviewHosts)) {
      return `Isolated review requires another selected, installed agent harness that can run it. Select and install one of: ${ISOLATED_REVIEW_HOSTS.join(", ")}; or use --review-mode host or --review-mode external.`;
    }
    if (reviewMode === "host" && selectedHosts.length > 0 && !hostReviewAvailable(selectedHosts)) {
      return `Host review is not available for the primary agent harness. Use --review-mode external, or select one of these primary harnesses: ${HOST_REVIEW_HOSTS.join(", ")}.`;
    }
    if (reviewMode === "external" && workProvider === "gitlab") {
      return "External review services are not available for GitLab. Select a primary or isolated Review harness, or choose another Issue tracker.";
    }
  }
  if (selectedHosts.length > 0 && workProvider && availableModes.length === 0) {
    return "No Review source is available for the selected Agent harnesses and Issue tracker. Select and install a compatible Review harness, or choose an Issue tracker with an external Review service.";
  }
  const evidenceRoot = flags["ui-audit-evidence-root"];
  if (typeof evidenceRoot === "string") {
    const trimmed = evidenceRoot.trim();
    if (trimmed === "" || trimmed === "custom") {
      return "Invalid install option --ui-audit-evidence-root. Pass an explicit directory such as ~/.qube/verification.";
    }
    if (trimmed.includes("\0") || trimmed.split(/[\\/]+/).some(segment => segment === "..")) {
      return "Invalid install option --ui-audit-evidence-root. Parent-directory segments are not allowed.";
    }
  }
  return undefined;
}

export function buildInstallQuestions(input: {
  flags: Readonly<Record<string, unknown>>;
  cwd: string;
  installedReviewHosts: readonly string[];
}): { readonly questions: readonly InstallQuestion[]; readonly unansweredQuestionIds: readonly string[] } {
  const host = readList(input.flags.host);
  const work = readList(input.flags["work-provider"]);
  const ci = readList(input.flags["ci-provider"]);
  const selectedHosts = host.length > 0 ? host : (input.flags.yes === true || input.flags.defaults === true ? ["codex"] : []);
  const workProvider = work[0] ?? (input.flags.yes === true || input.flags.defaults === true ? "github" : undefined);
  const isolatedOk = isolatedReviewAvailable(selectedHosts, input.installedReviewHosts);
  const hostOk = hostReviewAvailable(selectedHosts);
  const externalOk = workProvider !== "gitlab";
  const recommendedReviewMode = recommendedInstallReviewMode(selectedHosts, input.installedReviewHosts, workProvider);
  const packageManager = recommendedInstallPackageManager(input.cwd);
  const workAnswered = work.length > 0;
  const ciImplied = !workAnswered || work[0] === "github" || work[0] === "gitlab";
  const reviewModeFlag = typeof input.flags["review-mode"] === "string" ? String(input.flags["review-mode"]) : undefined;

  const questions: InstallQuestion[] = [
    question({
      id: "scope",
      prompt: "Where should QUBE be installed?",
      options: [
        { value: "local", label: "Project-local" },
        { value: "global", label: "Global manual" },
      ],
      recommendation: "Install project-local for reproducible automation.",
      recommendedValue: "local",
      answered: true,
      value: typeof input.flags.scope === "string" ? String(input.flags.scope) : "local",
      reason: "Install scope is a recommended default unless the operator asks to change it.",
    }),
    question({
      id: "package-manager",
      prompt: "Which package manager should the commands use?",
      options: [
        { value: "pnpm", label: "pnpm" },
        { value: "npm", label: "npm" },
      ],
      recommendation: `Use ${packageManager}.`,
      recommendedValue: packageManager,
      answered: true,
      value: typeof input.flags["package-manager"] === "string" ? String(input.flags["package-manager"]) : packageManager,
      reason: packageManager === "pnpm"
        ? "The repository already uses pnpm, or pnpm is the recommended default."
        : "The repository already uses npm.",
    }),
    question({
      id: "lifecycle-scripts",
      prompt: "Should generated install commands run lifecycle scripts?",
      options: [
        { value: "disabled", label: "Disabled" },
        { value: "review", label: "Review" },
      ],
      recommendation: "Disable lifecycle scripts.",
      recommendedValue: "disabled",
      answered: true,
      value: typeof input.flags["lifecycle-scripts"] === "string" ? String(input.flags["lifecycle-scripts"]) : "disabled",
      reason: "Lifecycle scripts stay disabled unless the operator asks to review them.",
    }),
    question({
      id: "host",
      prompt: "Which agent harness or harnesses should this repository use?",
      options: discoveryQuestionOptions(executorHostSurfaces),
      recommendation: "Choose the agent harnesses that will run QUBE.",
      recommendedValue: host[0] ?? "codex",
      answered: host.length > 0,
      value: host.length > 0 ? host : null,
      reason: host.length > 0
        ? "The invocation already selected host adapters."
        : "Agent harness selection chooses which QUBE instructions and workflow entry point to install.",
    }),
    question({
      id: "work-provider",
      prompt: "Which issue tracker should this repository use?",
      options: discoveryQuestionOptions(executorWorkProviders),
      recommendation: "Use GitHub when the remotes point at GitHub.",
      recommendedValue: "github",
      answered: workAnswered,
      value: workAnswered ? work : null,
      reason: workAnswered
        ? "The invocation already selected a work provider."
        : "Work provider selection chooses the adapter package for issue work.",
    }),
    question({
      id: "ci-provider",
      prompt: "Which automated checks (CI) provider should this repository use?",
      options: discoveryQuestionOptions(executorCiProviders),
      recommendation: "Use the same forge as the work provider when that CI adapter exists.",
      recommendedValue: work[0] === "gitlab" ? "gitlab" : "github",
      answered: ci.length > 0 || ciImplied,
      value: ci.length > 0 ? ci : (ciImplied ? [work[0] === "gitlab" ? "gitlab" : "github"] : null),
      reason: ci.length > 0
        ? "The invocation already selected a CI provider."
        : "CI follows the work provider unless the work provider does not imply CI.",
    }),
    question({
      id: "review-mode",
      prompt: "Which review mode should this repository use?",
      options: [
        { value: "isolated", label: "isolated: Executor runs model CLIs for the lane batch.", available: isolatedOk },
        { value: "host", label: "host: the coding agent runs one review subagent per lane.", available: hostOk },
        { value: "external", label: "external: a review service reviews the pull request.", available: externalOk },
      ],
      recommendation: isolatedOk
        ? "Use isolated. Another selected agent harness can run Review in a separate session."
        : hostOk
          ? "Use host. The primary agent harness can run native Review subagents."
          : externalOk
            ? "Use external. The selected agent harnesses cannot run Review."
            : "No Review source is available. Select and install a compatible Review harness, or choose another Issue tracker.",
      recommendedValue: recommendedReviewMode,
      answered: reviewModeFlag !== undefined,
      value: reviewModeFlag ?? null,
      reason: reviewModeFlag !== undefined
        ? "The invocation already selected the review mode."
        : "Review mode depends on the selected agent harness capabilities.",
    }),
    question({
      id: "ui-audit-evidence",
      prompt: "Where should this machine keep local UI audit evidence?",
      options: [
        { value: "~/.qube/verification", label: "QUBE user default (~/.qube/verification/)" },
        { value: "custom", label: "Custom directory that you supply" },
      ],
      recommendation: "Use the QUBE user default ~/.qube/verification/.",
      recommendedValue: DEFAULT_INSTALL_UI_AUDIT_EVIDENCE_ROOT,
      answered: typeof input.flags["ui-audit-evidence-root"] === "string",
      value: typeof input.flags["ui-audit-evidence-root"] === "string" ? String(input.flags["ui-audit-evidence-root"]) : null,
      reason: typeof input.flags["ui-audit-evidence-root"] === "string"
        ? "The invocation already selected the UI audit evidence root."
        : "Init recommends the QUBE user default ~/.qube/verification/.",
    }),
    question({
      id: "attribution-hygiene",
      prompt: "Should installed agent instructions keep public git and GitHub writes on the human project identity?",
      options: [
        { value: "true", label: "Yes. Install attribution hygiene rules." },
        { value: "false", label: "No. Omit those rules from installed instructions." },
      ],
      recommendation: "Install attribution hygiene rules.",
      recommendedValue: "true",
      answered: typeof input.flags["credit-warning"] === "boolean",
      value: typeof input.flags["credit-warning"] === "boolean" ? String(input.flags["credit-warning"]) : null,
      reason: typeof input.flags["credit-warning"] === "boolean"
        ? "The invocation already selected the attribution hygiene policy."
        : "Init recommends installing the rules so public history does not stamp uneven host credit.",
    }),
  ];
  return {
    questions,
    unansweredQuestionIds: questions.filter(item => !item.answered).map(item => item.id),
  };
}

const INSTALL_OPTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  codex: "Codex",
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  "grok-build": "Grok Build",
  cursor: "Cursor",
  github: "GitHub",
  gitlab: "GitLab",
  linear: "Linear",
  jira: "Jira",
  jenkins: "Jenkins",
  local: "Local only",
});

function discoveryQuestionOptions(options: readonly QubeDiscoveryOption[]): readonly InstallQuestionOption[] {
  return options.map(option => ({
    value: option.id,
    label: INSTALL_OPTION_LABELS[option.id] ?? option.id,
  }));
}

function question(input: InstallQuestion): InstallQuestion {
  return input;
}

function readList(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value.split(",").map(token => token.trim()).filter(token => token.length > 0);
}
