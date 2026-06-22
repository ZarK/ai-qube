export interface QubeComponent {
  readonly id: string;
  readonly command: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly summary: string;
}

export type QubeAdapterSurface = "host" | "work-provider" | "forge-provider" | "review-provider" | "ci-provider" | "layout";
export type QubeAdapterInstallStatus = "installed" | "missing";
export type QubeAdapterCapabilitySupport = "supported" | "missing" | "standalone" | "unsupported";

export interface QubeAdapterCapability {
  readonly id: string;
  readonly support: QubeAdapterCapabilitySupport;
  readonly owner: string;
  readonly summary: string;
  readonly nextAction: string;
}

export interface QubeAdapterReport {
  readonly id: string;
  readonly surface: QubeAdapterSurface;
  readonly packageName: string;
  readonly installStatus: QubeAdapterInstallStatus;
  readonly capabilityFlags: readonly string[];
  readonly installGuidance: string;
  readonly docsPath: string;
  readonly capabilities: readonly QubeAdapterCapability[];
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
    summary: "Execute GitHub issue work through queue, branch, PR, and completion gates."
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

export const qubeAdapterReports: readonly QubeAdapterReport[] = Object.freeze([
  adapterReport({
    id: "github-work-provider",
    surface: "work-provider",
    packageName: "@tjalve/qube-adapter-github",
    installStatus: "installed",
    capabilityFlags: ["work-item-queue", "pull-request-review", "ci-status", "unsupported-operation-reporting"],
    installGuidance: "GitHub work-provider behavior is available through the installed Executor provider boundary.",
    docsPath: "docs/qube-host-surfaces.md#github-provider-surface",
    capabilities: [
      capability({
        id: "work-item-queue",
        support: "supported",
        owner: "@tjalve/aie",
        summary: "Read GitHub issue queues through the Executor work provider.",
        nextAction: "Use qube aie queue --json or qube aie next --json."
      }),
      capability({
        id: "publish-release",
        support: "unsupported",
        owner: "repository release workflow",
        summary: "Release publishing is outside the QUBE GitHub adapter contract.",
        nextAction: "Use the package release workflow instead of expecting a GitHub adapter fallback."
      })
    ]
  }),
  adapterReport({
    id: "gitlab-work-provider",
    surface: "work-provider",
    packageName: "@tjalve/qube-adapter-gitlab",
    installStatus: "missing",
    capabilityFlags: ["work-item-queue", "issue-draft-rendering", "unsupported-lifecycle-reporting"],
    installGuidance: "Install the optional GitLab adapter package before selecting providers.work.kind=gitlab.",
    docsPath: "docs/qube-gitlab-provider-support.md",
    capabilities: [
      capability({
        id: "work-item-queue",
        support: "missing",
        owner: "@tjalve/qube-adapter-gitlab",
        summary: "GitLab issue queue reads require the optional adapter package and GitLab credentials.",
        nextAction: "Review qube install --work-provider gitlab --yes --dry-run before adding the adapter."
      }),
      capability({
        id: "sync-issue-status",
        support: "unsupported",
        owner: "@tjalve/qube-adapter-gitlab",
        summary: "GitLab lifecycle, merge request, approval, and CI pipeline mutations require tested mutation adapters.",
        nextAction: "Keep GitLab lifecycle mutations disabled until an explicit adapter capability is installed."
      })
    ]
  }),
  adapterReport({
    id: "opencode-host",
    surface: "host",
    packageName: "@tjalve/qube-adapter-opencode",
    installStatus: "missing",
    capabilityFlags: ["host-detection", "project-commands", "todo-tools", "unsupported-operation-reporting"],
    installGuidance: "Install an owning QUBE product host setup before relying on OpenCode project commands.",
    docsPath: "docs/qube-host-surfaces.md#opencode-host-surface",
    capabilities: [
      capability({
        id: "install-project-command",
        support: "missing",
        owner: "@tjalve/aib and @tjalve/aie",
        summary: "OpenCode project command files are created by owning product init commands, not by hidden composer defaults.",
        nextAction: "Use qube aib init --agent opencode or qube aie init . --tool opencode."
      }),
      capability({
        id: "open-pull-request",
        support: "unsupported",
        owner: "@tjalve/aie GitHub provider",
        summary: "OpenCode host support does not open or approve pull requests.",
        nextAction: "Use qube aie pr body <issue>, repository PR tooling, and qube aie pr gate <pr>."
      })
    ]
  }),
  adapterReport({
    id: "local-layout",
    surface: "layout",
    packageName: "@tjalve/qube",
    installStatus: "installed",
    capabilityFlags: ["component-discovery", "fixture-corpus-contracts"],
    installGuidance: "Layout detection and fixture corpora stay in core or shared test infrastructure unless heavyweight external tooling is introduced.",
    docsPath: "docs/qube-adapter-add-on-policy.md#layout-and-fixtures",
    capabilities: [
      capability({
        id: "component-discovery",
        support: "supported",
        owner: "@tjalve/qube",
        summary: "The composer reports installed component packages and adapter capability contracts without probing shell guesses.",
        nextAction: "Use qube components --json for the stable discovery payload."
      })
    ]
  })
]);

export function findQubeComponent(value: string): QubeComponent | undefined {
  const normalized = value.trim().toLowerCase();
  return qubeComponents.find(component => component.id === normalized || component.command === normalized || component.packageName === normalized);
}

function adapterReport(report: QubeAdapterReport): QubeAdapterReport {
  return Object.freeze({
    ...report,
    capabilityFlags: Object.freeze([...report.capabilityFlags]),
    capabilities: Object.freeze([...report.capabilities])
  });
}

function capability(input: QubeAdapterCapability): QubeAdapterCapability {
  return Object.freeze(input);
}
