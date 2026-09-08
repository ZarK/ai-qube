import { createCliError } from "@tjalve/qube-cli/errors";
import { defineGuidedQuestion, type GuidedPresenter, type GuidedPromptResult } from "@tjalve/qube-cli/guided";

export interface GitIdentityPromptAction {
  readonly key: "user.name" | "user.email";
  readonly scope: "repository" | "user-global";
  readonly value: string;
}

export interface MissingGitIdentity {
  readonly key: GitIdentityPromptAction["key"];
  readonly label: string;
}

export function validGitIdentityValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : undefined;
}

export async function collectGitIdentityPromptActions(
  presenter: GuidedPresenter,
  missing: readonly MissingGitIdentity[],
): Promise<readonly GitIdentityPromptAction[]> {
  const scope = requireAnswer(await presenter.choose(defineGuidedQuestion<GitIdentityPromptAction["scope"]>({
    section: { number: 1, title: "Git identity" },
    label: "Where should QUBE configure the missing Git identity values?",
    explanation: "Repository scope changes only this repository.",
    formatValue: value => value === "repository" ? "This repository" : "All repositories",
    recommendation: {
      value: "repository" as const,
      reason: "Use repository scope unless all repositories need the same identity.",
    },
  }), Object.freeze([
    Object.freeze({
      value: "repository" as const,
      label: "This repository",
      description: "Write only this repository's Git config.",
      recommended: true,
    }),
    Object.freeze({
      value: "user-global" as const,
      label: "All repositories",
      description: "Write the current user's global Git config.",
    }),
  ])), "select the Git identity scope");

  const actions: GitIdentityPromptAction[] = [];
  for (const identity of missing) {
    const value = requireAnswer(await presenter.askText(defineGuidedQuestion({
      section: { number: 1, title: "Git identity" },
      label: identity.label,
      explanation: `${identity.label} identifies the author of repository commits.`,
      validation: {
        check: answer => validGitIdentityValue(answer)
          ? undefined
          : `${identity.label} must be non-empty and cannot contain control characters.`,
      },
    })), `enter ${identity.label.toLowerCase()}`);
    actions.push(Object.freeze({ key: identity.key, scope, value: validGitIdentityValue(value)! }));
  }

  const confirmed = requireAnswer(await presenter.confirm(defineGuidedQuestion({
    section: { number: 1, title: "Git identity" },
    label: `Write ${actions.map(action => action.key).join(" and ")} to ${scope === "repository" ? "this repository" : "the user-global Git configuration"}?`,
    explanation: "QUBE writes the displayed Git identity values only after you confirm this action.",
    recommendation: { value: true, reason: "The repository needs an author name and email for commits." },
  })), "confirm the Git identity write");
  return confirmed ? Object.freeze(actions) : Object.freeze([]);
}

export async function confirmInitAction(
  presenter: GuidedPresenter,
  input: {
    readonly title: string;
    readonly label: string;
    readonly explanation: string;
    readonly recommended: boolean;
    readonly reason: string;
  },
): Promise<boolean> {
  return requireAnswer(await presenter.confirm(defineGuidedQuestion({
    section: { number: 1, title: input.title },
    label: input.label,
    explanation: input.explanation,
    recommendation: { value: input.recommended, reason: input.reason },
  })), input.label);
}

function requireAnswer<Value>(result: GuidedPromptResult<Value>, operation: string): Value {
  if (result.status === "answered") return result.value;
  throw createCliError({
    command: "qube init",
    kind: "prompt-cancelled",
    operation,
    likelyCause: result.reason,
    suggestedNextAction: "Rerun qube init and answer the prompt, or provide explicit non-interactive options.",
    category: "usage",
  });
}
