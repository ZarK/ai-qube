import type { RuntimeCommandContext, RuntimeCommandResult } from '@tjalve/qube-cli/runtime';
import { createRequire } from 'node:module';
import { getImplementedCommands } from './command_metadata.js';
import { configToFileShape, getDefaults } from './config/index.js';
import { commandResult, outputJson } from './runtime_result.js';

const requirePackage = createRequire(import.meta.url);
const packageJson = requirePackage('../package.json') as { version: string };

export function handleSchema(context: RuntimeCommandContext): RuntimeCommandResult {
  const schema = {
    ok: true,
    command: 'schema',
    version: packageJson.version,
    config: {
      version: getDefaults().version,
      path: 'aie.config.json',
      shape: ['version', 'providers', 'policy'],
      supportedProviders: {
        work: ['github'],
        review: ['github'],
        repository: ['local-git'],
        ci: ['github'],
        layout: ['local'],
      },
      defaultConfig: configToFileShape(getDefaults()),
    },
    commands: getImplementedCommands(),
  };
  return commandResult(context, schema, outputJson(schema).trimEnd());
}
