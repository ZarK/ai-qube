export type QubeProductId = "bootstrap" | "executor" | "quality" | "umpire";

export type QubeIntegrationSurface = "cli" | "github" | "opencode";
export type QubeCommandClassification =
  | "qube-facing workflow command"
  | "standalone package command"
  | "internal adapter command"
  | "compatibility command";
export type QubePathClassification =
  | "shared QUBE namespace"
  | "standalone product config"
  | "standalone product state"
  | "generated host integration"
  | "implementation-time workflow policy"
  | "test fixture or sample";

export interface QubeProductContract {
  readonly id: QubeProductId;
  readonly packageName: string;
  readonly commandName: string;
  readonly role: string;
  readonly standalone: true;
  readonly surfaces: readonly QubeIntegrationSurface[];
}

export interface QubeAdapterContract {
  readonly id: "github" | "opencode";
  readonly packageName: string;
  readonly surface: QubeIntegrationSurface;
  readonly owns: readonly string[];
  readonly boundary: string;
  readonly contractOnly: boolean;
}

export interface QubeCommandSurfaceContract {
  readonly productId: QubeProductId;
  readonly packageName: string;
  readonly commandPattern: string;
  readonly classification: QubeCommandClassification;
  readonly qubeFacing: boolean;
  readonly schemaRequired: boolean;
  readonly notes: string;
}

export interface QubePathContract {
  readonly owner: "qube" | QubeProductId | "repository";
  readonly pathPattern: string;
  readonly classification: QubePathClassification;
  readonly committed: boolean;
  readonly migrationPolicy: string;
}

export interface QubeRepoArtifactContract {
  readonly pathPattern: string;
  readonly classification: QubePathClassification;
  readonly productInstalledSurface: boolean;
  readonly notes: string;
}

export const qubeProductContracts = [
  {
    id: "bootstrap",
    packageName: "@tjalve/aib",
    commandName: "aib",
    role: "Plan and bootstrap work from idea to issue queue.",
    standalone: true,
    surfaces: ["cli", "github", "opencode"],
  },
  {
    id: "executor",
    packageName: "@tjalve/aie",
    commandName: "aie",
    role: "Execute GitHub issue work through repository and review gates.",
    standalone: true,
    surfaces: ["cli", "github", "opencode"],
  },
  {
    id: "quality",
    packageName: "@tjalve/aiq",
    commandName: "aiq",
    role: "Evaluate code quality and package readiness across languages.",
    standalone: true,
    surfaces: ["cli"],
  },
  {
    id: "umpire",
    packageName: "@tjalve/aiu",
    commandName: "aiu",
    role: "Coordinate safe agent continuation and host stop hooks.",
    standalone: true,
    surfaces: ["cli", "opencode"],
  },
] as const satisfies readonly QubeProductContract[];

export const qubeCommandSurfaceContracts = [
  {
    productId: "bootstrap",
    packageName: "@tjalve/aib",
    commandPattern: "aib init|status|next|answer|spec *|milestones *|work-items *",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Bootstrap planning commands are safe to discover through QUBE and keep provider mutation behind dry-run or local-file guards.",
  },
  {
    productId: "executor",
    packageName: "@tjalve/aie",
    commandPattern: "aie queue|start|switch|branch *|pr *|complete|review|doctor|schema|init|migrate",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Executor owns GitHub issue, PR, and review workflow behavior plus host instruction init/migration.",
  },
  {
    productId: "quality",
    packageName: "@tjalve/aiq",
    commandPattern: "aiq run|check|plan|doctor|setup|status|config|evidence|schema",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Quality workflow commands are discoverable by QUBE; mutating or tool-running commands expose dry-run and supply-chain metadata.",
  },
  {
    productId: "quality",
    packageName: "@tjalve/aiq",
    commandPattern: "aiq bench|watch|serve|hook install|ci setup|ignore write",
    classification: "standalone package command",
    qubeFacing: false,
    schemaRequired: true,
    notes: "AIQ benchmark, daemon, and adapter-guidance commands remain standalone package surfaces and are documented as such.",
  },
  {
    productId: "umpire",
    packageName: "@tjalve/aiu",
    commandPattern: "aiu config|doctor|status|paths|init|migrate|hook-stop|whip",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Umpire exposes continuation policy, trusted-state, OpenCode host integration, and local whip state commands.",
  },
] as const satisfies readonly QubeCommandSurfaceContract[];

export const qubePathContracts = [
  {
    owner: "qube",
    pathPattern: ".qube/",
    classification: "shared QUBE namespace",
    committed: false,
    migrationPolicy: "Reserved for future composer-level cache, logs, and install diagnostics; product defaults do not migrate into it automatically.",
  },
  {
    owner: "bootstrap",
    pathPattern: ".bootstrap/session.json",
    classification: "standalone product state",
    committed: false,
    migrationPolicy: "AIB init and planning commands must preview writes, preserve existing state, and require explicit force for conflicting managed files.",
  },
  {
    owner: "quality",
    pathPattern: ".aiq/aiq.config.json and .aiq/progress.json",
    classification: "standalone product config",
    committed: true,
    migrationPolicy: "AIQ config init creates missing files only; stage updates write progress intentionally and do not overwrite host config.",
  },
  {
    owner: "umpire",
    pathPattern: "aiu.config.json and .umpire/",
    classification: "standalone product config",
    committed: true,
    migrationPolicy: "AIU init and migrate are conflict-aware, dry-runnable, and preserve .umpire state, locks, and logs unless cleanup is explicitly confirmed.",
  },
  {
    owner: "executor",
    pathPattern: "aie.config.json",
    classification: "standalone product config",
    committed: true,
    migrationPolicy: "AIE init owns review/execution policy config and must keep copied repo workflow files separate from product config.",
  },
  {
    owner: "repository",
    pathPattern: "products/*/AGENTS.md and products/*/aie.config.json",
    classification: "implementation-time workflow policy",
    committed: true,
    migrationPolicy: "Repository-local implementation artifacts are not package-installed product surfaces unless a product command documents and writes them.",
  },
] as const satisfies readonly QubePathContract[];

export const qubeRepoArtifactContracts = [
  {
    pathPattern: "AGENTS.md",
    classification: "implementation-time workflow policy",
    productInstalledSurface: false,
    notes: "Root agent policy guides monorepo implementation and is not installed by QUBE packages.",
  },
  {
    pathPattern: "products/*/AGENTS.md",
    classification: "implementation-time workflow policy",
    productInstalledSurface: false,
    notes: "Package-directory agent policies guide repo work on that package; they do not imply installed package behavior.",
  },
  {
    pathPattern: "products/*/aie.config.json",
    classification: "implementation-time workflow policy",
    productInstalledSurface: false,
    notes: "Copied Executor config under package directories is local workflow policy, not evidence that those products own review-agent config.",
  },
  {
    pathPattern: "products/*/test-projects/**",
    classification: "test fixture or sample",
    productInstalledSurface: false,
    notes: "Fixture projects are used by tests and are not product config defaults.",
  },
] as const satisfies readonly QubeRepoArtifactContract[];

export function findQubeProduct(value: string): QubeProductContract | undefined {
  return qubeProductContracts.find((product) =>
    product.id === value || product.packageName === value || product.commandName === value
  );
}

export function defineQubeAdapter<T extends QubeAdapterContract>(adapter: T): Readonly<T> {
  return Object.freeze({ ...adapter });
}
