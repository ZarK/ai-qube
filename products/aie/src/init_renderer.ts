import type { Config } from './config/index.js';
import type { AgentHostId, AgentHostProfile, AgentHostReviewAgentRenderer, AgentHostReviewAgentTarget, InstructionTarget } from './agent_hosts.js';
import { renderAgentInstructions, renderClaudeEconomyAgent, renderClaudeReviewFocusAgent, renderCodexEconomyAgent, renderCodexReviewFocusAgent, renderGrokEconomyAgent, renderGrokReviewFocusAgent, renderMakeItSoCommand, renderMakeItSoSkill, renderModelRoutingRunnerFiles, renderOpenCodeEconomyAgent, renderOpenCodeReviewFocusAgent } from './init_content.js';
import { economyCatalogAgent } from './review_catalog.js';
import { reviewModeOf } from './review_mode.js';

export interface InitRenderContext {
  workspaceAieRunner?: string | null;
}

export type InitRenderedFileKind = 'instruction' | 'command' | 'skill' | 'subagent';

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
    const target = profile.instructionTarget;
    const existing = byPath.get(target.path);
    if (existing) {
      existing.profiles.push(profile);
    } else {
      byPath.set(target.path, { target, profiles: [profile] });
    }
  }
  return [...byPath.values()].sort((left, right) => left.target.path.localeCompare(right.target.path));
}

function reviewAgentBody(config: Config, target: AgentHostReviewAgentTarget): string {
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
  if (target.renderer === 'grok-review-focus-agent') return renderGrokReviewFocusAgent(config);
  if (target.renderer === 'grok-review-explorer-agent') return renderGrokEconomyAgent(economyCatalogAgent('qube-review-explorer'), config);
  if (target.renderer === 'grok-review-digest-agent') return renderGrokEconomyAgent(economyCatalogAgent('qube-review-digest'), config);
  if (target.renderer === 'grok-review-librarian-agent') return renderGrokEconomyAgent(economyCatalogAgent('qube-review-librarian'), config);
  const exhaustive: never = target.renderer;
  throw new Error(`Unsupported native review-agent renderer ${exhaustive as AgentHostReviewAgentRenderer}.`);
}

function nativeReviewEnabled(config: Config, profile: AgentHostProfile): boolean {
  return (config.reviewAdapter === 'local' || config.reviewAdapter === 'mixed')
    && reviewModeOf(config) !== 'isolated'
    && config.localReviewAgents.includes(profile.id);
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
    files.push({
      id: profile.makeItSo.id,
      relativePath: profile.makeItSo.path,
      kind: profile.makeItSo.kind,
      body: profile.makeItSo.kind === 'skill' ? renderMakeItSoSkill(config) : renderMakeItSoCommand(config),
      allowAppend: false,
      hosts: [profile.id],
      description: profile.makeItSo.description,
    });
    if (!nativeReviewEnabled(config, profile)) continue;
    for (const target of profile.review.local.agents) {
      files.push({
        id: target.id,
        relativePath: target.path,
        kind: 'subagent',
        body: reviewAgentBody(config, target),
        allowAppend: false,
        hosts: [profile.id],
        description: target.description,
      });
    }
  }

  for (const runner of renderModelRoutingRunnerFiles(config)) {
    files.push({
      id: runner.id,
      relativePath: runner.relativePath,
      kind: 'command',
      body: runner.body,
      allowAppend: false,
      hosts: [],
      description: runner.description,
    });
  }

  return { files, warnings };
}
