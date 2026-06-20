export interface QubeComponent {
  readonly id: string;
  readonly command: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly summary: string;
}

export const qubeComponents: readonly QubeComponent[] = Object.freeze([
  {
    id: "bootstrap",
    command: "aib",
    packageName: "@tjalve/aib",
    packageVersion: "0.1.0",
    summary: "Plan projects, specs, milestones, and work-item drafts."
  },
  {
    id: "executor",
    command: "aie",
    packageName: "@tjalve/aie",
    packageVersion: "0.1.3",
    summary: "Execute GitHub issue work through queue, branch, PR, and completion gates."
  },
  {
    id: "quality",
    command: "aiq",
    packageName: "@tjalve/aiq",
    packageVersion: "0.2.1",
    summary: "Run staged quality gates and produce agent-readable evidence."
  },
  {
    id: "umpire",
    command: "aiu",
    packageName: "@tjalve/aiu",
    packageVersion: "0.0.3",
    summary: "Guard agent continuation, host policy, and safe idle-work decisions."
  }
]);

export function findQubeComponent(value: string): QubeComponent | undefined {
  const normalized = value.trim().toLowerCase();
  return qubeComponents.find(component => component.id === normalized || component.command === normalized || component.packageName === normalized);
}
