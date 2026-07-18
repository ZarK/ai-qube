import { execFileSync } from 'node:child_process';
import { redact } from '../redact.js';
import { resolveModelHostExecutableSync, type ModelHostExecutable } from './model_review_runner.js';

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
  /** The probe-time resolution, reused by execution so the spawned process is the probed one. */
  resolved: ModelHostExecutable | null;
}

export type RouteProbeCommandRunner = (executable: string, args: readonly string[]) => string;
export type RouteProbeExecutableResolver = (host: RoutedProbeHost) => ModelHostExecutable;

// Host CLI output is untrusted: strip terminal control sequences and
// non-printable bytes, redact secrets, and bound the length before any of it
// reaches diagnostics, doctor output, or lane summaries.
export function sanitizeProbeText(value: string): string {
  return redact(value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[^ -~]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200);
}

function defaultProbeCommandRunner(executable: string, args: readonly string[]): string {
  return execFileSync(executable, [...args], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

export function probeModelRoute(host: RoutedProbeHost, model: string | null, runCommand: RouteProbeCommandRunner = defaultProbeCommandRunner, resolveExecutable: RouteProbeExecutableResolver = resolveModelHostExecutableSync): RouteProbeCheck {
  // Probe and execution share one resolver so a ready verdict always refers to
  // the executable routed execution would actually spawn.
  let resolved: ModelHostExecutable;
  try {
    resolved = resolveExecutable(host);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      host,
      model,
      status: 'blocked',
      executable: null,
      version: null,
      modelListed: null,
      resolved: null,
      diagnostic: `The ${host} CLI is not resolvable (${sanitizeProbeText(message.split(/\r?\n/)[0] || 'no executable found')}). Install and authenticate the ${host} CLI on PATH before running routed review lanes.`,
    };
  }
  const executable = typeof resolved === 'string' ? resolved : resolved.executable;
  const prefixArgs = typeof resolved === 'string' ? [] : [...resolved.prefixArgs];
  let version: string;
  try {
    version = sanitizeProbeText(runCommand(executable, [...prefixArgs, '--version']).split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? '');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      host,
      model,
      status: 'blocked',
      executable,
      version: null,
      modelListed: null,
      resolved: null,
      diagnostic: `The ${host} CLI resolved but did not report a version (${sanitizeProbeText(message.split(/\r?\n/)[0] || 'version command failed')}). Fix the ${host} CLI installation before running routed review lanes.`,
    };
  }
  if (version === '') {
    return {
      host,
      model,
      status: 'blocked',
      executable,
      version: null,
      modelListed: null,
      resolved: null,
      diagnostic: `The ${host} CLI resolved but reported an empty version. Fix the ${host} CLI installation before running routed review lanes.`,
    };
  }
  if (host !== 'grok' || !model) {
    // Codex exposes no model-catalog command, so model presence is verified at
    // execution time; hosts without a configured model use the host default.
    return { host, model, status: 'ready', executable, version, modelListed: null, diagnostic: null, resolved };
  }
  let catalogOutput: string;
  try {
    catalogOutput = runCommand(executable, [...prefixArgs, 'models']);
  } catch {
    return {
      host,
      model,
      status: 'blocked',
      executable,
      version,
      modelListed: null,
      resolved: null,
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
      resolved: null,
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
      resolved: null,
      diagnostic: `Configured review model "${model}" is not in the ${host} catalog (${sanitizeProbeText(catalog.join(', '))}). Update the trusted review model configuration to a listed model.`,
    };
  }
  return { host, model, status: 'ready', executable, version, modelListed: true, diagnostic: null, resolved };
}
