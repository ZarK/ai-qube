import path from "node:path";

import ts from "typescript";

type ScanState = {
  index: number;
  mode: "code" | "block" | "line" | "literal";
  quote: string;
  verbatim: boolean;
  lines: Set<number>;
  line: number;
};

export function countSourceLines(source: string, file: string): number {
  if (/\.[cm]?[jt]sx?$/iu.test(path.extname(file))) {
    return countJavaScriptSourceLines(source, file);
  }
  return countDelimitedSourceLines(source);
}

function countJavaScriptSourceLines(source: string, file: string): number {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const sourceLines = source.split(/\r?\n/u);
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JSDocComment || node.kind === ts.SyntaxKind.EndOfFileToken)
      return;
    const children = node.getChildren(parsed);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    const start = node.getStart(parsed);
    if (start === node.end) return;
    const firstLine = parsed.getLineAndCharacterOfPosition(start).line;
    const lastLine = parsed.getLineAndCharacterOfPosition(node.end - 1).line;
    for (let line = firstLine; line <= lastLine; line += 1) {
      if (sourceLines[line]?.trim()) lines.add(line);
    }
  };
  visit(parsed);
  return lines.size;
}

function countDelimitedSourceLines(source: string): number {
  const state: ScanState = {
    index: 0,
    mode: "code",
    quote: "",
    verbatim: false,
    lines: new Set(),
    line: 1,
  };
  while (state.index < source.length) {
    scanCharacter(source, state);
  }
  return state.lines.size;
}

function scanCharacter(source: string, state: ScanState): void {
  const current = source[state.index] ?? "";
  if (current === "\n") {
    state.line += 1;
    if (state.mode === "line") state.mode = "code";
    state.index += 1;
    return;
  }
  if (state.mode === "line") {
    state.index += 1;
    return;
  }
  if (state.mode === "block") {
    if (source.startsWith("*/", state.index)) {
      state.mode = "code";
      state.index += 2;
    } else state.index += 1;
    return;
  }
  if (state.mode === "literal") {
    scanLiteral(source, state);
    return;
  }
  scanCode(source, state);
}

function scanLiteral(source: string, state: ScanState): void {
  const current = source[state.index] ?? "";
  if (current.trim().length > 0) state.lines.add(state.line);
  if (!state.verbatim && current === "\\" && source[state.index + 1] !== "\n") {
    state.index += 2;
    return;
  }
  if (current === state.quote) {
    if (state.verbatim && source[state.index + 1] === state.quote) {
      state.index += 2;
      return;
    }
    state.mode = "code";
  }
  state.index += 1;
}

function scanCode(source: string, state: ScanState): void {
  if (source.startsWith("//", state.index)) {
    state.mode = "line";
    state.index += 2;
    return;
  }
  if (source.startsWith("/*", state.index)) {
    state.mode = "block";
    state.index += 2;
    return;
  }
  const current = source[state.index] ?? "";
  if (current.trim().length > 0) state.lines.add(state.line);
  if (current === '"' || current === "'" || current === "`") {
    state.quote = current;
    state.verbatim = current === '"' && source[state.index - 1] === "@";
    state.mode = "literal";
  }
  state.index += 1;
}
