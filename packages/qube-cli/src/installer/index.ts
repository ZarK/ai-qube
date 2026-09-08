import { multiselect, select, type Option } from "@clack/prompts";

import { createCliError } from "../errors/index.js";
import type { CommandMetadata } from "../metadata/index.js";
import { evaluatePromptGate, isPromptCancel, type PromptGateOptions } from "../prompts/index.js";

export interface InstallerChoice<Value extends string = string> {
  readonly value: Value;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
  readonly disabled?: boolean;
}

export interface InstallerChoiceGroup<Value extends string = string> {
  readonly name: string;
  readonly message: string;
  readonly choices: readonly InstallerChoice<Value>[];
  readonly defaultValue?: Value;
}

export interface InstallerChoicePromptOptions<Value extends string = string> extends PromptGateOptions<Value> {
  readonly message: string;
  readonly choices: readonly InstallerChoice<Value>[];
  readonly initialValue?: Value;
}

export interface InstallerChoicesPromptOptions<Value extends string = string> extends PromptGateOptions<readonly Value[]> {
  readonly message: string;
  readonly choices: readonly InstallerChoice<Value>[];
  readonly initialValues?: readonly Value[];
  readonly required?: boolean;
}

export function defineInstallerChoice<const Choice extends InstallerChoice>(choice: Choice): Readonly<Choice> {
  requireChoiceValue(choice.value);
  requireText(choice.label, "choice.label");
  if (choice.description !== undefined) {
    requireText(choice.description, "choice.description");
  }
  return Object.freeze(choice);
}

export function defineInstallerChoiceGroup<const Group extends InstallerChoiceGroup>(group: Group): Readonly<Group> {
  requireText(group.name, "group.name");
  requireText(group.message, "group.message");
  validateInstallerChoices(group.choices);
  if (group.defaultValue !== undefined) {
    requireChoiceMatch(group.defaultValue, group.choices, { promptName: group.name });
  }
  return Object.freeze(group);
}

export function validateInstallerChoices<Value extends string>(choices: readonly InstallerChoice<Value>[]): void {
  if (choices.length === 0) {
    throw new TypeError("installer choices must include at least one choice.");
  }
  const values = new Set<string>();
  for (const [index, choice] of choices.entries()) {
    requireChoiceValue(choice.value);
    requireText(choice.label, `choices[${index}].label`);
    if (choice.description !== undefined) {
      requireText(choice.description, `choices[${index}].description`);
    }
    if (values.has(choice.value)) {
      throw new TypeError(`installer choice values must be unique; duplicate value "${choice.value}".`);
    }
    values.add(choice.value);
  }
}

export function findInstallerChoice<Value extends string>(
  choices: readonly InstallerChoice<Value>[],
  value: string
): InstallerChoice<Value> | undefined {
  return choices.find(choice => choice.value === value);
}

export function renderInstallerChoices<Value extends string>(choices: readonly InstallerChoice<Value>[]): string {
  validateInstallerChoices(choices);
  return `${choices.map(renderInstallerChoice).join("\n")}\n`;
}

export async function promptInstallerChoice<Value extends string>(
  options: InstallerChoicePromptOptions<Value>
): Promise<Value> {
  validateInstallerChoices(options.choices);

  if (options.value !== undefined) {
    requireChoiceMatch(options.value, options.choices, {
      command: commandName(options.command),
      promptName: options.promptName ?? "installer choice"
    });
    return options.value;
  }

  const gate = evaluatePromptGate(options);
  if (!gate.allowed) {
    if (options.defaultValue !== undefined) {
      requireChoiceMatch(options.defaultValue, options.choices, {
        command: commandName(options.command),
        promptName: options.promptName ?? "installer choice"
      });
      return options.defaultValue;
    }
    throw createCliError({
      command: commandName(options.command),
      kind: "prompt-blocked",
      operation: `prompt ${options.promptName ?? "installer choice"}`,
      likelyCause: gate.message,
      suggestedNextAction: "Provide an explicit flag value or rerun in an interactive terminal.",
      category: "usage"
    });
  }

  const selectOptions: Option<string>[] = options.choices.map(choice => {
    const base = {
      value: choice.value,
      label: renderChoiceLabel(choice),
      ...(choice.disabled === true ? { disabled: true } : {})
    };
    return choice.description ? { ...base, hint: choice.description } : base;
  });
  if (options.initialValue !== undefined) {
    requireChoiceMatch(options.initialValue, options.choices, {
      command: commandName(options.command),
      promptName: options.promptName ?? "installer choice"
    });
  }
  const selected = await select<string>({
    message: options.message,
    options: selectOptions,
    ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue })
  });
  if (isPromptCancel(selected)) {
    throw createCliError({
      command: commandName(options.command),
      kind: "prompt-cancelled",
      operation: `prompt ${options.promptName ?? "installer choice"}`,
      likelyCause: "The interactive prompt was cancelled.",
      suggestedNextAction: "Retry with an explicit flag value instead of relying on an interactive prompt.",
      category: "usage"
    });
  }
  return selected as Value;
}

export async function promptInstallerChoices<Value extends string>(
  options: InstallerChoicesPromptOptions<Value>
): Promise<readonly Value[]> {
  validateInstallerChoices(options.choices);

  if (options.value !== undefined) {
    requireChoicesMatch(options.value, options.choices, {
      command: commandName(options.command),
      promptName: options.promptName ?? "installer choices"
    });
    return options.value;
  }

  const gate = evaluatePromptGate(options);
  if (!gate.allowed) {
    if (options.defaultValue !== undefined) {
      requireChoicesMatch(options.defaultValue, options.choices, {
        command: commandName(options.command),
        promptName: options.promptName ?? "installer choices"
      });
      return options.defaultValue;
    }
    throw createCliError({
      command: commandName(options.command),
      kind: "prompt-blocked",
      operation: `prompt ${options.promptName ?? "installer choices"}`,
      likelyCause: gate.message,
      suggestedNextAction: "Provide explicit flag values or rerun in an interactive terminal.",
      category: "usage"
    });
  }

  const selectOptions: Option<string>[] = options.choices.map(choice => {
    const base = {
      value: choice.value,
      label: renderChoiceLabel(choice),
      ...(choice.disabled === true ? { disabled: true } : {})
    };
    return choice.description ? { ...base, hint: choice.description } : base;
  });
  if (options.initialValues !== undefined) {
    requireChoicesMatch(options.initialValues, options.choices, {
      command: commandName(options.command),
      promptName: options.promptName ?? "installer choices"
    });
  }
  const initialValues = options.initialValues ?? options.choices
    .filter(choice => choice.recommended === true && choice.disabled !== true)
    .map(choice => choice.value);
  const selected = await multiselect<string>({
    message: options.message,
    options: selectOptions,
    ...(initialValues.length > 0 ? { initialValues: [...initialValues] } : {}),
    required: options.required ?? true
  });
  if (isPromptCancel(selected)) {
    throw createCliError({
      command: commandName(options.command),
      kind: "prompt-cancelled",
      operation: `prompt ${options.promptName ?? "installer choices"}`,
      likelyCause: "The interactive prompt was cancelled.",
      suggestedNextAction: "Retry with explicit flag values instead of relying on an interactive prompt.",
      category: "usage"
    });
  }
  return Object.freeze([...(selected as string[])]) as readonly Value[];
}

function requireChoicesMatch<Value extends string>(
  values: readonly Value[],
  choices: readonly InstallerChoice<Value>[],
  options: {
    readonly command?: string;
    readonly promptName: string;
  }
): void {
  for (const value of values) {
    requireChoiceMatch(value, choices, options);
  }
}

function renderInstallerChoice<Value extends string>(choice: InstallerChoice<Value>): string {
  const marker = choice.recommended === true && choice.disabled !== true ? "*" : "-";
  const description = choice.description ? ` - ${choice.description}` : "";
  const label = choice.disabled === true ? `${choice.label} (unavailable)` : choice.label;
  return `${marker} ${choice.value}: ${label}${description}`;
}

function renderChoiceLabel<Value extends string>(choice: InstallerChoice<Value>): string {
  if (choice.disabled === true) return `${choice.label} (unavailable)`;
  return choice.recommended === true ? `${choice.label} (recommended)` : choice.label;
}

function requireChoiceMatch<Value extends string>(
  value: Value,
  choices: readonly InstallerChoice<Value>[],
  options: {
    readonly command?: string;
    readonly promptName: string;
  }
): void {
  const choice = findInstallerChoice(choices, value);
  if (choice?.disabled === true) {
    const enabledChoices = choices.filter(candidate => candidate.disabled !== true);
    throw createCliError({
      ...(options.command === undefined ? {} : { command: options.command }),
      kind: "unavailable-installer-choice",
      operation: `validate ${options.promptName}`,
      likelyCause: choice.description ?? `Choice "${value}" is unavailable.`,
      suggestedNextAction: enabledChoices.length > 0
        ? `Use one of: ${enabledChoices.map(candidate => candidate.value).join(", ")}.`
        : `No enabled choices are available for ${options.promptName}.`,
      category: "validation"
    });
  }
  if (choice) {
    return;
  }
  throw createCliError({
    ...(options.command === undefined ? {} : { command: options.command }),
    kind: "invalid-installer-choice",
    operation: `validate ${options.promptName}`,
    likelyCause: `Unsupported choice "${value}".`,
    suggestedNextAction: `Use one of: ${choices.map(choice => choice.value).join(", ")}.`,
    category: "validation"
  });
}

function requireChoiceValue(value: string): void {
  requireText(value, "choice.value");
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new TypeError("choice.value must use lowercase words separated by hyphens.");
  }
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty.`);
  }
}

function commandName(command: CommandMetadata | string | undefined): string {
  return typeof command === "string" ? command : command?.name ?? "<installer>";
}
