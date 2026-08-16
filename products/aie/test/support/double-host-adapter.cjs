'use strict';

function createDoubleHostAdapter(id = 'double-host') {
  return {
    id,
    executableNames: ['double-host'],
    windowsExecutableNames: ['double-host.exe'],
    capabilities: { structuredOutput: true, readOnlySandbox: true },
    requiredCapabilities: ['structured-output', 'read-only-sandbox'],
    requiresPromptFile: false,
    requiresSchemaFile: false,
    windowsNodeModulesScriptPath() {
      return null;
    },
    windowsFallbackExecutablePath() {
      return null;
    },
    buildInvocation() {
      return { args: ['--double'], stdin: 'inspect' };
    },
    parseEnvelope(stdout) {
      return { text: stdout, sessionId: 'double-session' };
    },
    probeAfterVersion() {
      return { status: 'ready', modelListed: true, diagnostic: null };
    },
    listCatalog() {
      return ['double-1'];
    },
  };
}

function createDoubleHostProfile(id = 'double-host') {
  return {
    id,
    displayName: 'Double Host',
    instructionTargets: [{ id: 'double-instructions', path: 'AGENTS.md', description: 'Double host instructions.' }],
    commandTargets: [],
    todo: { tools: [], fallback: 'Use the visible checklist.', instruction: 'Keep todos visible.' },
    dialogue: { expectation: 'Operate in the double host session.' },
    subagents: { supported: false, instruction: 'Do not spawn subagents.' },
    hooks: { supported: false, description: 'No host hooks.' },
    supportsProjectCommands: false,
  };
}

module.exports = {
  createDoubleHostAdapter,
  createDoubleHostProfile,
};
