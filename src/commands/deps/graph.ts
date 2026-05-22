import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata.js';
import { getDependencyGraph } from '../../deps.js';

export default class DepsGraph extends Command {
  static description = commandDescription('deps graph');

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable graph data (default: true for this command)',
      default: true,
    }),
  };

  static examples = commandExamples('deps graph');

  async run(): Promise<void> {
    const { flags } = await this.parse(DepsGraph);

    const graph = await getDependencyGraph();

    if (flags.json) {
      this.logJson({ ok: true, command: 'deps graph', nodes: graph.nodes, blockers: graph.blockers, cycles: graph.cycles });
    } else {
      // Minimal human representation when --no-json is explicitly used
      this.log('Dependency graph (nodes + blockers):');
      for (const n of graph.nodes) {
        const bl = (graph.blockers[n.number] || []).map(x => `#${x}`).join(', ');
        this.log(`  #${n.number} "${n.title}" (${n.state})${bl ? ' blocked by: ' + bl : ''}`);
      }
      if (graph.cycles.length > 0) {
        this.log('Cycles:');
        for (const cycle of graph.cycles) this.log(`  ${cycle.map(issue => `#${issue}`).join(' -> ')}`);
      }
    }
  }
}
