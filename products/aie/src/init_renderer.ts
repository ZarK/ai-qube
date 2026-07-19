import type { Config } from './config/index.js';
import type { AgentHostId, AgentHostProfile, CommandRenderer, CommandTarget, InstructionTarget } from './agent_hosts.js';
import { renderAgentInstructions, renderClaudeEconomyAgent, renderClaudeReviewFocusAgent, renderCodexEconomyAgent, renderCodexReviewFocusAgent, renderMakeItSoCommand, renderOpenCodeEconomyAgent, renderOpenCodeReviewFocusAgent } from './init_content.js';
import { economyCatalogAgent } from './review_catalog.js';

export interface InitRenderContext {
  workspaceAieRunner?: string | null;
}

export type InitRenderedFileKind = 'instruction' | 'command';

export interface InitRenderedFile {
  id: string;
  relativePath: string;
  kind: InitRenderedFileKind;
  body: string;
  allowAppend: boolean;
  hosts: AgentHostId[];
  description: string;
}

export interface InitRenderResult {
  files: InitRenderedFile[];
  warnings: string[];
}

interface GroupedInstructionTarget {
  target: InstructionTarget;
  profiles: AgentHostProfile[];
}

function groupInstructionTargets(profiles: AgentHostProfile[]): GroupedInstructionTarget[] {
  const byPath = new Map<string, GroupedInstructionTarget>();
  for (const profile of profiles) {
    for (const target of profile.instructionTargets) {
      const existing = byPath.get(target.path);
      if (existing) {
        existing.profiles.push(profile);
      } else {
        byPath.set(target.path, { target, profiles: [profile] });
      }
    }
  }
  return [...byPath.values()].sort((left, right) => left.target.path.localeCompare(right.target.path));
}

function hostLocalReviewEnabled(config: Config, hostId: AgentHostId): boolean {
  return (config.reviewAdapter === 'local' || config.reviewAdapter === 'mixed') && config.localReviewAgents.includes(hostId);
}

function commandEnabled(config: Config, target: CommandTarget, hostId: AgentHostId): boolean {
  if (target.enabledBy === 'always') return true;
  if (target.enabledBy === 'opencodeCommandAlias') return config.opencodeCommandAlias;
  if (target.enabledBy === 'hostLocalReview') return hostLocalReviewEnabled(config, hostId);
  return false;
}

function commandBody(config: Config, target: CommandTarget, context: InitRenderContext): string {
  const workspaceRunner = context.workspaceAieRunner ?? null;
  if (target.renderer === 'make-it-so') return renderMakeItSoCommand(config);
  if (target.renderer === 'codex-review-focus-agent') return renderCodexReviewFocusAgent(config);
  if (target.renderer === 'claude-review-focus-agent') return renderClaudeReviewFocusAgent(config);
  if (target.renderer === 'opencode-review-focus-agent') return renderOpenCodeReviewFocusAgent(config);
  if (target.renderer === 'codex-review-explorer-agent') return renderCodexEconomyAgent(economyCatalogAgent('qube-review-explorer'), config);
  if (target.renderer === 'codex-review-digest-agent') return renderCodexEconomyAgent(economyCatalogAgent('qube-review-digest'), config);
  if (target.renderer === 'codex-review-librarian-agent') return renderCodexEconomyAgent(economyCatalogAgent('qube-review-librarian'), config);
  if (target.renderer === 'claude-review-explorer-agent') return renderClaudeEconomyAgent(economyCatalogAgent('qube-review-explorer'), config);
  if (target.renderer === 'claude-review-digest-agent') return renderClaudeEconomyAgent(economyCatalogAgent('qube-review-digest'), config);
  if (target.renderer === 'claude-review-librarian-agent') return renderClaudeEconomyAgent(economyCatalogAgent('qube-review-librarian'), config);
  if (target.renderer === 'opencode-review-explorer-agent') return renderOpenCodeEconomyAgent(economyCatalogAgent('qube-review-explorer'), config);
  if (target.renderer === 'opencode-review-digest-agent') return renderOpenCodeEconomyAgent(economyCatalogAgent('qube-review-digest'), config);
  if (target.renderer === 'opencode-review-librarian-agent') return renderOpenCodeEconomyAgent(economyCatalogAgent('qube-review-librarian'), config);
  const exhaustive: never = target.renderer;
  throw new Error(`Unsupported init command renderer ${exhaustive as CommandRenderer}. Next action: use a supported Executor host profile command target.`);
}

export function renderInitFiles(config: Config, profiles: AgentHostProfile[], context: InitRenderContext = {}): InitRenderResult {
  const workspaceRunner = context.workspaceAieRunner ?? null;
  const files: InitRenderedFile[] = groupInstructionTargets(profiles).map(group => ({
    id: group.target.id,
    relativePath: group.target.path,
    kind: 'instruction',
    body: renderAgentInstructions(config, group.profiles, workspaceRunner),
    allowAppend: true,
    hosts: group.profiles.map(profile => profile.id),
    description: group.target.description,
  }));

  const warnings: string[] = [];
  for (const profile of profiles) {
    const enabledCommandTargets = profile.commandTargets.filter(target => commandEnabled(config, target, profile.id));
    if (!profile.supportsProjectCommands) {
      const instructionTargets = profile.instructionTargets.map(target => target.path).join(', ');
      warnings.push(`${profile.displayName} project command files are not installed; ${profile.displayName} uses the managed ${instructionTargets} always-loaded instructions.`);
    } else if (enabledCommandTargets.length === 0 && profile.commandTargets.length > 0) {
      warnings.push(`${profile.displayName} project command files are configured but none are enabled for the current review policy.`);
    }
    for (const target of profile.commandTargets) {
      if (!commandEnabled(config, target, profile.id)) continue;
      files.push({
        id: target.id,
        relativePath: target.path,
        kind: 'command',
        body: commandBody(config, target, context),
        allowAppend: false,
        hosts: [profile.id],
        description: target.description,
      });
    }
  }

  return { files, warnings };
}
