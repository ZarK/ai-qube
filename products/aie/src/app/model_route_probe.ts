import { execFileSync } from 'node:child_process';
import type { RoutedReviewHostId } from '../core/policy.js';
import { modelRouteEnvironment, resolveModelHostExecutableSync, windowsPowerShellRouteEnvironment } from './model_review_runner.js';
import {
  getReviewHostAdapter,
  missingReviewHostCapabilities,
  sanitizeProbeText,
  type ModelHostExecutable,
  type ReviewHostProbeCommandRunner,
} from './review_host_adapters.js';

export { sanitizeProbeText } from './review_host_adapters.js';

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER = 1024 * 1024;

export type RoutedProbeHost = RoutedReviewHostId;

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

export type RouteProbeCommandRunner = ReviewHostProbeCommandRunner;
export type RouteProbeExecutableResolver = (host: RoutedProbeHost) => ModelHostExecutable;

function defaultProbeCommandRunner(executable: string, args: readonly string[]): string {
  return execFileSync(executable, [...args], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: modelRouteEnvironment(),
  });
}

export function probeModelRoute(host: RoutedProbeHost, model: string | null, runCommand: RouteProbeCommandRunner = defaultProbeCommandRunner, resolveExecutable: RouteProbeExecutableResolver = resolveModelHostExecutableSync, platform: string = process.platform): RouteProbeCheck {
  let adapter;
  try {
    adapter = getReviewHostAdapter(host);
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
      diagnostic: sanitizeProbeText(message.split(/\r?\n/)[0] || `no review host adapter is registered for "${host}"`),
    };
  }
  const missingCapabilities = missingReviewHostCapabilities(adapter);
  if (missingCapabilities.length > 0) {
    return {
      host,
      model,
      status: 'blocked',
      executable: null,
      version: null,
      modelListed: null,
      resolved: null,
      diagnostic: `The ${host} review host adapter is missing required capabilities (${missingCapabilities.join(', ')}). Fix the registered adapter capabilities before running routed review lanes.`,
    };
  }
  if (adapter.supportsPlatform && !adapter.supportsPlatform(platform)) {
    return {
      host,
      model,
      status: 'blocked',
      executable: null,
      version: null,
      modelListed: null,
      resolved: null,
      diagnostic: adapter.unsupportedPlatformMessage ?? `The ${host} review host does not support ${platform}.`,
    };
  }
  if (platform === 'win32' && adapter.windowsShell === 'powershell') {
    const shellHealth = windowsPowerShellRouteEnvironment(process.env);
    if (shellHealth.status === 'blocked') {
      return {
        host,
        model,
        status: 'blocked',
        executable: null,
        version: null,
        modelListed: null,
        resolved: null,
        diagnostic: shellHealth.diagnostic,
      };
    }
  }
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
      diagnostic: `The ${adapter.executableNames[0] ?? host} CLI is not resolvable (${sanitizeProbeText(message.split(/\r?\n/)[0] || 'no executable found')}). Install and authenticate the ${adapter.executableNames[0] ?? host} CLI on PATH before running routed review lanes.`,
    };
  }
  const executable = typeof resolved === 'string' ? resolved : resolved.executable;
  const prefixArgs = typeof resolved === 'string' ? [] : [...resolved.prefixArgs];
  const commandName = adapter.executableNames[0] ?? host;
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
      diagnostic: `The ${commandName} CLI resolved but did not report a version (${sanitizeProbeText(message.split(/\r?\n/)[0] || 'version command failed')}). Fix the ${commandName} CLI installation before running routed review lanes.`,
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
      diagnostic: `The ${commandName} CLI resolved but reported an empty version. Fix the ${commandName} CLI installation before running routed review lanes.`,
    };
  }
  const probeResult = adapter.probeAfterVersion({ model, executable, prefixArgs, runCommand, version, platform });
  if (probeResult.status === 'blocked') {
    return { host, model, status: 'blocked', executable, version, modelListed: probeResult.modelListed, resolved: null, diagnostic: probeResult.diagnostic };
  }
  return { host, model, status: 'ready', executable, version, modelListed: probeResult.modelListed, diagnostic: null, resolved };
}
