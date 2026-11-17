import type {
  Block,
  BlockResult,
  Diagnostic,
  ConsistencyReport,
  FailureReason,
  TranslateOptions,
  TranslationStatus,
} from "./index.js";
import { resolveLlmConfig, type ResolvedLlmConfig } from "./llmConfig.js";
import {
  childStatementLists,
  verifyProgram,
  type Stmt,
} from "./ast.js";
import { astResponseFormat, stripNulls } from "./astSchema.js";
import {
  disagreeingLines,
  selectConsensus,
  type SampleSummary,
} from "./consistency.js";
import { checkGrounding } from "./grounding.js";
import { AST_PROMPT_V2 } from "./prompts/ast.v2.js";
import {
  postProcessDirect,
  stripCodeFences,
  type DirectPostProcess,
} from "./direct.js";
import { getTarget } from "./targets/registry.js";
import type { CodegenDiagnostic, TargetId } from "./targets/types.js";
import { sha256Hex } from "./prompts/index.js";
import { emitTrace, endpointHost, redactDiagnostics } from "./trace.js";
import { AST_SCHEMA_VERSION } from "./ast.js";
import { randomUUID } from "node:crypto";

/** The model's response could not be used (unparseable, incomplete or empty). */
export class LlmResponseError extends Error {
  constructor(
    readonly reason: Extract<
      FailureReason,
      "parse_error" | "incomplete_response" | "empty_response"
    >,
    message: string
  ) {
    super(message);
    this.name = "LlmResponseError";
  }
}

/** Maps an error to a block failure reason; `undefined` means "not ours, rethrow". */
function classifyFailure(err: unknown): FailureReason | undefined {
  if (err instanceof LlmResponseError) return err.reason;
  if (err instanceof LlmHttpError) return "http_error";
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return "http_error";
  }
  return undefined;
}

/** A failure message that never contains an upstream response body. */
function failureMessage(reason: FailureReason, err: unknown): string {
  switch (reason) {
    case "http_error":
      return err instanceof LlmHttpError
        ? `LLM request failed (HTTP ${err.status}).`
        : "LLM request failed (network error).";
    case "timeout":
      return "LLM request timed out.";
    default:
      return (err as Error)?.message ?? reason;
  }
}

type BlockOutcome = BlockResult & {
  diagnostics: Diagnostic[];
  error?: unknown;
  /** Present for AST blocks translated with `samples > 1`. */
  consistency?: { agreement: number; disagreeingLines: Array<{ line: number; variants: number }> };
};

export type TranslationOutcome = {
  code: string;
  target: TargetId;
  /** Human-readable diagnostics (always collected; callers decide what to return). */
  diagnostics: string[];
  diagnosticsDetailed: Diagnostic[];
  blocks: BlockResult[];
  status: TranslationStatus;
  consistency?: ConsistencyReport;
};

function failedOutcome(
  block: Block,
  err: unknown,
  extra: Diagnostic[] = [],
  counts: { droppedNodes: number; unknownNodes: number } = { droppedNodes: 0, unknownNodes: 0 }
): BlockOutcome {
  const reason = classifyFailure(err);
  if (!reason) throw err;
  return {
    id: block.id,
    status: "failed",
    code: "",
    ...counts,
    failureReason: reason,
    diagnostics: [
      ...extra,
      {
        blockId: block.id,
        severity: "error",
        code: `BLOCK_${reason.toUpperCase()}`,
        message: failureMessage(reason, err),
      },
    ],
    error: err,
  };
}

const STATUS_RANK: Record<TranslationStatus, number> = { ok: 0, partial: 1, failed: 2 };

function assemble(outcomes: BlockOutcome[], options: TranslateOptions): TranslationOutcome {
  if (
    options.throwOnFailure &&
    outcomes.length > 0 &&
    outcomes.every((o) => o.status === "failed")
  ) {
    throw outcomes[0].error ?? new Error("Translation failed");
  }

  const target = getTarget(options.target);
  const marker = options.failedBlockMarker !== false;
  const snippets = outcomes
    .map((o) =>
      o.status === "failed"
        ? marker
          ? target.lineComment(`[block ${o.id}: translation failed]`)
          : ""
        : o.code
    )
    .filter(Boolean);

  const prefix = Boolean(options.separateBlocks);
  const diagnosticsDetailed = outcomes.flatMap((o) => o.diagnostics);
  const diagnostics = outcomes.flatMap((o) =>
    o.diagnostics.map((d) => (prefix ? `[${o.id}] ${d.message}` : d.message))
  );
  const status = outcomes.reduce<TranslationStatus>(
    (worst, o) => (STATUS_RANK[o.status] > STATUS_RANK[worst] ? o.status : worst),
    "ok"
  );
  const blocks: BlockResult[] = outcomes.map(
    ({ id, status, code, droppedNodes, unknownNodes, failureReason }) => ({
      id,
      status,
      code,
      ...(target.id === "python" ? { pythonCode: code } : {}),
      droppedNodes,
      unknownNodes,
      ...(failureReason ? { failureReason } : {}),
    })
  );
  const withConsistency = outcomes.filter((o) => o.consistency);
  const consistency: ConsistencyReport | undefined =
    withConsistency.length > 0
      ? {
          samples: options.samples ?? 1,
          agreement:
            withConsistency.reduce((sum, o) => sum + o.consistency!.agreement, 0) /
            withConsistency.length,
          disagreeingLines: withConsistency.flatMap((o) =>
            o.consistency!.disagreeingLines.map((d) => ({ blockId: o.id, ...d }))
          ),
        }
      : undefined;
  return {
    code: snippets.join("\n\n"),
    target: target.id,
    diagnostics,
    diagnosticsDetailed,
    blocks,
    status,
    ...(consistency ? { consistency } : {}),
  };
}

function blocksToTranslate(blocks: Block[], options: TranslateOptions): Block[] {
  if (options.separateBlocks) return blocks;
  return [
    {
      id: blocks.map((block) => block.id).join(",") || "combined",
      text: blocks.map((block) => block.text).join("\n\n"),
    },
  ];
}

export async function translateBlocks(
  blocks: Block[],
  options: TranslateOptions
): Promise<string> {
  return (await translateBlocksDetailed(blocks, options)).code;
}

/** Direct mode with per-block status. */
export async function translateBlocksDetailed(
  blocks: Block[],
  options: TranslateOptions
): Promise<TranslationOutcome> {
  options = withRequestId(options);
  const outcomes: BlockOutcome[] = [];
  for (const block of blocksToTranslate(blocks, options)) {
    const started = Date.now();
    const outcome = await translateDirectBlock(block, options);
    traceBlockResult(options, "direct", block, outcome, Date.now() - started);
    outcomes.push(outcome);
  }
  return assemble(outcomes, options);
}

async function translateDirectBlock(
  block: Block,
  options: TranslateOptions
): Promise<BlockOutcome> {
  try {
    const result = await translateSingleBlock(block, options);
    const code = result.code.trim();
    if (!code && block.text.trim()) {
      throw new LlmResponseError("empty_response", "Model returned no code.");
    }
    return {
      id: block.id,
      // A syntax error means the code is not fully usable: report it as partial.
      status: result.syntaxErrors > 0 ? "partial" : "ok",
      code,
      droppedNodes: 0,
      unknownNodes: 0,
      diagnostics: result.diagnostics,
    };
  } catch (err) {
    return failedOutcome(block, err);
  }
}

type DirectResult = {
  code: string;
  diagnostics: Diagnostic[];
  syntaxErrors: number;
};

async function translateSingleBlock(
  block: Block,
  options: TranslateOptions
): Promise<DirectResult> {
  const target = getTarget(options.target);
  const prompt = target.direct.prompt(options.promptVersion);

  const userContent =
    `Translate the following block into ${target.direct.languageName}. ` +
    "Preserve the logical structure and order of steps, using simple code suitable for beginners. " +
    "Add nothing that is not explicitly stated in the instructions.\n\n" +
    block.text;

  const rawText = await callLlm(
    prompt.text,
    userContent,
    options,
    // Same default as AST mode so the two can be compared fairly.
    options.reasoningEffort ?? "low",
    { blockId: block.id, mode: "direct", inputText: block.text }
  );

  const processed = target.direct.postProcess(rawText, block.text, options.directPostProcess);
  const diagnostics: Diagnostic[] = [];

  if (processed.emittedPrints > processed.requestedOutputLines) {
    diagnostics.push({
      blockId: block.id,
      severity: "warning",
      code: "DIRECT_EXTRA_PRINTS",
      message: `The model emitted ${processed.emittedPrints} ${target.direct.outputCallName} call(s) but only ${processed.requestedOutputLines} source line(s) ask for output.`,
    });
  }

  let syntaxErrors = 0;
  if (options.directParseCheck !== false && processed.code) {
    const problems = await target.direct.checkSyntax(processed.code);
    for (const p of problems ?? []) {
      syntaxErrors++;
      diagnostics.push({
        blockId: block.id,
        line: p.line,
        severity: "error",
        code: "DIRECT_SYNTAX_ERROR",
        message: p.message,
      });
    }
  }

  return { code: processed.code, diagnostics, syntaxErrors };
}

type LlmCallResult = {
  text: string;
  /** Whether the JSON-schema `text.format` was in the request that succeeded. */
  structuredOutput: "on" | "off";
  /** True when `auto` mode retried without the schema after a 400/422. */
  fellBack: boolean;
  /** Temperature actually sent (undefined = backend default). */
  temperature?: number;
};

/** Everything needed to label trace records for one model call or block. */
type TraceCtx = {
  blockId: string;
  mode: "direct" | "ast";
  sampleIndex?: number;
  inputText: string;
};

function promptFor(mode: "direct" | "ast", options: TranslateOptions) {
  if (mode === "ast") return AST_PROMPT_V2;
  return getTarget(options.target).direct.prompt(options.promptVersion);
}

/** Ensures one requestId is shared by every record of a translation. */
function withRequestId(options: TranslateOptions): TranslateOptions {
  return options.requestId ? options : { ...options, requestId: randomUUID() };
}

function llmIdentity(options: TranslateOptions) {
  try {
    const c = resolveLlmConfig(options);
    return { llmApi: c.llmApi, endpointHost: endpointHost(c.endpoint), model: c.model };
  } catch {
    return {};
  }
}

function effectiveTemperature(options: TranslateOptions): number | undefined {
  return (options.llmApi ?? "azure") === "gateway" ? options.temperature : undefined;
}

function traceBlockResult(
  options: TranslateOptions,
  mode: "direct" | "ast",
  block: Block,
  outcome: BlockOutcome,
  durationMs: number
): void {
  if (!options.trace) return;
  const prompt = promptFor(mode, options);
  const includeInput = options.traceIncludeInput === true;
  emitTrace(options, {
    event: "block_result",
    requestId: options.requestId ?? "",
    blockId: block.id,
    mode,
    target: getTarget(options.target).id,
    promptId: prompt.id,
    promptSha256: sha256Hex(prompt.text),
    ...(mode === "ast" ? { astSchemaVersion: AST_SCHEMA_VERSION } : {}),
    ...llmIdentity(options),
    reasoningEffort: options.reasoningEffort ?? "low",
    temperature: effectiveTemperature(options),
    inputSha256: sha256Hex(block.text),
    ...(includeInput ? { inputText: block.text, finalCode: outcome.code } : {}),
    diagnostics: redactDiagnostics(outcome.diagnostics, includeInput),
    status: outcome.status,
    ...(outcome.failureReason ? { error: outcome.failureReason } : {}),
    durationMs,
  });
}

async function callLlm(
  systemPrompt: string,
  userContent: string,
  options: TranslateOptions,
  reasoningEffort?: TranslateOptions["reasoningEffort"],
  ctx?: TraceCtx
): Promise<string> {
  return (
    await callLlmDetailed(systemPrompt, userContent, options, reasoningEffort, undefined, ctx)
  ).text;
}

async function callLlmDetailed(
  systemPrompt: string,
  userContent: string,
  options: TranslateOptions,
  reasoningEffort?: TranslateOptions["reasoningEffort"],
  structured?: { mode: "auto" | "on" | "off" },
  ctx?: TraceCtx
): Promise<LlmCallResult> {
  const config = resolveLlmConfig(options);
  const started = Date.now();
  let responseStatus: string | undefined;
  let usage: unknown;

  const emit = (extra: { result?: LlmCallResult; error?: string }) => {
    if (!options.trace || !ctx) return;
    const prompt = promptFor(ctx.mode, options);
    const includeInput = options.traceIncludeInput === true;
    emitTrace(options, {
      event: "llm_call",
      requestId: options.requestId ?? "",
      blockId: ctx.blockId,
      mode: ctx.mode,
      target: getTarget(options.target).id,
      ...(ctx.sampleIndex !== undefined ? { sampleIndex: ctx.sampleIndex } : {}),
      promptId: prompt.id,
      promptSha256: sha256Hex(prompt.text),
      ...(ctx.mode === "ast" ? { astSchemaVersion: AST_SCHEMA_VERSION } : {}),
      llmApi: config.llmApi,
      endpointHost: endpointHost(config.endpoint),
      model: config.model,
      reasoningEffort,
      temperature: extra.result?.temperature,
      ...(extra.result
        ? {
            structuredOutput: extra.result.structuredOutput,
            structuredOutputFellBack: extra.result.fellBack,
          }
        : {}),
      inputSha256: sha256Hex(ctx.inputText),
      ...(includeInput ? { inputText: ctx.inputText } : {}),
      responseStatus,
      usage,
      ...(extra.error ? { error: extra.error } : {}),
      ...(includeInput && extra.result ? { rawOutputText: extra.result.text } : {}),
      durationMs: Date.now() - started,
    });
  };

  try {
    const result = await callResponses(
      systemPrompt,
      userContent,
      config,
      reasoningEffort,
      options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      structured,
      options.temperature,
      (data) => {
        responseStatus = typeof data?.status === "string" ? data.status : undefined;
        usage = data?.usage;
      }
    );
    emit({ result });
    return result;
  } catch (err) {
    emit({ error: classifyFailure(err) ?? "error" });
    throw err;
  }
}

/** Endpoints that rejected `text.format` json_schema (auto mode), for the process lifetime. */
const structuredUnsupported = new Set<string>();

/** Test hook: forget which endpoints were found not to support structured output. */
export function resetStructuredOutputCache(): void {
  structuredUnsupported.clear();
}

const SCHEMA_ERROR = /schema|format|structured|response_format/i;

async function callResponses(
  systemPrompt: string,
  userContent: string,
  config: ResolvedLlmConfig,
  reasoningEffort: TranslateOptions["reasoningEffort"] | undefined,
  timeoutMs: number,
  structured?: { mode: "auto" | "on" | "off" },
  temperature?: number,
  onResponse?: (data: any) => void
): Promise<LlmCallResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort };
  }

  // gpt-5 reasoning models (azure) ignore or reject `temperature`, so it is never
  // sent there. The gateway gets it only when the caller sets it.
  const effectiveTemperature =
    config.llmApi === "gateway" && temperature !== undefined ? temperature : undefined;
  if (effectiveTemperature !== undefined) body.temperature = effectiveTemperature;

  const mode = structured?.mode ?? "off";
  const useSchema =
    mode === "on" || (mode === "auto" && !structuredUnsupported.has(config.endpoint));
  if (useSchema) body.text = astResponseFormat();

  try {
    const data = await postLlm(config, body, timeoutMs);
    onResponse?.(data);
    return {
      text: extractResponseText(data),
      structuredOutput: useSchema ? "on" : "off",
      fellBack: false,
      temperature: effectiveTemperature,
    };
  } catch (err) {
    const schemaRejected =
      useSchema &&
      mode === "auto" &&
      err instanceof LlmHttpError &&
      (err.status === 400 || err.status === 422) &&
      SCHEMA_ERROR.test(err.body);
    if (!schemaRejected) throw err;
    structuredUnsupported.add(config.endpoint);
  }

  // auto mode: retry once without the schema.
  delete body.text;
  const data = await postLlm(config, body, timeoutMs);
  onResponse?.(data);
  return {
    text: extractResponseText(data),
    structuredOutput: "off",
    fellBack: true,
    temperature: effectiveTemperature,
  };
}

export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** The upstream LLM endpoint answered with a non-2xx status. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`LLM request failed (${status}): ${body}`);
    this.name = "LlmHttpError";
  }
}

async function postLlm(
  config: ResolvedLlmConfig,
  body: Record<string, unknown> | object,
  timeoutMs: number
): Promise<any> {
  const res = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...config.authHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new LlmHttpError(res.status, await res.text());
  }

  return res.json();
}

export function extractResponseText(data: any): string {
  // OpenAI Responses API: output[] items of type "message" hold content[] parts
  // of type "output_text". Concatenate ALL text parts of ALL messages.
  if (data?.status === "incomplete") {
    const why = data.incomplete_details?.reason;
    throw new LlmResponseError(
      "incomplete_response",
      `Model response was incomplete${why ? ` (${why})` : ""}.`
    );
  }

  const messages: string[] = [];
  let refused = false;
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) continue;
      let text = "";
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          text += part.text;
        } else if (part?.type === "refusal") {
          refused = true;
        }
      }
      if (text) messages.push(text);
    }
  }
  if (messages.length === 0 && typeof data?.output_text === "string") {
    messages.push(data.output_text);
  }

  const joined = messages.join("\n");
  if (joined.trim()) return joined;
  throw new LlmResponseError(
    "empty_response",
    refused ? "Model refused to answer." : "Model response contained no text."
  );
}

/**
 * Post-processes direct-mode model output: strips markdown fences and comments
 * (string-aware). Nothing is rewritten or deleted beyond that; use
 * `directPostProcess: "none"` to keep comments as well. Kept for compatibility:
 * `strictOutputFidelity` no longer deletes lines in direct mode (see
 * DIRECT_EXTRA_PRINTS).
 */
export function enforceFidelity(
  modelText: string,
  sourceText: string,
  options: {
    strictOutputFidelity?: boolean;
    directPostProcess?: DirectPostProcess;
  } = {}
): string {
  return postProcessDirect(modelText, sourceText, options.directPostProcess).code;
}

// ---------------------------------------------------------------------------
// AST pipeline: LLM transcribes NL -> AST (JSON), then we deterministically
// generate Python from the AST. The LLM never writes Python, so it cannot add
// statements; any node not grounded in the source is dropped during verify.
// ---------------------------------------------------------------------------

export type AstTranslationResult = TranslationOutcome;

export async function translateBlocksViaAst(
  blocks: Block[],
  options: TranslateOptions
): Promise<AstTranslationResult> {
  options = withRequestId(options);
  const outcomes: BlockOutcome[] = [];
  for (const block of blocksToTranslate(blocks, options)) {
    const started = Date.now();
    const outcome = await translateSingleBlockViaAst(block, options);
    traceBlockResult(options, "ast", block, outcome, Date.now() - started);
    outcomes.push(outcome);
  }
  return assemble(outcomes, options);
}

function countUnknown(statements: Stmt[]): number {
  let n = 0;
  for (const stmt of statements) {
    if (stmt.kind === "unknown") n++;
    for (const body of childStatementLists(stmt)) n += countUnknown(body);
  }
  return n;
}

/** One verified (and grounded) AST sample, before code generation. */
type AstSample =
  | { ok: false; outcome: BlockOutcome }
  | {
      ok: true;
      index: number;
      statements: Stmt[];
      diagnostics: Diagnostic[];
      droppedNodes: number;
      unknownNodes: number;
      groundingWarnings: number;
    };

const MAX_SAMPLES = 7;
const SAMPLE_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `limit` calls in flight; keeps result order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function validateSamples(samples: number | undefined): number {
  if (samples === undefined) return 1;
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) {
    throw new RangeError(`samples must be an integer between 1 and ${MAX_SAMPLES}`);
  }
  return samples;
}

async function runAstSample(
  block: Block,
  options: TranslateOptions,
  index: number
): Promise<AstSample> {
  const numberedSource = block.text
    .split(/\r?\n/)
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");

  const userContent =
    "Convert the following numbered instructions into the JSON AST described above. " +
    "Cite each node's origin with its line number. Output only the JSON object.\n\n" +
    numberedSource;

  let rawText: string;
  const preDiagnostics: Diagnostic[] = [];
  try {
    const call = await callLlmDetailed(
      AST_PROMPT_V2.text,
      userContent,
      options,
      options.reasoningEffort ?? "low",
      { mode: options.structuredOutput ?? "auto" },
      { blockId: block.id, mode: "ast", sampleIndex: index, inputText: block.text }
    );
    rawText = call.text;
    if (call.fellBack) {
      preDiagnostics.push({
        blockId: block.id,
        severity: "info",
        code: "STRUCTURED_OUTPUT_UNSUPPORTED",
        message:
          "The endpoint rejected structured output; retried without a JSON schema.",
      });
    }
  } catch (err) {
    return { ok: false, outcome: failedOutcome(block, err) };
  }

  let parsed: any;
  try {
    parsed = parseJsonObject(rawText);
  } catch (err: any) {
    return {
      ok: false,
      outcome: failedOutcome(
        block,
        new LlmResponseError(
          "parse_error",
          `Could not parse model output as JSON: ${err.message ?? String(err)}`
        )
      ),
    };
  }

  // Strict-mode responses use null for absent optional fields.
  parsed = stripNulls(parsed);

  const verified = verifyProgram(parsed, block.text, {
    strictOutputFidelity: options.strictOutputFidelity,
  });
  let statements = verified.statements;
  const diagnostics: Diagnostic[] = [
    ...preDiagnostics,
    ...verified.diagnosticsDetailed.map((d) => ({ blockId: block.id, ...d })),
  ];

  // Evidence-based grounding: flag (warn, default) or neutralise (strict) steps
  // that cannot be traced to the cited source text.
  const groundingMode = options.grounding ?? "warn";
  if (groundingMode !== "off") {
    const grounded = checkGrounding(statements, block.text, {
      mode: groundingMode,
      maxStatementsPerLine: options.maxStatementsPerLine,
    });
    statements = grounded.statements;
    diagnostics.push(
      ...grounded.diagnostics.map((d) => ({ blockId: block.id, ...d }))
    );
  }

  return {
    ok: true,
    index,
    statements,
    diagnostics,
    droppedNodes: verified.droppedNodes,
    unknownNodes: countUnknown(statements),
    groundingWarnings: diagnostics.filter(
      (d) => d.code.startsWith("GROUNDING_") && d.severity === "warning"
    ).length,
  };
}

async function translateSingleBlockViaAst(
  block: Block,
  options: TranslateOptions
): Promise<BlockOutcome> {
  const n = validateSamples(options.samples);
  const samples = await mapWithConcurrency(
    Array.from({ length: n }, (_v, i) => i),
    SAMPLE_CONCURRENCY,
    (i) => runAstSample(block, options, i)
  );

  const good = samples.filter((s): s is Extract<AstSample, { ok: true }> => s.ok);
  if (good.length === 0) {
    return (samples[0] as Extract<AstSample, { ok: false }>).outcome;
  }

  let chosen = good[0];
  let consistency: BlockOutcome["consistency"];
  const extra: Diagnostic[] = [];
  if (n > 1) {
    const summaries: SampleSummary[] = good.map((s) => ({
      index: s.index,
      statements: s.statements,
      groundingWarnings: s.groundingWarnings,
      unknownNodes: s.unknownNodes,
    }));
    const { chosen: pick, agreeing } = selectConsensus(summaries);
    chosen = good.find((s) => s.index === pick.index)!;
    const lines = disagreeingLines(summaries);
    consistency = { agreement: agreeing / n, disagreeingLines: lines };
    samples.forEach((s, i) => {
      if (s.ok) return;
      extra.push({
        blockId: block.id,
        severity: "warning",
        code: "SAMPLE_FAILED",
        message: `Sample ${i + 1} of ${n} failed (${s.outcome.failureReason ?? "error"}) and was ignored.`,
      });
    });
    for (const { line, variants } of lines) {
      extra.push({
        blockId: block.id,
        line,
        severity: "warning",
        code: "CONSISTENCY_DISAGREEMENT",
        message: `Line ${line} was read ${variants} different ways across ${n} samples.`,
      });
    }
  }

  const { statements, droppedNodes } = chosen;
  const diagnostics: Diagnostic[] = [...chosen.diagnostics];

  // Code generation first: a target may be unable to express constructs the
  // AST can represent (e.g. try/except in C). Those count like `unknown` nodes.
  const target = getTarget(options.target);
  const codegenDetailed: CodegenDiagnostic[] = [];
  const generated = target.generate(statements, codegenDetailed);
  const unknownNodes = chosen.unknownNodes + generated.unsupportedNodes;

  // When configured to fall back, hand any block containing constructs the AST
  // (or the target) cannot represent to the direct (best-effort) translation
  // mode instead of emitting `unsupported` comments.
  if (options.unsupportedBehavior === "fallback" && unknownNodes > 0) {
    try {
      const direct = await translateSingleBlock(block, options);
      const code = direct.code.trim();
      if (code) {
        diagnostics.push(...direct.diagnostics, {
          blockId: block.id,
          severity: "info",
          code: "FALLBACK_TO_DIRECT",
          message:
            "Block contained unsupported construct(s); fell back to direct best-effort translation.",
        });
        return {
          id: block.id,
          status: "partial",
          code,
          droppedNodes,
          unknownNodes,
          diagnostics: [...diagnostics, ...extra],
          consistency,
        };
      }
    } catch (err) {
      if (!classifyFailure(err)) throw err;
      diagnostics.push({
        blockId: block.id,
        severity: "warning",
        code: "FALLBACK_FAILED",
        message: `Direct fallback failed; kept the AST translation. ${failureMessage(classifyFailure(err)!, err)}`,
      });
    }
  }

  const code = generated.code;
  diagnostics.push(
    ...codegenDetailed.map((d) => ({ blockId: block.id, ...d })),
    ...extra
  );

  if (!code && block.text.trim()) {
    return {
      ...failedOutcome(
        block,
        new LlmResponseError("empty_response", "Model output contained no usable steps."),
        diagnostics,
        { droppedNodes, unknownNodes }
      ),
      consistency,
    };
  }

  const partial = droppedNodes > 0 || unknownNodes > 0;
  return {
    id: block.id,
    status: partial ? "partial" : "ok",
    code,
    droppedNodes,
    unknownNodes,
    diagnostics,
    consistency,
  };
}

/**
 * Extracts a JSON object from a model response that may be wrapped in markdown
 * fences or surrounded by stray text.
 */
function parseJsonObject(text: string): any {
  const cleaned = stripCodeFences(text);
  try {
    return parseJsonKeepingNumberText(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON object found in response");
    }
    return parseJsonKeepingNumberText(cleaned.slice(start, end + 1));
  }
}

/**
 * JSON.parse collapses `10.0` to the number 10. Use the reviver's source-text
 * access (Node >= 21) to keep the literal as `raw` on `num` nodes, unless the
 * model already supplied one.
 */
function parseJsonKeepingNumberText(text: string): any {
  return JSON.parse(text, function (this: any, key: string, value: unknown, context?: { source?: string }) {
    if (
      key === "value" &&
      typeof value === "number" &&
      this?.kind === "num" &&
      this.raw === undefined &&
      typeof context?.source === "string" &&
      context.source !== String(value)
    ) {
      this.raw = context.source;
    }
    return value;
  } as any);
}
