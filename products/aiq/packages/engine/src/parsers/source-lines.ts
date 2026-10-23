import path from "node:path";

import ts from "typescript";

type LiteralState = {
  quote: string;
  escapes: boolean;
  verbatim: boolean;
  interpolation: string;
  closingBraces: string;
  escapedBraces: boolean;
  expressionDepth: number;
};

type ScanState = {
  extension: string;
  blockDepth: number;
  index: number;
  mode: "code" | "block" | "line" | "literal";
  literals: LiteralState[];
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
    literals: [],
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
  const literal = state.literals.at(-1);
  if (!literal) return;
  const current = source[state.index] ?? "";
  if (current.trim().length > 0) state.lines.add(state.line);
  if (literal.escapes && current === "\\" && source[state.index + 1] !== "\n") {
    state.index += 2;
    return;
  }
  if (source.startsWith(literal.quote, state.index)) {
    if (literal.verbatim && source[state.index + 1] === literal.quote) {
      state.index += 2;
      return;
    }
    state.mode = "code";
    state.literals.pop();
    state.index += literal.quote.length;
    return;
  }
  if (literal.escapedBraces && source.startsWith("{{", state.index)) {
    state.index += 2;
    return;
  }
  if (literal.interpolation && source.startsWith(literal.interpolation, state.index)) {
    state.index += literal.interpolation.length;
    // Extra opening braces in raw strings are literal text before the expression.
    if (literal.interpolation.startsWith("{") && !literal.escapedBraces) {
      while (source[state.index] === "{") state.index += 1;
    }
    literal.expressionDepth = 1;
    state.mode = "code";
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
  const literal = state.literals.at(-1);
  if (literal && literal.expressionDepth > 0) {
    if (literal.expressionDepth === 1 && source.startsWith(literal.closingBraces, state.index)) {
      literal.expressionDepth = 0;
      state.mode = "literal";
      state.index += literal.closingBraces.length;
      return;
    }
    if (current === "{") literal.expressionDepth += 1;
    if (current === "}") literal.expressionDepth -= 1;
  }
  if (scanRawLiteral(source, state)) return;
  const characterLiteral =
    current === "'" &&
    (state.extension !== ".rs" ||
      /^'(?:[^'\\\r\n]|\\(?:[nrt\\0'"]|x[\da-f]{2}|u\{[\da-f_]+\}))'/iu.test(
        source.slice(state.index),
      ));
  if (current === '"' || characterLiteral || current === "`") {
    const verbatim =
      state.extension === ".cs" && current === '"' && isVerbatimQuote(source, state.index);
    startLiteral(source, state, current, !verbatim && current !== "`", verbatim);
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
  startLiteral(source, state, closer, state.extension === ".java", false);
  state.index += opener.length;
  return true;
}

function startLiteral(
  source: string,
  state: ScanState,
  quote: string,
  escapes: boolean,
  verbatim: boolean,
): void {
  let interpolation = "";
  let closingBraces = "}";
  let escapedBraces = false;
  if (quote.startsWith('"') && state.extension !== ".rs") {
    let prefix = state.index;
    if (source[prefix - 1] === "@") prefix -= 1;
    let dollars = 0;
    while (source[prefix - 1] === "$") {
      dollars += 1;
      prefix -= 1;
    }
    if (state.extension === ".cs" && dollars > 0) {
      interpolation = "{".repeat(quote.length >= 3 ? dollars : 1);
      closingBraces = "}".repeat(interpolation.length);
      escapedBraces = quote.length === 1;
    } else if ([".kt", ".kts"].includes(state.extension)) {
      interpolation = `${"$".repeat(Math.max(1, dollars))}{`;
    }
  }
  state.literals.push({
    quote,
    escapes,
    verbatim,
    interpolation,
    closingBraces,
    escapedBraces,
    expressionDepth: 0,
  });
  state.mode = "literal";
}

function isVerbatimQuote(source: string, index: number): boolean {
  return source[index - 1] === "@" || source.slice(index - 2, index) === "@$";
}
