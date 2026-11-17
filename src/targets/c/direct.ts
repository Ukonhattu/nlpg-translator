/**
 * Direct-mode post-processing for model-written C: strip markdown fences and
 * comments (string- and character-literal aware), count output calls.
 */

import { stripCodeFences, type DirectPostProcess, type DirectProcessed } from "../../direct.js";
import { countRequestedPrints } from "../../outputVerbs.js";

export type CScanned = {
  /** Source with comments removed (literals untouched). */
  text: string;
  /** Source with comments removed and literal contents blanked, for matching tokens. */
  code: string;
};

/** Removes `//` and block comments; keeps string and character literals intact. */
export function scanC(source: string): CScanned {
  let text = "";
  let code = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        // A backslash-newline continues a // comment onto the next line.
        if (source[i] === "\\" && source[i + 1] === "\n") i++;
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Keep line breaks so line numbers stay meaningful; a comment is a space.
      const newlines = source.slice(i, stop).replace(/[^\n]/g, "");
      text += newlines || " ";
      code += newlines || " ";
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      text += ch;
      code += ch;
      i++;
      while (i < source.length && source[i] !== quote && source[i] !== "\n") {
        if (source[i] === "\\" && i + 1 < source.length) {
          text += source[i] + source[i + 1];
          code += "  ";
          i += 2;
          continue;
        }
        text += source[i];
        code += " ";
        i++;
      }
      if (source[i] === quote) {
        text += quote;
        code += quote;
        i++;
      }
      continue;
    }
    text += ch;
    code += ch;
    i++;
  }
  return { text, code };
}

/** Removes comments and blank lines. */
export function stripCComments(source: string): string {
  return scanC(source)
    .text.split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .join("\n");
}

/** Number of printf/puts/putchar calls (ignoring literals and comments). */
export function countCOutputCalls(source: string): number {
  return (scanC(source).code.match(/(?<![\w.])(printf|puts|putchar)\s*\(/g) ?? []).length;
}

export function postProcessDirectC(
  modelText: string,
  sourceText: string,
  postProcess?: DirectPostProcess
): DirectProcessed {
  const fenced = stripCodeFences(modelText);
  const code = postProcess === "none" ? fenced : stripCComments(fenced);
  return {
    code,
    requestedOutputLines: countRequestedPrints(sourceText),
    emittedPrints: countCOutputCalls(code),
  };
}
