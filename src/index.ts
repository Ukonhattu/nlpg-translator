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

export type TranslationStatus = "ok" | "partial" | "failed";

export type FailureReason =
  | "parse_error"
  | "incomplete_response"
  | "empty_response"
  | "http_error"
  | "timeout";

export type Diagnostic = {
  blockId: string;
  line?: number;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
};

export type BlockResult = {
  id: string;
  /**
   * "ok": fully translated. "partial": some nodes were dropped or are `unknown`.
   * "failed": no usable code (see failureReason).
   */
  status: TranslationStatus;
  /** This block's own code (empty when failed). */
  pythonCode: string;
  droppedNodes: number;
  unknownNodes: number;
  failureReason?: FailureReason;
};

export type TranslationResult = {
  /**
   * Generated code. A failed block contributes `# [block <id>: translation
   * failed]` unless `failedBlockMarker` is false.
   */
  pythonCode: string;
  errors: LintError[];
  /**
   * Translator-internal notices (AST verify, fallback, etc.). Only included when
   * includeDiagnostics is true — intended for teachers/debugging, not students.
   */
  diagnostics?: string[];
  /** Structured form of `diagnostics` (same inclusion rule). */
  diagnosticsDetailed?: Diagnostic[];
  /** Per-block results (absent when lint blocked translation). */
  blocks?: BlockResult[];
  /** Worst status across blocks. */
  status?: TranslationStatus;
};

import type { LlmApi } from "./llmConfig.js";

export type { LlmApi };

export type TranslateOptions = {
  /**
   * Azure Responses API key. Required for llmApi=azure unless AALTO_API_KEY is set in the environment.
   */
  aaltoApiKey?: string;
  /**
   * K8s LLM gateway key. Required for llmApi=gateway unless LLM_GATEWAY_API_KEY is set in the environment.
   */
  gatewayApiKey?: string;
  /**
   * LLM backend. Default "azure".
   * Both `azure` and `gateway` support direct mode (default) and `astMode`.
   */
  llmApi?: LlmApi;
  /** API URL override (Azure or gateway Responses endpoint). */
  endpoint?: string;
  /** Model name override (Azure or gateway). */
  model?: string;
  /** @deprecated Use `endpoint`. */
  aaltoEndpoint?: string;
  /** @deprecated Use `model`. */
  aaltoModel?: string;
  /**
   * When true, translateProgram rejects (with the first block's original error)
   * if EVERY block fails. By default failures are reported per block instead.
   */
  throwOnFailure?: boolean;
  /**
   * Emit `# [block <id>: translation failed]` for failed blocks (default true).
   */
  failedBlockMarker?: boolean;
  /** Timeout for each LLM HTTP request in milliseconds (default 60000). */
  timeoutMs?: number;
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
import { translateBlocksDetailed, translateBlocksViaAst } from "./translator.js";

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

  const outcome = options.astMode
    ? await translateBlocksViaAst(blocks, options)
    : await translateBlocksDetailed(blocks, options);

  const result: TranslationResult = {
    pythonCode: outcome.pythonCode,
    errors: [],
    blocks: outcome.blocks,
    status: outcome.status,
  };
  if (options.includeDiagnostics && outcome.diagnostics.length > 0) {
    result.diagnostics = outcome.diagnostics;
    result.diagnosticsDetailed = outcome.diagnosticsDetailed;
  }
  return result;
}
