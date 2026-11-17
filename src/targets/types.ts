/**
 * Code generation targets. The AST (src/ast.ts) is the language-neutral
 * intermediate representation; each target turns verified statements into
 * source code and knows how to post-process and syntax-check model-written
 * code for direct mode.
 */

import type { Stmt } from "../ast.js";
import type { DirectPostProcess, DirectProcessed } from "../direct.js";

export type TargetId = "python" | "c";

export const TARGET_IDS: readonly TargetId[] = ["python", "c"];

export type CodegenDiagnostic = {
  severity: "info" | "warning";
  code: string;
  message: string;
  line?: number;
};

export type GenerateResult = {
  code: string;
  /**
   * Statements the AST can represent but this target cannot (rendered as
   * `unsupported` comments). `unknown` nodes are NOT counted here.
   */
  unsupportedNodes: number;
};

export type SyntaxProblem = { line: number; message: string };

export type PromptRef = { id: string; text: string };

export interface DirectSupport {
  /** Human-readable language name used in the direct-mode user message. */
  languageName: string;
  /** How output calls are named in diagnostics, e.g. "print()". */
  outputCallName: string;
  /** System prompt for direct mode. `version` is the legacy Python switch. */
  prompt(version?: "v1" | "v2"): PromptRef;
  /** Strip fences/comments and count output calls. */
  postProcess(
    modelText: string,
    sourceText: string,
    postProcess?: DirectPostProcess
  ): DirectProcessed;
  /** Syntax problems (empty = parses) or null when no parser is available. */
  checkSyntax(code: string): Promise<SyntaxProblem[] | null>;
}

export interface Target {
  id: TargetId;
  /** e.g. "Python 3.10", "C11" */
  displayName: string;
  fileExtension: string;
  /** A single-line comment in this language. */
  lineComment(text: string): string;
  /**
   * Deterministic AST -> code for one program. Notices are appended to
   * `diagnostics`.
   */
  generate(statements: Stmt[], diagnostics: CodegenDiagnostic[]): GenerateResult;
  /**
   * False when the output must be a single translation unit, so independently
   * translated blocks cannot simply be concatenated (`separateBlocks`).
   */
  supportsSeparateBlocks: boolean;
  direct: DirectSupport;
}
