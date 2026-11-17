/**
 * Direct-mode post-processing (the model writes Python; we only tidy it).
 *
 * Deliberately minimal: strip markdown fences and comments (string-aware), and
 * report suspicious output instead of rewriting it. The earlier line-deleting
 * and ternary-rewriting repairs are gone from the default path.
 */

import { countRequestedPrints } from "./outputVerbs.js";

/**
 *  - "none": return the model text with only code fences removed (recommended
 *    for experimental baselines).
 *  - `{ deadTernaries: true }`: also collapse `x if False else y` (legacy; not
 *    string-aware, off by default).
 */
export type DirectPostProcess = "none" | { deadTernaries?: boolean };

export function stripCodeFences(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .trim();
}

export type ScannedLine = {
  /** The line with any `#` comment removed (string contents untouched). */
  text: string;
  /** The line with strings and comments blanked out, for matching code tokens. */
  code: string;
  /** True when the line begins inside a (triple-quoted or continued) string. */
  startsInString: boolean;
};

/**
 * Tokenises Python just enough to know where strings and comments are:
 * `'`, `"`, `'''`, `"""`, string prefixes (r/f/b/rb/... need no special case:
 * a backslash always protects the next character from ending the string) and
 * escapes. Strings may continue across lines (triple quotes, trailing `\`).
 * Nested same-quote f-strings (PEP 701) are not modelled.
 */
export function scanPython(source: string): ScannedLine[] {
  const lines = source.split(/\r?\n/);
  let inStr: { q: string; triple: boolean } | null = null;
  const out: ScannedLine[] = [];

  for (const line of lines) {
    const startsInString = inStr !== null;
    let text = "";
    let code = "";
    let commentCut = false;
    let endedOnEscape = false;
    let i = 0;

    while (i < line.length) {
      const ch = line[i];
      if (inStr) {
        if (ch === "\\") {
          text += ch;
          code += " ";
          if (i + 1 < line.length) {
            text += line[i + 1];
            code += " ";
          } else {
            endedOnEscape = true;
          }
          i += 2;
          continue;
        }
        if (inStr.triple) {
          if (line.startsWith(inStr.q.repeat(3), i)) {
            text += inStr.q.repeat(3);
            code += "   ";
            inStr = null;
            i += 3;
            continue;
          }
        } else if (ch === inStr.q) {
          text += ch;
          code += " ";
          inStr = null;
          i++;
          continue;
        }
        text += ch;
        code += " ";
        i++;
        continue;
      }

      if (ch === "#") {
        commentCut = true;
        break;
      }
      if (ch === '"' || ch === "'") {
        const triple = line.startsWith(ch.repeat(3), i);
        inStr = { q: ch, triple };
        const delim = triple ? ch.repeat(3) : ch;
        text += delim;
        code += " ".repeat(delim.length);
        i += delim.length;
        continue;
      }
      text += ch;
      code += ch;
      i++;
    }

    // An unterminated single-quoted string ends with its line (unless continued by `\`).
    if (inStr && !inStr.triple && !endedOnEscape) inStr = null;

    if (commentCut) {
      text = text.trimEnd();
      code = code.trimEnd();
    }
    out.push({ text, code, startsInString });
  }
  return out;
}

/**
 * Removes comments (string-aware, including triple-quoted strings) and blank
 * lines. Blank lines inside strings are preserved.
 */
export function stripPythonComments(source: string): string {
  return scanPython(source)
    .filter((l) => l.startsInString || l.text.trim().length > 0)
    .map((l) => l.text)
    .join("\n");
}

/** Number of `print(...)` calls in code (ignoring strings and comments). */
export function countPrintCalls(source: string): number {
  let n = 0;
  for (const { code } of scanPython(source)) {
    n += (code.match(/(?<![\w.])print\s*\(/g) ?? []).length;
  }
  return n;
}

/**
 * Collapses dead conditional expressions the model sometimes emits, e.g.
 * `int(input()) if False else int(input())` -> `int(input())`.
 *
 * Legacy and risky: it works on raw lines, so it also rewrites text inside
 * string literals. Not applied unless `directPostProcess.deadTernaries` is set.
 */
export function simplifyDeadTernaries(pythonCode: string): string {
  return pythonCode
    .split(/\r?\n/)
    .map((line) => {
      const assignFalse = line.match(/^(\s*\w+\s*=\s*)(.+)\s+if\s+False\s+else\s+(.+)$/);
      if (assignFalse) return `${assignFalse[1]}${assignFalse[3].trim()}`;
      const assignTrue = line.match(/^(\s*\w+\s*=\s*)(.+)\s+if\s+True\s+else\s+(.+)$/);
      if (assignTrue) return `${assignTrue[1]}${assignTrue[2].trim()}`;
      const falseElse = line.match(/^(\s*)(.+?)\s+if\s+False\s+else\s+(.+)$/);
      if (falseElse) return `${falseElse[1]}${falseElse[3].trim()}`;
      const trueElse = line.match(/^(\s*)(.+?)\s+if\s+True\s+else\s+(.+)$/);
      if (trueElse) return `${trueElse[1]}${trueElse[2].trim()}`;
      return line;
    })
    .join("\n");
}

export type DirectProcessed = {
  code: string;
  /** Output requested by the source vs print() calls the model emitted. */
  requestedOutputLines: number;
  emittedPrints: number;
};

export function postProcessDirect(
  modelText: string,
  sourceText: string,
  postProcess?: DirectPostProcess
): DirectProcessed {
  const fenced = stripCodeFences(modelText);
  let code = fenced;
  if (postProcess !== "none") {
    code = stripPythonComments(fenced);
    if (postProcess?.deadTernaries) code = simplifyDeadTernaries(code);
  }
  return {
    code,
    requestedOutputLines: countRequestedPrints(sourceText),
    emittedPrints: countPrintCalls(code),
  };
}
