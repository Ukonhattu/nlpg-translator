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
   * Translator-internal notices (AST verify, fallback, etc.). Only included when
   * includeDiagnostics is true — intended for teachers/debugging, not students.
   */
  diagnostics?: string[];
};

import type { LlmApi } from "./llmConfig.js";

export type { LlmApi };

export type TranslateOptions = {
  /**
   * Azure Responses API key. Required for llmApi=azure unless AALTO_API_KEY is set in the environment.
   */
  aaltoApiKey?: string;
  /**
   * K8s LLM gateway key (Chat Completions). Required for llmApi=gateway unless LLM_GATEWAY_API_KEY is set in the environment.
   */
  gatewayApiKey?: string;
  /**
   * LLM backend. Default "azure".
   * Both `azure` and `gateway` support direct mode (default) and `astMode`.
   */
  llmApi?: LlmApi;
  /** API URL override (Azure or gateway). */
  endpoint?: string;
  /** Model name override (Azure or gateway). */
  model?: string;
  /** @deprecated Use `endpoint`. */
  aaltoEndpoint?: string;
  /** @deprecated Use `model`. */
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
  /**
   * In astMode, controls what happens for source constructs the AST cannot
   * represent (which the model marks as "unknown" nodes):
   *  - "comment"  (default): render them as `# unsupported: ...` comments so the
   *    output stays faithful but visibly incomplete.
   *  - "fallback": for any block containing such constructs, fall back to the
   *    direct (non-AST) translation mode as a best-effort attempt.
   */
  unsupportedBehavior?: "comment" | "fallback";
  /**
   * Reasoning effort for reasoning-capable models (e.g. gpt-5). Lower effort
   * means far fewer hidden reasoning tokens and therefore much lower latency.
   * Left undefined for the direct mode (model default); the AST path defaults
   * to "low" since transcribing instructions into an AST is largely mechanical.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /**
   * When true, include diagnostics on the translation result (default false).
   */
  includeDiagnostics?: boolean;
  /**
   * When true, drop or strip print/output not grounded in explicit output verbs
   * on the cited source line. Default false (warn in AST mode, keep prints).
   */
  strictOutputFidelity?: boolean;
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
    const { pythonCode, diagnostics } = await translateBlocksViaAst(
      blocks,
      options
    );
    const result: TranslationResult = { pythonCode, errors: [] };
    if (options.includeDiagnostics && diagnostics.length > 0) {
      result.diagnostics = diagnostics;
    }
    return result;
  }

  const pythonCode = await translateBlocks(blocks, options);
  return { pythonCode, errors: [] };
}
