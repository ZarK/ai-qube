import type { RuntimeCommandContext, RuntimeCommandResult } from '@tjalve/qube-cli/runtime';
import { renderSchema, renderSchemaJson } from '@tjalve/qube-cli/schema';
import { createRequire } from 'node:module';
import { EXECUTOR_COMMAND_REGISTRY } from './command_registry.js';
import { AIE_CONFIG_FILENAME, configToFileShape, getDefaults } from './config/index.js';
import { commandResult } from './runtime_result.js';

const requirePackage = createRequire(import.meta.url);
const packageJson = requirePackage('../package.json') as { name: string; version: string };

function schemaOptions() {
  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    bin: 'aie',
    sections: {
      config: {
        version: getDefaults().version,
        path: AIE_CONFIG_FILENAME,
        shape: ['version', 'providers', 'policy'],
        supportedProviders: {
          work: ['github', 'gitlab', 'linear'],
          review: ['github'],
          repository: ['local-git'],
          ci: ['github'],
          layout: ['local'],
        },
        reviewAdapters: ['github', 'local', 'mixed'],
        localReviewEvidence: {
          root: '.qube/aie/pr-reviews',
          requiredLanes: ['code-quality', 'security-maintainability', 'qa', 'final-gate'],
          runner: 'unavailable',
        },
        defaultConfig: configToFileShape(getDefaults()),
      },
    },
  };
}

export function handleSchema(context: RuntimeCommandContext): RuntimeCommandResult {
  const options = schemaOptions();
  const schema = renderSchema(EXECUTOR_COMMAND_REGISTRY, options);
  return commandResult(context, schema, renderSchemaJson(EXECUTOR_COMMAND_REGISTRY, options).trimEnd());
}
