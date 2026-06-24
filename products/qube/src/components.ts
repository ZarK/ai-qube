export interface QubeComponent {
  readonly id: string;
  readonly command: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly summary: string;
  readonly capabilities?: {
    readonly localReview?: {
      readonly freshContextReviewerSupport: "host-provided" | "configured-command" | "unsupported";
      readonly promptOnlyFallback: boolean;
      readonly manualEvidenceSatisfiesRequiredGate: boolean;
      readonly provenanceRequired: readonly string[];
      readonly evidencePathPattern: string;
      readonly trustedHostProvenancePathPattern: string;
      readonly nextAction: string;
    };
  };
}

export const qubeComponents: readonly QubeComponent[] = Object.freeze([
  {
    id: "bootstrap",
    command: "aib",
    packageName: "@tjalve/aib",
    packageVersion: "0.1.1",
    summary: "Plan projects, specs, milestones, and work-item drafts."
  },
  {
    id: "executor",
    command: "aie",
    packageName: "@tjalve/aie",
    packageVersion: "0.1.4",
    summary: "Execute GitHub issue work through queue, branch, PR, and completion gates.",
    capabilities: {
      localReview: {
        freshContextReviewerSupport: "host-provided",
        promptOnlyFallback: true,
        manualEvidenceSatisfiesRequiredGate: false,
        provenanceRequired: ["runnerKind", "host", "freshContext", "promptOnly", "taskId/sessionId/threadId", "promptStackHash", "headSha", "providerPublishStatus"],
        evidencePathPattern: ".qube/aie/reviews/<issue>/<pr>/<head>/<lane>.json",
        trustedHostProvenancePathPattern: ".git/qube/aie/host-provenance/<issue>/<pr>/<head>/<lane>.json",
        nextAction: "Use qube aie pr gate <pr> --dry-run --json --local-review-prompts to render explicit lane bundles, then spawn independent host subagents and record matching local-host provenance before required gates can pass."
      }
    }
  },
  {
    id: "quality",
    command: "aiq",
    packageName: "@tjalve/aiq",
    packageVersion: "0.2.2",
    summary: "Run staged quality gates and produce agent-readable evidence."
  },
  {
    id: "umpire",
    command: "aiu",
    packageName: "@tjalve/aiu",
    packageVersion: "0.0.4",
    summary: "Guard agent continuation, host policy, and safe idle-work decisions."
  }
]);

export function findQubeComponent(value: string): QubeComponent | undefined {
  const normalized = value.trim().toLowerCase();
  return qubeComponents.find(component => component.id === normalized || component.command === normalized || component.packageName === normalized);
}
