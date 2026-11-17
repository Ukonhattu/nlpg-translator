/**
 * Runtime syntax check for generated Python (tree-sitter-python via WASM).
 *
 * Caveats: tree-sitter targets current Python grammar, so it accepts some
 * newer syntax (e.g. PEP 701 f-strings) that Python 3.10 rejects, and it is
 * error-tolerant, so the reported line is where recovery happened.
 */

import { createSyntaxChecker, type SyntaxProblem } from "./treeSitterSyntax.js";

export type { SyntaxProblem };

const checker = createSyntaxChecker("tree-sitter-python", "tree-sitter-python.wasm");

/** True when the WASM parser could be loaded in this environment. */
export function syntaxCheckAvailable(): Promise<boolean> {
  return checker.available();
}

/**
 * Returns the syntax problems found in `code` (empty array = parses), or
 * `null` when the parser is unavailable.
 */
export function checkPythonSyntax(
  code: string,
  maxProblems = 5
): Promise<SyntaxProblem[] | null> {
  return checker.check(code, maxProblems);
}
