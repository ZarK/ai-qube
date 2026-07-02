export interface QubeComponent {
  readonly id: string;
  readonly command: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly summary: string;
  readonly capabilities?: {
    readonly localReview?: {
      readonly freshContextReviewerSupport: "host-provided" | "configured-command" | "prompt-only" | "unsupported";
      readonly promptOnlyFallback: boolean;
      readonly manualEvidenceSatisfiesRequiredGate: boolean;
      readonly provenanceRequired: readonly string[];
      readonly provenanceAlternatives: readonly {
        readonly anyOf: readonly string[];
        readonly description: string;
      }[];
      readonly evidencePathPattern: string;
      readonly hostProvenancePathPattern: string;
      readonly nextAction: string;
    };
    readonly hostSurfaces?: readonly {
      readonly id: string;
      readonly support: "installed" | "optional" | "unsupported";
      readonly summary: string;
    }[];
    readonly ciProviders?: readonly {
      readonly id: string;
      readonly support: "installed" | "optional" | "unsupported";
      readonly packageName: string;
      readonly summary: string;
    }[];
  };
}

type QubeHostSurface = NonNullable<NonNullable<QubeComponent["capabilities"]>["hostSurfaces"]>[number];

const executorHostSurfaces: readonly QubeHostSurface[] = Object.freeze([
  {
    id: "codex",
    support: "installed",
    summary: "Codex host capability reporting is built into @tjalve/qube."
  },
  {
    id: "claude-code",
    support: "installed",
    summary: "Claude Code host capability reporting is built into @tjalve/qube."
  },
  {
    id: "grok-build",
    support: "installed",
    summary: "Grok Build terminal CLI/TUI capability reporting is built into @tjalve/qube without installing or invoking Grok Build."
  },
  {
    id: "opencode",
    support: "optional",
    summary: "OpenCode host capability reporting lives in @tjalve/qube-adapter-opencode."
  }
]);

const executorCiProviders: NonNullable<NonNullable<QubeComponent["capabilities"]>["ciProviders"]> = Object.freeze([
  {
    id: "github",
    support: "installed",
    packageName: "@tjalve/qube-adapter-github",
    summary: "GitHub status checks and check runs are normalized through the GitHub review-forge adapter."
  },
  {
    id: "jenkins",
    support: "optional",
    packageName: "@tjalve/qube-adapter-jenkins",
    summary: "Jenkins classic and folder job build state is normalized into QUBE gate evidence without triggering or rerunning jobs."
  }
]);

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
        provenanceRequired: ["runnerKind", "host", "freshContext", "promptOnly", "promptStackHash", "headSha", "providerPublishStatus"],
        provenanceAlternatives: [
          {
            anyOf: ["taskId", "sessionId", "threadId"],
            description: "At least one separate host task, session, or thread identifier is required when the host exposes one."
          }
        ],
        evidencePathPattern: ".qube/aie/reviews/<issue>/<pr>/<head>/<lane>.json",
        hostProvenancePathPattern: ".git/qube/aie/host-provenance/<issue>/<pr>/<head>/<lane>.json",
        nextAction: "Use qube aie pr gate <pr> --dry-run --json --local-review-prompts to render explicit lane bundles. The active Codex host must spawn independent subagents and record matching local-host provenance before required gates can pass."
      },
      hostSurfaces: executorHostSurfaces,
      ciProviders: executorCiProviders
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
