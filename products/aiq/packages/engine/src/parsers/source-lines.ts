import path from "node:path";

import ts from "typescript";

type ScanState = {
  extension: string;
  blockDepth: number;
  index: number;
  mode: "code" | "block" | "line" | "literal";
  quote: string;
  escapes: boolean;
  verbatim: boolean;
  lines: Set<number>;
  line: number;
};

export function countSourceLines(source: string, file: string): number {
  if (/\.[cm]?[jt]sx?$/iu.test(path.extname(file))) {
    return countJavaScriptSourceLines(source, file);
  }
  return countDelimitedSourceLines(source, path.extname(file).toLowerCase());
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

function countDelimitedSourceLines(source: string, extension: string): number {
  const state: ScanState = {
    extension,
    blockDepth: 0,
    index: 0,
    mode: "code",
    quote: "",
    escapes: true,
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
    if ([".rs", ".kt", ".kts"].includes(state.extension) && source.startsWith("/*", state.index)) {
      state.blockDepth += 1;
      state.index += 2;
    } else if (source.startsWith("*/", state.index)) {
      state.blockDepth -= 1;
      if (state.blockDepth === 0) state.mode = "code";
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
  if (state.escapes && current === "\\" && source[state.index + 1] !== "\n") {
    state.index += 2;
    return;
  }
  if (source.startsWith(state.quote, state.index)) {
    if (state.verbatim && source[state.index + 1] === state.quote) {
      state.index += 2;
      return;
    }
    state.mode = "code";
    state.index += state.quote.length;
    return;
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
    state.blockDepth = 1;
    state.index += 2;
    return;
  }
  const current = source[state.index] ?? "";
  if (current.trim().length > 0) state.lines.add(state.line);
  if (scanRawLiteral(source, state)) return;
  const characterLiteral =
    current === "'" &&
    (state.extension !== ".rs" ||
      /^'(?:[^'\\\r\n]|\\(?:[nrt\\0'"]|x[\da-f]{2}|u\{[\da-f_]+\}))'/iu.test(
        source.slice(state.index),
      ));
  if (current === '"' || characterLiteral || current === "`") {
    state.quote = current;
    state.verbatim =
      state.extension === ".cs" && current === '"' && isVerbatimQuote(source, state.index);
    state.escapes = !state.verbatim && current !== "`";
    state.mode = "literal";
  }
  state.index += 1;
}

function scanRawLiteral(source: string, state: ScanState): boolean {
  let opener = "";
  let closer = "";
  if (state.extension === ".rs" && /[rbc]/u.test(source[state.index] ?? "")) {
    const raw = /^(?:b|c)?r(#{0,255})"/u.exec(source.slice(state.index));
    if (raw !== null && !/[\w]/u.test(source[state.index - 1] ?? "")) {
      opener = raw[0];
      closer = `"${raw[1]}`;
    }
  } else if (source.startsWith('"""', state.index)) {
    if (state.extension === ".cs") {
      if (isVerbatimQuote(source, state.index)) return false;
      opener = /^"{3,}/u.exec(source.slice(state.index))?.[0] ?? "";
      closer = opener;
    } else if ([".java", ".kt", ".kts"].includes(state.extension)) {
      opener = '"""';
      closer = opener;
    }
  }
  if (opener.length === 0) return false;
  state.quote = closer;
  state.escapes = state.extension === ".java";
  state.verbatim = false;
  state.mode = "literal";
  state.index += opener.length;
  return true;
}

function isVerbatimQuote(source: string, index: number): boolean {
  return source[index - 1] === "@" || source.slice(index - 2, index) === "@$";
}
