import type { RuntimeCommandHandler } from '@tjalve/qube-cli/runtime';
import { getAllBlockedIssues, getDependencyChain, getDependencyGraph, getDirectBlockers, getIssuesBlockedBy, getReadyIssues } from './deps.js';
import { githubIssueNumber } from '@tjalve/qube-adapter-github';
import { createGitHubWorkProvider } from '@tjalve/qube-adapter-github';
import { commandFailure, commandResult, stringArg } from './runtime_result.js';

function lineOutput(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function parseIssueNumber(input: string | undefined, command: string, role = 'issue'): number {
  if (!input) throw new Error(`Missing ${role} number.`);
  const cleaned = input.replace(/^#/, '').trim();
  if (!/^[1-9]\d*$/.test(cleaned)) throw new Error(`Invalid ${role} selector "${input}". Use a positive number such as 93 or shell-safe #93.`);
  const issueNumber = Number(cleaned);
  if (!Number.isSafeInteger(issueNumber)) throw new Error(`Invalid ${role} selector "${input}". Use a safe positive integer.`);
  return issueNumber;
}

function depsFailure(context: Parameters<RuntimeCommandHandler>[0], command: string, err: unknown, nextAction: string) {
  const cause = err instanceof Error ? err.message : String(err);
  const message = `Failed to run \`aie ${command}\`. Likely cause: ${cause}. Next action: ${nextAction}`;
  return commandFailure(context, { ok: false, command, error: message }, message);
}

export const handleDepsBlocked: RuntimeCommandHandler = async context => {
  try {
    const blocked = await getAllBlockedIssues();
    return commandResult(context, { ok: true, command: 'deps blocked', blocked }, lineOutput(['Blocked open issues:', ...(blocked.length === 0 ? ['  None.'] : blocked.map(item => `  #${item.number} "${item.title}" (${item.state}) blocked by: ${item.blockers.map(blocker => `#${blocker.number} (${blocker.state})`).join(', ')}`))]));
  } catch (err: unknown) {
    return depsFailure(context, 'deps blocked', err, 'verify GitHub authentication and repository access, then rerun `aie deps blocked`.');
  }
};

export const handleDepsBlockers: RuntimeCommandHandler = async context => {
  let issueNumber: number;
  try {
    issueNumber = parseIssueNumber(stringArg(context, 'issue'), 'deps blockers');
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse deps blockers issue. Likely cause: ${cause}. Next action: run \`aie deps blockers 93\` or \`aie deps blockers --help\`.`;
    return commandFailure(context, { ok: false, command: 'deps blockers', error: message }, message);
  }
  try {
    const workItem = await createGitHubWorkProvider().getWorkItem({ providerId: 'github', id: String(issueNumber) });
    const issue = { number: githubIssueNumber(workItem), title: workItem.title, state: workItem.state === 'open' ? 'OPEN' : 'CLOSED' };
    const blockers = await getDirectBlockers(issueNumber);
    return commandResult(context, { ok: true, command: 'deps blockers', issue, blockers }, lineOutput([`Direct blockers for #${issue.number} "${issue.title}" (${issue.state}):`, ...(blockers.length === 0 ? ['  None declared.'] : blockers.map(blocker => `  #${blocker.number} "${blocker.title}" (${blocker.state})`))]));
  } catch (err: unknown) {
    return depsFailure(context, 'deps blockers', err, `verify issue #${issueNumber}, GitHub authentication, and repository access, then rerun \`aie deps blockers ${issueNumber}\`.`);
  }
};

export const handleDepsBlocking: RuntimeCommandHandler = async context => {
  let issueNumber: number;
  try {
    issueNumber = parseIssueNumber(stringArg(context, 'issue'), 'deps blocking');
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse deps blocking issue. Likely cause: ${cause}. Next action: run \`aie deps blocking 93\` or \`aie deps blocking --help\`.`;
    return commandFailure(context, { ok: false, command: 'deps blocking', error: message }, message);
  }
  try {
    const blocked = await getIssuesBlockedBy(issueNumber);
    return commandResult(context, { ok: true, command: 'deps blocking', issue: issueNumber, blocked }, lineOutput([`Open issues blocked by #${issueNumber}:`, ...(blocked.length === 0 ? ['  None.'] : blocked.map(item => `  #${item.number} "${item.title}" (${item.state})`))]));
  } catch (err: unknown) {
    return depsFailure(context, 'deps blocking', err, `verify issue #${issueNumber}, GitHub authentication, and repository access, then rerun \`aie deps blocking ${issueNumber}\`.`);
  }
};

export const handleDepsChain: RuntimeCommandHandler = async context => {
  let issueNumber: number;
  try {
    issueNumber = parseIssueNumber(stringArg(context, 'issue'), 'deps chain');
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to parse deps chain issue. Likely cause: ${cause}. Next action: run \`aie deps chain 93\` or \`aie deps chain --help\`.`;
    return commandFailure(context, { ok: false, command: 'deps chain', error: message }, message);
  }
  try {
    const chain = await getDependencyChain(issueNumber);
    return commandResult(context, { ok: true, command: 'deps chain', issue: issueNumber, chain }, lineOutput([`Dependency chain for #${issueNumber}:`, ...chain.map(item => `  #${item.number} "${item.title}" (${item.state})`)]));
  } catch (err: unknown) {
    return depsFailure(context, 'deps chain', err, `verify issue #${issueNumber}, GitHub authentication, and repository access, then rerun \`aie deps chain ${issueNumber}\`.`);
  }
};

export const handleDepsGraph: RuntimeCommandHandler = async context => {
  try {
    const graph = await getDependencyGraph();
    return commandResult(context, { ok: true, command: 'deps graph', nodes: graph.nodes, blockers: graph.blockers, cycles: graph.cycles }, lineOutput(['Dependency graph (nodes + blockers):', ...graph.nodes.map(node => `  #${node.number} "${node.title}" (${node.state})${(graph.blockers[node.number] || []).length > 0 ? ' blocked by: ' + (graph.blockers[node.number] || []).map(issue => `#${issue}`).join(', ') : ''}`), ...(graph.cycles.length > 0 ? ['Cycles:', ...graph.cycles.map(cycle => `  ${cycle.map(issue => `#${issue}`).join(' -> ')}`)] : [])]));
  } catch (err: unknown) {
    return depsFailure(context, 'deps graph', err, 'verify GitHub authentication and repository access, then rerun `aie deps graph`.');
  }
};

export const handleDepsReady: RuntimeCommandHandler = async context => {
  try {
    const ready = await getReadyIssues();
    return commandResult(context, { ok: true, command: 'deps ready', ready }, lineOutput(['Ready issues (no open blockers):', ...(ready.length === 0 ? ['  None.'] : ready.map(item => `  #${item.number} "${item.title}" (${item.state})`))]));
  } catch (err: unknown) {
    return depsFailure(context, 'deps ready', err, 'verify GitHub authentication and repository access, then rerun `aie deps ready`.');
  }
};
