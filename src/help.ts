/**
 * CustomHelp - progressive discovery and agent-friendly help surfaces.
 *
 * Overrides showRootHelp (bare `aie`), showTopicHelp (incomplete groups like `aie labels`),
 * and augments command help with mutation/dry-run/JSON badges and examples.
 *
 * All text is derived from command_metadata.ts so it cannot drift from schema or suggestions.
 */

import { Command, Help, Interfaces } from '@oclif/core';
import { ALL_COMMAND_IDS, CommandSpec, COMMAND_BY_ID, getCommandSpec, suggestSimilarCommands } from './command_metadata';

type Topic = Interfaces.Topic;

export class CustomHelp extends Help {
  /** Root landing page: concise, shows common next commands, not a raw parser dump. */
  protected async showRootHelp(): Promise<void> {
    const { config } = this;

    const bin = config.bin;
    const version = config.pjson.version;

    const lines: string[] = [];

    lines.push(`${bin} - AI Executor: autonomous GitHub issue execution for agentic development`);
    lines.push(`Version ${version}`);
    lines.push('');
    lines.push('USAGE');
    lines.push(`  $ ${bin} <command> [options]`);
    lines.push('');
    lines.push('COMMON NEXT STEPS');
    lines.push(`  $ ${bin} doctor                 Check environment and config health`);
    lines.push(`  $ ${bin} init .                 Initialize repository (first time)`);
    lines.push(`  $ ${bin} labels setup           Create required GitHub labels`);
    lines.push(`  $ ${bin} queue                  View the ordered work queue`);
    lines.push(`  $ ${bin} start next             Start the next ready issue`);
    lines.push(`  $ ${bin} pr gate <pr>           Run PR review gate before merge`);
    lines.push(`  $ ${bin} complete <issue>       Complete issue after PR is merged`);
    lines.push('');
    lines.push('EXPLORATION');
    lines.push(`  $ ${bin} --help                 Full command list and global options`);
    lines.push(`  $ ${bin} help <command-or-topic>  or  ${bin} <command-or-topic> help`);
    lines.push(`  $ ${bin} schema --json          Machine-readable contract for agents`);
    lines.push(`  $ ${bin} completion             Shell completion setup instructions`);
    lines.push('');
    lines.push('MUTATION CONVENTIONS');
    lines.push('  Commands that change git, GitHub, or local files are marked "mutates".');
    lines.push('  All mutating commands support --dry-run. Use it.');
    lines.push('  Data goes to stdout. Warnings, progress, and diagnostics go to stderr.');
    lines.push('');
    lines.push('AGENT SURFACE');
    lines.push(`  Agents must use --json and ${bin} schema --json rather than parsing help text.`);
    lines.push(`  See docs/spec.md and docs/cli-framework-decision.md for the full contract.`);
    lines.push('');
    lines.push(`Run ${bin} doctor first if anything looks wrong.`);

    for (const line of lines) {
      this.log(line);
    }
  }

  /** Topic / incomplete command help: show available subcommands + examples + mutation note. */
  protected async showTopicHelp(topic: Topic): Promise<void> {
    const { config } = this;
    const bin = config.bin;

    const spec = getCommandSpec(topic.name);
    const title = spec?.summary || topic.description || topic.name;

    this.log(`${topic.name} - ${title}`);
    this.log('');

    if (spec?.description) {
      this.log(spec.description);
      this.log('');
    }

    // Find direct subcommands for this topic
    const subs = ALL_COMMAND_IDS.filter((id) => id.startsWith(topic.name + ' ') || id === topic.name);
    const children = subs
      .map((id) => COMMAND_BY_ID.get(id))
      .filter((c): c is CommandSpec => !!c && c.id !== topic.name);

    if (children.length > 0) {
      this.log('SUBCOMMANDS');
      for (const child of children) {
        const badge = this.mutationBadge(child);
        this.log(`  ${child.id.padEnd(18)} ${badge} ${child.summary}`);
      }
      this.log('');
    }

    if (spec?.examples?.length) {
      this.log('EXAMPLES');
      for (const ex of spec.examples) this.log(`  ${ex}`);
      this.log('');
    }

    this.log('HELP FORMS (all equivalent)');
    this.log(`  $ ${bin} help ${topic.name}`);
    this.log(`  $ ${bin} ${topic.name} help`);
    this.log(`  $ ${bin} ${topic.name} --help`);
    this.log('');

    if (spec?.mutates) {
      this.log('MUTATES: This topic contains commands that change repository or GitHub state.');
      this.log('Every mutating subcommand supports --dry-run.');
      this.log('');
    }

    this.log('NEXT ACTIONS');
    this.log(`  $ ${bin} ${topic.name} <subcommand> --help   Show help for a specific subcommand`);
    this.log(`  $ ${bin} doctor                                Verify environment before running mutating commands`);
  }

  /** Per-command help: add mutation badge, dry-run/JSON notes, examples from spec. */
  async showCommandHelp(command: Command.Loadable): Promise<void> {
    // Let the base formatter do most of the work, then append our extras.
    await super.showCommandHelp(command);

    const spec = getCommandSpec(command.id);
    if (!spec) return;

    this.log('');
    const badges: string[] = [];
    if (spec.mutates) badges.push('MUTATES');
    if (spec.supportsDryRun) badges.push('--dry-run supported');
    if (spec.supportsJson) badges.push('--json supported');
    if (badges.length) {
      this.log(`FLAGS: ${badges.join(' | ')}`);
    }

    if (spec.errorKinds.length > 0) {
      this.log(`ERROR KINDS (for --json): ${spec.errorKinds.join(', ')}`);
    }

    if (spec.examples.length > 0) {
      this.log('');
      this.log('EXAMPLES');
      for (const ex of spec.examples) this.log(`  ${ex}`);
    }

    if (spec.mutates) {
      this.log('');
      this.log('SAFETY: This command changes state. Always prefer --dry-run first.');
    }
  }

  private mutationBadge(spec: CommandSpec): string {
    if (!spec.mutates) return '(read-only)';
    return spec.supportsDryRun ? '(mutates, --dry-run)' : '(mutates)';
  }
}

export default CustomHelp;
