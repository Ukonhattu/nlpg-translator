export type Block = {
  id: string;
  text: string;
};

export type LintError = {
  blockId: string;
  code: string;
  message: string;
  location?: { line: number; column?: number };
};

export type TranslationResult = {
  pythonCode: string;
  errors: LintError[];
  /**
   * Non-fatal notices, e.g. AST nodes dropped because they were not grounded in
   * the source (only populated when astMode is enabled).
   */
  warnings?: string[];
};

export type TranslateOptions = {
  aaltoApiKey: string;
  aaltoEndpoint?: string;
  aaltoModel?: string;
  enableLint?: boolean;
  separateBlocks?: boolean;
  /**
   * When true, the model transcribes the instructions into an AST which is then
   * deterministically rendered to Python. This guarantees the generated code
   * contains nothing that is not present in the source. Defaults to false (the
   * model writes Python directly).
   */
  astMode?: boolean;
};

import { lintProgram } from "./linter.js";
import { translateBlocks, translateBlocksViaAst } from "./translator.js";

export async function translateProgram(
  blocks: Block[],
  options: TranslateOptions
): Promise<TranslationResult> {
  if (options.enableLint) {
    const errors = lintProgram(blocks);
    if (errors.length > 0) {
      return { pythonCode: "", errors };
    }
  }

  if (options.astMode) {
    const { pythonCode, warnings } = await translateBlocksViaAst(
      blocks,
      options
    );
    return { pythonCode, errors: [], warnings };
  }

  const pythonCode = await translateBlocks(blocks, options);
  return { pythonCode, errors: [] };
}
