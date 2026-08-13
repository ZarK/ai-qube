import { randomBytes } from "node:crypto";

import type { LiveSuiteContext, ProviderProvisioner, ProvisionerSandbox, TaggedResource } from "../provisioner.js";
import { resourceTag, renderSeedChecklist, seededTitle, type SeedManifest } from "../seed-manifest.js";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

interface LinearLabel {
  readonly id: string;
  readonly name: string;
}

interface LinearState {
  readonly id: string;
  readonly name: string;
  readonly type?: string | null;
}

interface LinearIssueNode {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
}

export function createLinearProvisioner(context: LiveSuiteContext): ProviderProvisioner {
  const teamId = required(stringValue(context.config.teamId) ?? context.env.LINEAR_TEAM_ID, "LINEAR_TEAM_ID");
  const apiKey = required(context.env.LINEAR_API_KEY, "LINEAR_API_KEY");
  const endpoint = stringValue(context.config.endpoint) ?? LINEAR_ENDPOINT;
  const client = new LinearProvisionerClient(context.fetchImpl, endpoint, apiKey, context.budget.timeoutMs);

  return {
    providerId: "linear",
    mapsBlockedStatus: false,
    async construct(): Promise<ProvisionerSandbox> {
      const runId = randomBytes(4).toString("hex");
      const tag = resourceTag(runId);
      const label = await client.createLabel(teamId, tag);
      return {
        providerId: "linear",
        runId,
        tag,
        teamId,
        workIds: {},
        resources: [{ kind: "label", id: label.id, tag }],
      };
    },
    async seed(sandbox: ProvisionerSandbox, manifest: SeedManifest): Promise<ProvisionerSandbox> {
      const labelId = sandbox.resources.find(resource => resource.kind === "label")?.id;
      if (!labelId) throw new Error("Linear construct must create a tagged label before seed.");
      const states = await client.listStates(teamId);
      const workIds: Record<string, string> = {};
      const resources: TaggedResource[] = [...sandbox.resources];
      const created: Record<string, LinearIssueNode> = {};
      for (const seed of manifest.workItems) {
        const issue = await client.createIssue({
          teamId,
          title: seededTitle(sandbox.tag, seed.title),
          description: renderSeedChecklist(seed.checklist),
          priority: linearPriority(seed.priority),
          labelIds: [labelId],
          stateId: linearStateId(states, seed.status),
        });
        created[seed.id] = issue;
        workIds[seed.id] = issue.identifier;
        resources.push({ kind: "issue", id: issue.id, tag: sandbox.tag });
      }
      for (const seed of manifest.workItems) {
        const issue = created[seed.id];
        if (!issue || seed.blockedBy.length === 0) continue;
        const blockerLines: string[] = [];
        for (const blockerId of seed.blockedBy) {
          const blocker = created[blockerId];
          if (!blocker) throw new Error(`Linear seed blockedBy ${blockerId} is missing for ${seed.id}.`);
          await client.createRelation(issue.id, blocker.id);
          blockerLines.push(`Blocked by: ${blocker.identifier}`);
        }
        await client.updateIssue(issue.id, `${blockerLines.join("\n")}\n\n${renderSeedChecklist(seed.checklist)}`);
      }
      return { ...sandbox, workIds, resources };
    },
    async deconstruct(sandbox: ProvisionerSandbox): Promise<void> {
      for (const resource of [...sandbox.resources].reverse()) {
        if (resource.kind === "issue") await client.archiveIssue(resource.id);
        if (resource.kind === "label") await client.deleteLabel(resource.id);
      }
    },
    async sweep(tagPrefix = "qube-testkit-"): Promise<readonly TaggedResource[]> {
      const labels = (await client.listLabels(teamId)).filter(label => label.name.startsWith(tagPrefix));
      const leftover: TaggedResource[] = [];
      for (const label of labels) {
        const issues = await client.listIssuesForLabel(teamId, label.id);
        for (const issue of issues) {
          await client.archiveIssue(issue.id);
        }
        await client.deleteLabel(label.id);
        const remaining = await client.listIssuesForLabel(teamId, label.id);
        if (remaining.length > 0) leftover.push({ kind: "issue", id: remaining[0].id, tag: label.name });
        const stillThere = (await client.listLabels(teamId)).some(candidate => candidate.id === label.id);
        if (stillThere) leftover.push({ kind: "label", id: label.id, tag: label.name });
      }
      return leftover;
    },
  };
}

class LinearProvisionerClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  async createLabel(teamId: string, name: string): Promise<LinearLabel> {
    const data = await this.query<{ issueLabelCreate?: { issueLabel?: LinearLabel | null } }>(
      "mutation QubeTestkitLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id name } } }",
      { input: { teamId, name, description: "QUBE live suite sandbox label" } },
    );
    const label = data.issueLabelCreate?.issueLabel;
    if (!label?.id) throw new Error("Linear issueLabelCreate did not return a label id.");
    return label;
  }

  async deleteLabel(id: string): Promise<void> {
    await this.query(
      "mutation QubeTestkitLabelDelete($id: String!) { issueLabelDelete(id: $id) { success } }",
      { id },
      { allowMissing: true },
    );
  }

  async listLabels(teamId: string): Promise<LinearLabel[]> {
    const data = await this.query<{ team?: { labels?: { nodes?: LinearLabel[] } } }>(
      "query QubeTestkitLabels($teamId: String!) { team(id: $teamId) { labels(first: 250) { nodes { id name } } } }",
      { teamId },
    );
    return data.team?.labels?.nodes ?? [];
  }

  async listStates(teamId: string): Promise<LinearState[]> {
    const data = await this.query<{ team?: { states?: { nodes?: LinearState[] } } }>(
      "query QubeTestkitStates($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }",
      { teamId },
    );
    return data.team?.states?.nodes ?? [];
  }

  async createIssue(input: {
    readonly teamId: string;
    readonly title: string;
    readonly description: string;
    readonly priority: number;
    readonly labelIds: readonly string[];
    readonly stateId?: string;
  }): Promise<LinearIssueNode> {
    const data = await this.query<{ issueCreate?: { issue?: LinearIssueNode | null } }>(
      "mutation QubeTestkitIssue($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier title } } }",
      { input },
    );
    const issue = data.issueCreate?.issue;
    if (!issue?.id || !issue.identifier) throw new Error("Linear issueCreate did not return an issue.");
    return issue;
  }

  async updateIssue(id: string, description: string): Promise<void> {
    await this.query(
      "mutation QubeTestkitIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      { id, input: { description } },
    );
  }

  async createRelation(issueId: string, relatedIssueId: string): Promise<void> {
    await this.query(
      "mutation QubeTestkitRelation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }",
      { input: { issueId, relatedIssueId, type: "blockedBy" } },
    );
  }

  async archiveIssue(id: string): Promise<void> {
    await this.query(
      "mutation QubeTestkitArchive($id: String!) { issueArchive(id: $id) { success } }",
      { id },
      { allowMissing: true },
    );
  }

  async listIssuesForLabel(teamId: string, labelId: string): Promise<readonly { readonly id: string }[]> {
    const data = await this.query<{ team?: { issues?: { nodes?: { id: string }[] } } }>(
      "query QubeTestkitLabeled($teamId: String!, $labelId: ID!) { team(id: $teamId) { issues(first: 50, filter: { labels: { id: { eq: $labelId } }, archivedAt: { null: true } }) { nodes { id } } } }",
      { teamId, labelId },
    );
    return data.team?.issues?.nodes ?? [];
  }

  private async query<T>(
    query: string,
    variables: Record<string, unknown>,
    options: { readonly allowMissing?: boolean } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      if (options.allowMissing && (response.status === 404 || response.status === 400)) return {} as T;
      throw new Error(`Linear provisioner GraphQL request failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
    if (payload.errors?.length && !options.allowMissing) {
      throw new Error(`Linear provisioner GraphQL errors: ${payload.errors.map(error => error.message ?? "unknown").join("; ")}.`);
    }
    return payload.data ?? ({} as T);
  }
}

function linearPriority(priority: string): number {
  if (priority === "critical") return 1;
  if (priority === "high") return 2;
  if (priority === "medium") return 3;
  if (priority === "low") return 4;
  return 0;
}

function linearStateId(states: readonly LinearState[], status: string): string | undefined {
  const wanted = status === "in-progress" ? "started" : "unstarted";
  return states.find(state => (state.type ?? "").toLowerCase() === wanted)?.id
    ?? states.find(state => (state.type ?? "").toLowerCase() === "backlog")?.id
    ?? states[0]?.id;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Linear provisioner requires ${name}.`);
  return value;
}
