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

export type ConsistencyReport = {
  /** Number of samples requested. */
  samples: number;
  /** Share of samples whose program is identical to the chosen one (mean over blocks). */
  agreement: number;
  /** Source lines that were read in more than one way. */
  disagreeingLines: Array<{ blockId: string; line: number; variants: number }>;
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
  /** AST mode with `samples > 1`: how much the samples agreed. */
  consistency?: ConsistencyReport;
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
   * When true, the model transcribes the instructions into an AST (schema v2,
   * every step citing its source line with verbatim evidence) which is then
   * deterministically rendered to Python. The code is verified for shape and
   * grounded against the text (see `grounding`), which makes unrequested
   * additions visible or removable. It does NOT guarantee that the model's
   * reading of the instructions is correct. Defaults to false (the model writes
   * Python directly).
   */
  astMode?: boolean;
  /**
   * AST mode only: number of independent AST samples per block (default 1, max
   * 7). They run concurrently (at most 4 at a time), each is verified and
   * grounded on its own, and the most frequent program is used (ties: fewest
   * grounding warnings, then fewest unknown steps, then the first sample).
   * Lines that were read differently are reported in `consistency` and as
   * `CONSISTENCY_DISAGREEMENT` diagnostics. Costs `samples` times the tokens.
   * Ignored in direct mode. Throws a RangeError for values outside 1-7.
   */
  samples?: number;
  /**
   * Sampling temperature. Sent only to the `gateway` backend and only when set:
   * gpt-5 reasoning models on `azure` ignore or reject it, so it is never sent
   * there (use `samples` with their built-in nondeterminism instead).
   */
  temperature?: number;
  /**
   * AST mode only: how strictly steps are checked against the source text
   * (evidence, literals, output cues, line coverage; see grounding.ts).
   *  - "warn" (default): record `GROUNDING_*` diagnostics, keep every step.
   *  - "strict": replace a step whose evidence, output cue or literals are not
   *    on the cited line by an `unknown` node (rendered as `# unsupported:`),
   *    so the block becomes "partial".
   *  - "off": no grounding checks.
   * Grounding verifies traceability to the text, not that the interpretation is
   * semantically correct.
   */
  grounding?: "off" | "warn" | "strict";
  /** AST grounding: max statements citing one line in one scope (default 2). */
  maxStatementsPerLine?: number;
  /**
   * AST mode only: request the AST as schema-constrained JSON (`text.format`
   * json_schema, strict). "auto" (default) tries it and, if the endpoint rejects
   * it with a schema/format-related 400/422, retries once without it and
   * remembers that for the endpoint; "on" never falls back; "off" never sends it.
   */
  structuredOutput?: "auto" | "on" | "off";
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
import {
  translateBlocksDetailed,
  translateBlocksViaAst,
  validateSamples,
} from "./translator.js";

export async function translateProgram(
  blocks: Block[],
  options: TranslateOptions
): Promise<TranslationResult> {
  validateSamples(options.samples);

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
    ...(outcome.consistency ? { consistency: outcome.consistency } : {}),
  };
  if (options.includeDiagnostics && outcome.diagnostics.length > 0) {
    result.diagnostics = outcome.diagnostics;
    result.diagnosticsDetailed = outcome.diagnosticsDetailed;
  }
  return result;
}
