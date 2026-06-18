import type { RunStartResult, RunStatusResult, RunStopResult, RunWaitResult } from './local_app_runner_types.js';

export function formatRunResult(result: RunStartResult | RunStatusResult | RunWaitResult | RunStopResult): string {
  const lines: string[] = [];
  if (result.command === 'run start') {
    lines.push(`Run start ${result.name}: ${result.ok ? (result.dryRun ? 'planned' : 'started') : 'blocked'}.`);
    lines.push(`Command: ${result.commandLine.join(' ')}`);
    lines.push(`Working directory: ${result.cwd}`);
    if (result.pid) lines.push(`PID: ${result.pid}`);
    lines.push(`Logs: ${result.paths.stdoutPath} / ${result.paths.stderrPath}`);
  } else if (result.command === 'run status') {
    lines.push(`Run status ${result.name}: ${result.status}.`);
    if (result.metadata) {
      lines.push(`PID: ${result.metadata.pid}`);
      lines.push(`Command: ${result.metadata.command.join(' ')}`);
      lines.push(`Working directory: ${result.metadata.cwd}`);
    }
  } else if (result.command === 'run wait') {
    lines.push(`Run wait ${result.name}: ${result.status}.`);
    lines.push(`URL: ${result.url}`);
    lines.push(`Attempts: ${result.attempts}; elapsed: ${result.elapsedMs}ms; HTTP: ${result.httpStatus ?? 'none'}`);
  } else {
    lines.push(`Run stop ${result.name}: ${result.status}.`);
    if (result.pid) lines.push(`PID: ${result.pid}`);
  }
  if ('error' in result && result.error) lines.push(`Error: ${result.error}`);
  if ('logTail' in result) {
    if (result.logTail.stdout.length > 0) lines.push('stdout tail:', ...result.logTail.stdout.map(line => `  ${line}`));
    if (result.logTail.stderr.length > 0) lines.push('stderr tail:', ...result.logTail.stderr.map(line => `  ${line}`));
  }
  lines.push(`Next action: ${result.nextAction}`);
  return `${lines.join('\n')}\n`;
}
