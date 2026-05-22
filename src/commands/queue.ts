import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata.js';
import { computeQueue } from '../queue/index.js';

export default class Queue extends Command {
  static description = commandDescription('queue');

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable queue data',
      default: false,
    }),
  };

  static examples = commandExamples('queue');

  async run(): Promise<void> {
    const { flags } = await this.parse(Queue);
    const q = await computeQueue();

    if (flags.json) {
      this.logJson({ ok: true, command: 'queue', ...q });
      return;
    }

    this.log('Issue Queue');
    this.log(`In-Progress: ${q.inProgressCount} | Ready: ${q.readyCount} | Blocked: ${q.blockedCount} | Drift: ${q.driftCount}`);
    if (q.multipleInProgress) {
      this.log('WARNING: Multiple S-InProgress issues detected. Run `aie deps fix --dry-run` then `aie deps fix`.');
    }
    this.log('');

    const groups: Record<string, typeof q.items> = { InProgress: [], Ready: [], Blocked: [] };
    for (const item of q.items) {
      groups[item.effectiveStatus].push(item);
    }

    for (const status of ['InProgress', 'Ready', 'Blocked'] as const) {
      const list = groups[status];
      if (list.length === 0) continue;
      this.log(`${status}:`);
      for (const item of list) {
        const drift = item.drifted ? ' (drift)' : '';
        let line = `  #${item.issue.number} "${item.issue.title}" (${item.issue.state})${drift}`;
        if (status === 'Blocked' && item.openBlockers.length > 0) {
          line += ` blocked by: ${item.openBlockers.map(n => `#${n}`).join(', ')}`;
        }
        this.log(line);
      }
      this.log('');
    }

    if (q.driftCount > 0) {
      this.log('Drift detected — labels disagree with dependency state. Run `aie deps fix --dry-run` then `aie deps fix`.');
    }
  }
}
