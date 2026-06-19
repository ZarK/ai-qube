import { defineQubeAdapter, type QubeAdapterContract } from "@tjalve/qube-core";

export const githubAdapter = defineQubeAdapter({
  id: "github",
  packageName: "@tjalve/qube-adapter-github",
  surface: "github",
  owns: ["issues", "pull-requests", "checks", "review-gates"],
  boundary: "GitHub-specific state stays at the adapter edge; product packages consume provider-neutral contracts.",
  contractOnly: true,
} satisfies QubeAdapterContract);

export function githubIssueReference(issueNumber: number): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new RangeError("GitHub issue numbers must be positive safe integers.");
  }
  return `#${issueNumber}`;
}
