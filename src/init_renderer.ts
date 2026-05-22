import type { Config } from './config/index.js';
import type { AgentHostId, AgentHostProfile, CommandTarget, InstructionTarget } from './agent_hosts.js';
import { renderAgentInstructions, renderMakeItSoCommand } from './init_content.js';

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

function commandEnabled(config: Config, target: CommandTarget): boolean {
  return target.enabledBy === 'always' || (target.enabledBy === 'opencodeCommandAlias' && config.opencodeCommandAlias);
}

function commandBody(config: Config, target: CommandTarget): string {
  if (target.renderer === 'make-it-so') return renderMakeItSoCommand(config);
  const exhaustive: never = target.renderer;
  throw new Error(`Unsupported init command renderer ${exhaustive}. Next action: use a supported Executor host profile command target.`);
}

export function renderInitFiles(config: Config, profiles: AgentHostProfile[]): InitRenderResult {
  const files: InitRenderedFile[] = groupInstructionTargets(profiles).map(group => ({
    id: group.target.id,
    relativePath: group.target.path,
    kind: 'instruction',
    body: renderAgentInstructions(config, group.profiles),
    allowAppend: true,
    hosts: group.profiles.map(profile => profile.id),
    description: group.target.description,
  }));

  const warnings: string[] = [];
  for (const profile of profiles) {
    if (!profile.supportsProjectCommands) {
      const instructionTargets = profile.instructionTargets.map(target => target.path).join(', ');
      warnings.push(`${profile.displayName} project command files are not installed; ${profile.displayName} uses the managed ${instructionTargets} always-loaded instructions.`);
    }
    for (const target of profile.commandTargets) {
      if (!commandEnabled(config, target)) continue;
      files.push({
        id: target.id,
        relativePath: target.path,
        kind: 'command',
        body: commandBody(config, target),
        allowAppend: false,
        hosts: [profile.id],
        description: target.description,
      });
    }
  }

  return { files, warnings };
}
