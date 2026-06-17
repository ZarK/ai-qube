import type { ArgumentMetadata, CommandMetadata, FlagMetadata, TopicMetadata } from "../metadata/index.js";
import type { CommandRegistry } from "../registry/index.js";
import { findCommand, findTopic, listCommands, listTopics } from "../registry/index.js";

export interface HelpRenderOptions {
  readonly bin: string;
  readonly packageVersion?: string | undefined;
  readonly description?: string | undefined;
}

export interface HelpRequest {
  readonly kind: "root" | "target";
  readonly targetTokens: readonly string[];
}

export interface Suggestion {
  readonly value: string;
  readonly distance: number;
}

export function normalizeHelpRequest(argv: readonly string[]): HelpRequest | undefined {
  if (argv.length === 0) {
    return { kind: "root", targetTokens: [] };
  }
  if (argv.length === 1 && argv[0] === "--help") {
    return { kind: "root", targetTokens: [] };
  }
  if (argv[0] === "help") {
    return argv.length === 1
      ? { kind: "root", targetTokens: [] }
      : { kind: "target", targetTokens: trimAtFirstFlag(argv.slice(1)) };
  }
  if (argv.includes("--help")) {
    return { kind: "target", targetTokens: trimAtFirstFlag(argv.filter((token) => token !== "--help")) };
  }
  if (argv.at(-1) === "help") {
    return { kind: "target", targetTokens: trimAtFirstFlag(argv.slice(0, -1)) };
  }
  return undefined;
}

export function renderHelp(registry: CommandRegistry, request: HelpRequest, options: HelpRenderOptions): string {
  if (request.kind === "root" || request.targetTokens.length === 0) {
    return renderRootHelp(registry, options);
  }
  const target = request.targetTokens.join(" ");
  const command = findCommand(registry, target);
  if (command) {
    return renderCommandHelp(command, options);
  }
  const topic = findTopic(registry, target);
  if (topic) {
    return renderTopicHelp(registry, topic, options);
  }
  const suggestion = suggestCommand(registry, target);
  const hint = suggestion ? `\nDid you mean "${suggestion.value}"?` : "";
  throw new Error(`Unknown help topic or command: ${target}${hint}`);
}

export function renderRootHelp(registry: CommandRegistry, options: HelpRenderOptions): string {
  return joinSections([
    [options.bin, options.description ?? "Metadata-driven command-line interface."].join("\n"),
    joinLines([
      "Usage:",
      `  ${options.bin} <command> [flags]`,
      `  ${options.bin} help <command>`,
      ...(options.packageVersion ? [`  ${options.bin} --version`] : [])
    ]),
    renderNameDescriptionSection("Topics:", listTopics(registry)),
    renderNameDescriptionSection("Commands:", listCommands(registry)),
    "Help invocations never execute command handlers."
  ]);
}

export function renderTopicHelp(registry: CommandRegistry, topic: TopicMetadata, options: HelpRenderOptions): string {
  const prefix = `${topic.name} `;
  const commands = listCommands(registry).filter((command) => command.name.startsWith(prefix));
  return joinSections([
    [topic.name, topic.description].join("\n"),
    joinLines(["Usage:", `  ${options.bin} ${topic.name} <command> [flags]`, `  ${options.bin} help ${topic.name} <command>`]),
    renderNameDescriptionSection("Commands:", commands),
    renderTopicCommandDetails(commands),
    "Help invocations never execute command handlers."
  ]);
}

export function renderCommandHelp(command: CommandMetadata, options: HelpRenderOptions): string {
  return joinSections([
    [command.name, command.description].join("\n"),
    joinLines(["Usage:", `  ${options.bin} ${command.name}${renderUsageSuffix(command)}`]),
    renderArguments(command.arguments ?? []),
    renderFlags(command.flags ?? []),
    renderExamples(command.examples ?? []),
    renderBehavior(command)
  ]);
}

export function suggestCommand(registry: CommandRegistry, input: string): Suggestion | undefined {
  const candidates = [
    ...listCommands(registry).map((command) => command.name),
    ...listCommands(registry).flatMap((command) => command.aliases ?? []),
    ...listTopics(registry).map((topic) => topic.name),
    ...listTopics(registry).flatMap((topic) => topic.aliases ?? [])
  ];
  return suggestValue(input, candidates);
}

export function suggestFlag(command: CommandMetadata, input: string): Suggestion | undefined {
  const normalizedInput = input.startsWith("-") ? input : `--${input}`;
  const candidates = (command.flags ?? []).flatMap(renderFlagTokens);
  const suggestion = suggestValue(normalizedInput, candidates);
  return suggestion ? { value: suggestion.value, distance: suggestion.distance } : undefined;
}

export function suggestValue(input: string, candidates: readonly string[]): Suggestion | undefined {
  const normalizedInput = input.trim();
  if (normalizedInput.length === 0) {
    return undefined;
  }
  const ranked = [...new Set(candidates)]
    .map((candidate) => ({ value: candidate, distance: levenshteinDistance(normalizedInput, candidate) }))
    .sort((left, right) => left.distance - right.distance || compareText(left.value, right.value));
  const [best, secondBest] = ranked;
  if (!best || best.distance > 3 || best.distance > Math.ceil(normalizedInput.length / 2)) {
    return undefined;
  }
  if (secondBest && secondBest.distance === best.distance) {
    return undefined;
  }
  return best;
}

function renderUsageSuffix(command: CommandMetadata): string {
  const args = (command.arguments ?? []).map((argument) => argument.required ? `<${argument.name}>` : `[${argument.name}]`);
  const flags = (command.flags ?? []).map(renderFlagUsage);
  const suffix = [...args, ...flags].join(" ");
  return suffix.length === 0 ? "" : ` ${suffix}`;
}

function renderArguments(args: readonly ArgumentMetadata[]): string {
  if (args.length === 0) {
    return "Arguments:\n  none";
  }
  return renderNameDescriptionSection("Arguments:", args.map((argument) => ({
    name: argument.required ? `<${argument.name}>` : `[${argument.name}]`,
    description: argument.description
  })));
}

function renderFlags(flags: readonly FlagMetadata[]): string {
  if (flags.length === 0) {
    return "Flags:\n  none";
  }
  return renderNameDescriptionSection("Flags:", flags.map((flag) => ({
    name: `${renderFlagToken(flag)}${flag.type === "boolean" ? "" : " <value>"}`,
    description: renderFlagDescription(flag)
  })));
}

function renderFlagUsage(flag: FlagMetadata): string {
  if (flag.negatable === true) {
    return `[--${flag.name}|--no-${flag.name}]`;
  }
  return `[${renderFlagToken(flag)}${flag.type === "boolean" ? "" : " <value>"}]`;
}

function renderFlagToken(flag: FlagMetadata): string {
  const positive = flag.short ? `-${flag.short}, --${flag.name}` : `--${flag.name}`;
  return flag.negatable === true ? `${positive}, --no-${flag.name}` : positive;
}

function renderFlagTokens(flag: FlagMetadata): readonly string[] {
  return [
    `--${flag.name}`,
    ...(flag.negatable === true ? [`--no-${flag.name}`] : []),
    ...(flag.short ? [`-${flag.short}`] : []),
    ...(flag.aliases ?? []).flatMap((alias) => [`--${alias}`, ...(flag.negatable === true ? [`--no-${alias}`] : [])])
  ];
}

function renderFlagDescription(flag: FlagMetadata): string {
  const pieces = [flag.description];
  if (flag.options && flag.options.length > 0) {
    pieces.push(`options: ${flag.options.join(", ")}`);
  }
  if (flag.aliases && flag.aliases.length > 0) {
    pieces.push(`aliases: ${flag.aliases.map((alias) => `--${alias}`).join(", ")}`);
  }
  return pieces.join("; ");
}

function renderExamples(examples: readonly { readonly description: string; readonly command: string }[]): string {
  if (examples.length === 0) {
    return "Examples:\n  none";
  }
  return joinLines(["Examples:", ...examples.map((example) => `  ${example.command}  # ${example.description}`)]);
}

function renderBehavior(command: CommandMetadata): string {
  const mutationCategories = command.mutation?.categories ?? [];
  return joinLines([
    "Behavior:",
    `  JSON output: ${command.interactions?.json ? "supported" : "not declared"}`,
    `  Dry run: ${renderDryRun(command)}`,
    `  Mutation: ${mutationCategories.length === 0 ? "none" : mutationCategories.join(", ")}`,
    `  Supply chain: ${renderSupplyChain(command)}`
  ]);
}

function renderTopicCommandDetails(commands: readonly CommandMetadata[]): string {
  if (commands.length === 0) {
    return "Command details:\n  none";
  }
  return joinLines([
    "Command details:",
    ...commands.map((command) => {
      const flagCount = command.flags?.length ?? 0;
      const argumentCount = command.arguments?.length ?? 0;
      const exampleCount = command.examples?.length ?? 0;
      const mutationCategories = command.mutation?.categories ?? [];
      const mutation = mutationCategories.length === 0 ? "none" : mutationCategories.join(", ");
      const dryRun = renderDryRun(command);
      const json = command.interactions?.json ? "supported" : "not declared";
      return `  ${command.name}: args=${argumentCount}, flags=${flagCount}, examples=${exampleCount}, json=${json}, dry-run=${dryRun}, mutation=${mutation}, supply-chain=${renderSupplyChain(command)}`;
    })
  ]);
}

function renderDryRun(command: CommandMetadata): string {
  const dryRun = command.interactions?.dryRun;
  if (!dryRun) {
    return "not declared";
  }
  return dryRun.supported ? "supported" : `unsupported (${dryRun.reason})`;
}

function renderSupplyChain(command: CommandMetadata): string {
  const supplyChain = command.supplyChain;
  if (supplyChain?.sensitive !== true) {
    return "standard";
  }
  const kinds = supplyChain.kinds && supplyChain.kinds.length > 0 ? [...new Set(supplyChain.kinds)].sort(compareText).join(", ") : "unspecified";
  return `sensitive (${kinds})${supplyChain.reason ? ` — ${supplyChain.reason}` : ""}`;
}

function renderNameDescriptionSection(
  title: string,
  entries: readonly { readonly name: string; readonly description: string }[]
): string {
  if (entries.length === 0) {
    return `${title}\n  none`;
  }
  const width = Math.max(...entries.map((entry) => entry.name.length));
  return joinLines([title, ...entries.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.description}`)]);
}

function trimAtFirstFlag(tokens: readonly string[]): readonly string[] {
  const flagIndex = tokens.findIndex((token) => token.startsWith("-"));
  return flagIndex === -1 ? tokens : tokens.slice(0, flagIndex);
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length < right.length) {
    return levenshteinDistance(right, left);
  }
  if (right.length === 0) {
    return left.length;
  }
  let previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const currentRow = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const insertion = (currentRow[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + 1;
      const deletion = (previousRow[rightIndex] ?? Number.POSITIVE_INFINITY) + 1;
      const substitution = (previousRow[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + substitutionCost;
      currentRow[rightIndex] = Math.min(
        insertion,
        deletion,
        substitution
      );
    }
    previousRow = currentRow;
  }
  return previousRow[right.length] ?? left.length;
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function joinSections(sections: readonly string[]): string {
  return `${sections.join("\n\n")}\n`;
}

function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}
