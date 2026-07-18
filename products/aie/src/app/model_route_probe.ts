import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER = 1024 * 1024;

export type RoutedProbeHost = 'codex' | 'grok';

export interface RouteProbeCheck {
  host: RoutedProbeHost;
  model: string | null;
  status: 'ready' | 'blocked';
  executable: string | null;
  version: string | null;
  modelListed: boolean | null;
  diagnostic: string | null;
}

export type RouteProbeCommandRunner = (executable: string, args: readonly string[]) => string;

function defaultProbeCommandRunner(executable: string, args: readonly string[]): string {
  return execFileSync(executable, [...args], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function candidateExecutables(host: RoutedProbeHost): string[] {
  const names = process.platform === 'win32'
    ? host === 'codex' ? ['codex.exe', 'codex.cmd', 'codex'] : ['grok.exe', 'grok.cmd', 'grok']
    : [host];
  if (process.platform === 'win32' && host === 'grok') {
    const fallback = join(homedir(), '.grok', 'bin', 'grok.exe');
    if (existsSync(fallback)) names.push(fallback);
  }
  return names;
}

export function parseGrokModelCatalog(output: string): string[] | null {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => /available models\s*:/i.test(line));
  if (headerIndex === -1) return null;
  const models: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const match = /^\s*\*?\s*([A-Za-z0-9][\w.-]*)/.exec(line);
    if (!match) {
      if (line.trim() === '') continue;
      break;
    }
    models.push(match[1]);
  }
  return models.length > 0 ? models : null;
}

export function probeModelRoute(host: RoutedProbeHost, model: string | null, runCommand: RouteProbeCommandRunner = defaultProbeCommandRunner): RouteProbeCheck {
  let executable: string | null = null;
  let version: string | null = null;
  let resolutionError = '';
  for (const candidate of candidateExecutables(host)) {
    try {
      version = runCommand(candidate, ['--version']).trim().split(/\r?\n/)[0] ?? '';
      executable = candidate;
      break;
    } catch (error: unknown) {
      resolutionError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!executable || !version) {
    return {
      host,
      model,
      status: 'blocked',
      executable: null,
      version: null,
      modelListed: null,
      diagnostic: `The ${host} CLI is not resolvable or did not report a version (${resolutionError.split(/\r?\n/)[0] || 'no executable candidate succeeded'}). Install and authenticate the ${host} CLI on PATH before running routed review lanes.`,
    };
  }
  if (host !== 'grok' || !model) {
    // Codex exposes no model-catalog command, so model presence is verified at
    // execution time; hosts without a configured model use the host default.
    return { host, model, status: 'ready', executable, version, modelListed: null, diagnostic: null };
  }
  let catalogOutput: string;
  try {
    catalogOutput = runCommand(executable, ['models']);
  } catch {
    return {
      host,
      model,
      status: 'blocked',
      executable,
      version,
      modelListed: null,
      diagnostic: `The ${host} CLI resolved (${version}) but its model catalog could not be read. Run \`${host} models\` manually and fix authentication or CLI state before running routed review lanes.`,
    };
  }
  const catalog = parseGrokModelCatalog(catalogOutput);
  if (!catalog) {
    return {
      host,
      model,
      status: 'blocked',
      executable,
      version,
      modelListed: null,
      diagnostic: `The ${host} CLI resolved (${version}) but its model catalog output was unrecognized. Run \`${host} models\` manually and update the trusted review route configuration.`,
    };
  }
  if (!catalog.includes(model)) {
    return {
      host,
      model,
      status: 'blocked',
      executable,
      version,
      modelListed: false,
      diagnostic: `Configured review model "${model}" is not in the ${host} catalog (${catalog.join(', ')}). Update the trusted review model configuration to a listed model.`,
    };
  }
  return { host, model, status: 'ready', executable, version, modelListed: true, diagnostic: null };
}
