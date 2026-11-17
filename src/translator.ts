import type {
  Block,
  BlockResult,
  Diagnostic,
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
import { checkGrounding } from "./grounding.js";
import { AST_PROMPT_V2 } from "./prompts/ast.v2.js";
import { generatePython, type CodegenDiagnostic } from "./codegen.js";
import { countRequestedPrints } from "./outputVerbs.js";

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

type BlockOutcome = BlockResult & { diagnostics: Diagnostic[]; error?: unknown };

export type TranslationOutcome = {
  pythonCode: string;
  /** Human-readable diagnostics (always collected; callers decide what to return). */
  diagnostics: string[];
  diagnosticsDetailed: Diagnostic[];
  blocks: BlockResult[];
  status: TranslationStatus;
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
    pythonCode: "",
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

  const marker = options.failedBlockMarker !== false;
  const snippets = outcomes
    .map((o) =>
      o.status === "failed"
        ? marker
          ? `# [block ${o.id}: translation failed]`
          : ""
        : o.pythonCode
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
    ({ id, status, pythonCode, droppedNodes, unknownNodes, failureReason }) => ({
      id,
      status,
      pythonCode,
      droppedNodes,
      unknownNodes,
      ...(failureReason ? { failureReason } : {}),
    })
  );
  return {
    pythonCode: snippets.join("\n\n"),
    diagnostics,
    diagnosticsDetailed,
    blocks,
    status,
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
  return (await translateBlocksDetailed(blocks, options)).pythonCode;
}

/** Direct mode with per-block status. */
export async function translateBlocksDetailed(
  blocks: Block[],
  options: TranslateOptions
): Promise<TranslationOutcome> {
  const outcomes: BlockOutcome[] = [];
  for (const block of blocksToTranslate(blocks, options)) {
    outcomes.push(await translateDirectBlock(block, options));
  }
  return assemble(outcomes, options);
}

async function translateDirectBlock(
  block: Block,
  options: TranslateOptions
): Promise<BlockOutcome> {
  try {
    const code = (await translateSingleBlock(block, options)).trim();
    if (!code && block.text.trim()) {
      throw new LlmResponseError("empty_response", "Model returned no code.");
    }
    return {
      id: block.id,
      status: "ok",
      pythonCode: code,
      droppedNodes: 0,
      unknownNodes: 0,
      diagnostics: [],
    };
  } catch (err) {
    return failedOutcome(block, err);
  }
}

async function translateSingleBlock(
  block: Block,
  options: TranslateOptions
): Promise<string> {
  const systemPrompt =
    "You translate beginner-friendly natural language programming instructions into Python. " +
    "Each input is a single block, translated independently. " +
    "Use only basic Python (variables, arithmetic, if/else, for/while, print). " +
    "Use global variables rather than defining functions.\n" +
    "CRITICAL FIDELITY RULES:\n" +
    "- Translate ONLY what is explicitly written. Never add, infer, or invent logic, " +
    "variables, or statements that are not directly stated in the instructions.\n" +
    "- Never add a print/output statement unless the instruction explicitly asks to print, " +
    "show, display, output, tulosta, näytä, or kirjoita something. Do not add prints to show results, to debug, or to be helpful.\n" +
    "- Do not add example usage, test code, default values, or extra output.\n" +
    "- Produce code for each given step only; do not introduce steps that are not there.\n" +
    "- Output only raw Python code: no comments, no explanations, no markdown code fences.\n" +
    "STYLE RULES:\n" +
    "- Do not use augmented assignment operators (+=, -=, *=, /=, %=). Always write " +
    "the assignment out in full, e.g. use `a = a + value` instead of `a += value`.\n" +
    "- For reading user input, use simple assignments only, e.g. `name = input()` or " +
    "`points = int(input())`. Never use conditional expressions, placeholders, or tricks.";

  const userContent =
    "Translate the following block into Python. " +
    "Preserve the logical structure and order of steps, using simple code suitable for beginners. " +
    "Add nothing that is not explicitly stated in the instructions.\n\n" +
    block.text;

  const rawText = await callLlm(
    systemPrompt,
    userContent,
    options,
    options.reasoningEffort
  );
  return enforceFidelity(rawText, block.text, {
    strictOutputFidelity: options.strictOutputFidelity,
  });
}

type LlmCallResult = {
  text: string;
  /** Whether the JSON-schema `text.format` was in the request that succeeded. */
  structuredOutput: "on" | "off";
  /** True when `auto` mode retried without the schema after a 400/422. */
  fellBack: boolean;
};

async function callLlm(
  systemPrompt: string,
  userContent: string,
  options: TranslateOptions,
  reasoningEffort?: TranslateOptions["reasoningEffort"]
): Promise<string> {
  return (await callLlmDetailed(systemPrompt, userContent, options, reasoningEffort)).text;
}

async function callLlmDetailed(
  systemPrompt: string,
  userContent: string,
  options: TranslateOptions,
  reasoningEffort?: TranslateOptions["reasoningEffort"],
  structured?: { mode: "auto" | "on" | "off" }
): Promise<LlmCallResult> {
  const config = resolveLlmConfig(options);
  return callResponses(
    systemPrompt,
    userContent,
    config,
    reasoningEffort,
    options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    structured
  );
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
  structured?: { mode: "auto" | "on" | "off" }
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

  const mode = structured?.mode ?? "off";
  const useSchema =
    mode === "on" || (mode === "auto" && !structuredUnsupported.has(config.endpoint));
  if (useSchema) body.text = astResponseFormat();

  try {
    const data = await postLlm(config, body, timeoutMs);
    return {
      text: extractResponseText(data),
      structuredOutput: useSchema ? "on" : "off",
      fellBack: false,
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
  return { text: extractResponseText(data), structuredOutput: "off", fellBack: true };
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
 * Post-processes direct-mode model output. Always strips markdown code fences,
 * comments, and dead conditional expressions the model sometimes invents.
 * When strictOutputFidelity is set, also removes print() lines beyond the
 * number of source lines that use explicit output verbs.
 */
export function enforceFidelity(
  modelText: string,
  sourceText: string,
  options: { strictOutputFidelity?: boolean } = {}
): string {
  const withoutFences = stripCodeFences(modelText);
  const withoutComments = withoutFences
    .split(/\r?\n/)
    .map(stripLineComments)
    .filter((line) => line.trim().length > 0)
    .join("\n");
  const simplified = simplifyDeadTernaries(withoutComments);
  if (!options.strictOutputFidelity) {
    return simplified;
  }
  const allowedPrints = countRequestedPrints(sourceText);
  return removeUnrequestedPrints(simplified, allowedPrints);
}

/** Removes `# ...` from a line, respecting string literals. */
function stripLineComments(line: string): string {
  let inString: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "#") {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/**
 * Collapses dead conditional expressions the model sometimes emits, e.g.
 * `int(input()) if False else int(input())` -> `int(input())`.
 */
function simplifyDeadTernaries(pythonCode: string): string {
  return pythonCode
    .split(/\r?\n/)
    .map((line) => {
      const assignFalse = line.match(
        /^(\s*\w+\s*=\s*)(.+)\s+if\s+False\s+else\s+(.+)$/
      );
      if (assignFalse) {
        return `${assignFalse[1]}${assignFalse[3].trim()}`;
      }
      const assignTrue = line.match(
        /^(\s*\w+\s*=\s*)(.+)\s+if\s+True\s+else\s+(.+)$/
      );
      if (assignTrue) {
        return `${assignTrue[1]}${assignTrue[2].trim()}`;
      }
      const falseElse = line.match(/^(\s*)(.+?)\s+if\s+False\s+else\s+(.+)$/);
      if (falseElse) {
        return `${falseElse[1]}${falseElse[3].trim()}`;
      }
      const trueElse = line.match(/^(\s*)(.+?)\s+if\s+True\s+else\s+(.+)$/);
      if (trueElse) {
        return `${trueElse[1]}${trueElse[2].trim()}`;
      }
      return line;
    })
    .join("\n");
}

function stripCodeFences(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .trim();
}

function indentWidth(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

/**
 * Removes any print() statements beyond `allowed`, preserving order (the first
 * `allowed` prints are kept). If a removed print is the sole body of an indented
 * block, it is replaced with `pass` so the code stays syntactically valid.
 */
function removeUnrequestedPrints(pythonCode: string, allowed: number): string {
  const lines = pythonCode.split(/\r?\n/);
  const out: string[] = [];
  let kept = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isPrint = /^\s*print\s*\(/.test(line);

    if (isPrint && kept >= allowed) {
      if (indentWidth(line) > 0 && isSoleBlockBody(lines, i)) {
        out.push(line.slice(0, indentWidth(line)) + "pass");
      }
      continue;
    }

    if (isPrint) kept++;
    out.push(line);
  }

  return out.join("\n").trim();
}

/**
 * True when the statement at `idx` is the only statement inside its block, i.e.
 * the previous non-empty line opens a block (`...:`) at a smaller indent and the
 * block ends right after this line. Used to avoid leaving an empty block body.
 */
function isSoleBlockBody(lines: string[], idx: number): boolean {
  const indent = indentWidth(lines[idx]);

  let prev = idx - 1;
  while (prev >= 0 && !lines[prev].trim()) prev--;
  if (prev < 0) return false;
  const opensBlock =
    lines[prev].trimEnd().endsWith(":") && indentWidth(lines[prev]) < indent;
  if (!opensBlock) return false;

  let next = idx + 1;
  while (next < lines.length && !lines[next].trim()) next++;
  if (next >= lines.length) return true;
  return indentWidth(lines[next]) < indent;
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
  const outcomes: BlockOutcome[] = [];
  for (const block of blocksToTranslate(blocks, options)) {
    outcomes.push(await translateSingleBlockViaAst(block, options));
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

async function translateSingleBlockViaAst(
  block: Block,
  options: TranslateOptions
): Promise<BlockOutcome> {
  const numberedSource = block.text
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
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
      { mode: options.structuredOutput ?? "auto" }
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
    return failedOutcome(block, err);
  }

  let parsed: any;
  try {
    parsed = parseJsonObject(rawText);
  } catch (err: any) {
    return failedOutcome(
      block,
      new LlmResponseError(
        "parse_error",
        `Could not parse model output as JSON: ${err.message ?? String(err)}`
      )
    );
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
  const unknownNodes = countUnknown(statements);

  // When configured to fall back, hand any block containing constructs the AST
  // cannot represent to the direct (best-effort) translation mode instead of
  // emitting `# unsupported:` comments.
  if (options.unsupportedBehavior === "fallback" && unknownNodes > 0) {
    try {
      const pythonCode = (await translateSingleBlock(block, options)).trim();
      if (pythonCode) {
        diagnostics.push({
          blockId: block.id,
          severity: "info",
          code: "FALLBACK_TO_DIRECT",
          message:
            "Block contained unsupported construct(s); fell back to direct best-effort translation.",
        });
        return {
          id: block.id,
          status: "partial",
          pythonCode,
          droppedNodes: verified.droppedNodes,
          unknownNodes,
          diagnostics,
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

  const codegenDetailed: CodegenDiagnostic[] = [];
  const pythonCode = generatePython(statements, [], codegenDetailed);
  diagnostics.push(
    ...codegenDetailed.map((d) => ({ blockId: block.id, ...d }))
  );

  if (!pythonCode && block.text.trim()) {
    return failedOutcome(
      block,
      new LlmResponseError("empty_response", "Model output contained no usable steps."),
      diagnostics,
      { droppedNodes: verified.droppedNodes, unknownNodes }
    );
  }

  const partial = verified.droppedNodes > 0 || unknownNodes > 0;
  return {
    id: block.id,
    status: partial ? "partial" : "ok",
    pythonCode,
    droppedNodes: verified.droppedNodes,
    unknownNodes,
    diagnostics,
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
