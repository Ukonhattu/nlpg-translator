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
};

export type TranslateOptions = {
  aaltoApiKey: string;
  aaltoModel?: string;
};

import { lintProgram } from "./linter.js";
import { translateBlocks } from "./translator.js";

export async function translateProgram(
  blocks: Block[],
  options: TranslateOptions
): Promise<TranslationResult> {
  const errors = lintProgram(blocks);
  if (errors.length > 0) {
    return { pythonCode: "", errors };
  }
  const pythonCode = await translateBlocks(blocks, options);
  return { pythonCode, errors: [] };
}
