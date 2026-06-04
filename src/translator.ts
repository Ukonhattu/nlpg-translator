import fetch from "node-fetch";
import type { Block, TranslateOptions } from "./index.js";
import { resolveLlmConfig, type ResolvedLlmConfig } from "./llmConfig.js";
import {
  statementsContainUnknown,
  verifyProgram,
} from "./ast.js";
import { generatePython } from "./codegen.js";
import { countRequestedPrints } from "./outputVerbs.js";

export async function translateBlocks(
  blocks: Block[],
  options: TranslateOptions
): Promise<string> {
  if (!options.separateBlocks) {
    const combinedBlock: Block = {
      id: blocks.map((block) => block.id).join(",") || "combined",
      text: blocks.map((block) => block.text).join("\n\n"),
    };
    return (await translateSingleBlock(combinedBlock, options)).trim();
  }

  const snippets: string[] = [];
  for (const block of blocks) {
    const code = await translateSingleBlock(block, options);
    snippets.push(code.trim());
  }
  return snippets.filter(Boolean).join("\n\n");
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
    "the assignment out in full, e.g. use `a = a + value` instead of `a += value`.";

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

async function callLlm(
  systemPrompt: string,
  userContent: string,
  options: TranslateOptions,
  reasoningEffort?: TranslateOptions["reasoningEffort"]
): Promise<string> {
  const config = resolveLlmConfig(options);
  return callResponses(systemPrompt, userContent, config, reasoningEffort);
}

async function callResponses(
  systemPrompt: string,
  userContent: string,
  config: ResolvedLlmConfig,
  reasoningEffort?: TranslateOptions["reasoningEffort"]
): Promise<string> {
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

  const data = await postLlm(config, body);
  return extractResponseText(data);
}

async function postLlm(
  config: ResolvedLlmConfig,
  body: Record<string, unknown> | object
): Promise<any> {
  const res = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...config.authHeaders,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed (${res.status}): ${text}`);
  }

  return res.json();
}

export function extractResponseText(data: any): string {
  // Aalto uses OpenAI Responses API format. We want the assistant's text only.
  // Example: data.output is an array; we find the message with type "message",
  // then its content item with type "output_text" and read .text.
  if (Array.isArray(data.output)) {
    const msg = data.output.find((item: any) => item.type === "message");
    if (msg && Array.isArray(msg.content)) {
      const textItem = msg.content.find(
        (c: any) => c.type === "output_text" && typeof c.text === "string"
      );
      if (textItem) {
        return textItem.text as string;
      }
    }
  }

  // Fallback: try a few generic locations, otherwise dump JSON as string.
  const fallback =
    data.output?.[0]?.content?.[0]?.text ||
    data.output?.[0]?.content ||
    data.text ||
    JSON.stringify(data);

  return typeof fallback === "string" ? fallback : String(fallback ?? "");
}

/**
 * Post-processes direct-mode model output. Always strips markdown code fences.
 * When strictOutputFidelity is set, also removes print() lines beyond the
 * number of source lines that use explicit output verbs.
 */
export function enforceFidelity(
  modelText: string,
  sourceText: string,
  options: { strictOutputFidelity?: boolean } = {}
): string {
  const withoutFences = stripCodeFences(modelText);
  if (!options.strictOutputFidelity) {
    return withoutFences;
  }
  const allowedPrints = countRequestedPrints(sourceText);
  return removeUnrequestedPrints(withoutFences, allowedPrints);
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

export type AstTranslationResult = {
  pythonCode: string;
  diagnostics: string[];
};

const AST_SYSTEM_PROMPT = `You are a parser. Convert beginner-friendly natural language programming instructions into a JSON Abstract Syntax Tree (AST). You DO NOT write Python. Map English and Finnish course phrasing to the same AST.

Output ONLY a single JSON object: { "statements": Stmt[] }

Numbered input: every Stmt MUST include "line" (1-based source line). Do NOT copy source text into nodes.

Statement nodes:
- assign: { "kind":"assign", "target"?: string, "targetExpr"?: Expr, "value": Expr, "line": n }  // variable assignment OR subscript assign (use targetExpr for list[i])
- unpackassign: { "kind":"unpackassign", "targets": string[], "value": Expr, "line": n }  // multiple names from one value / tuple unpack
- augassign: { "kind":"augassign", "target": string, "op":"+"|"-"|"*"|"/", "value": Expr, "line": n }
- print: { "kind":"print", "value": Expr, "line": n }  // ONLY when output is explicitly requested (print/tulosta/näytä/kirjoita/…)
- if: { "kind":"if", "test": Expr, "body": Stmt[], "elifs"?: [{"test":Expr,"body":Stmt[]}], "orelse": Stmt[], "line": n }  // elif/else chains
- while: { "kind":"while", "test": Expr, "body": Stmt[], "line": n }  // includes while True
- repeat: { "kind":"repeat", "count": Expr, "body": Stmt[], "line": n }  // fixed-count loop without index variable
- for: { "kind":"for", "loopVar": string, "start": Expr, "stop": Expr, "step"?: Expr, "body": Stmt[], "line": n }  // numeric range; stop is EXCLUSIVE (Python range)
- forin: { "kind":"forin", "loopVar": string, "iterable": Expr, "body": Stmt[], "line": n }  // for each item in a list
- break: { "kind":"break", "line": n }
- append: { "kind":"append", "target": string, "value": Expr, "line": n }  // add to end of list
- functiondef: { "kind":"functiondef", "name": string, "params": string[], "body": Stmt[], "docstring"?: string, "line": n }
- return: { "kind":"return", "values": Expr[], "line": n }  // empty values [] for bare return; multiple values for tuple return
- assert: { "kind":"assert", "test": Expr, "message"?: Expr, "line": n }
- raise: { "kind":"raise", "excType": string, "message"?: Expr, "line": n }  // e.g. ValueError
- try: { "kind":"try", "body": Stmt[], "handlers": [{"exc"?: string, "body": Stmt[]}], "line": n }  // try/except (exc e.g. ValueError)
- unknown: { "kind":"unknown", "line": n, "note"?: string }

Expression nodes:
- num, str, bool, var
- binop: + - * / %
- compare: > < >= <= == !=
- boolop: and | or (values: Expr[])
- not
- contains: { "kind":"contains", "left": Expr, "right": Expr }  // membership: left in right
- index: subscript target[index] (index 0 = first, -1 = last)
- list: { "kind":"list", "items": Expr[] }
- call: { "kind":"call", "func": string, "args": Expr[] }  // len, sum, max, min, int, float, str, …
- methodcall: { "kind":"methodcall", "target": Expr, "method": string, "args": Expr[] }  // strip, upper, lower, replace, capitalize, …
- fstring: { "kind":"fstring", "parts": [{"kind":"lit","value":string}|{"kind":"expr","value":Expr}] }
- input: { "kind":"input", "prompt"?: Expr, "cast"?: "int"|"float" }
- cast: { "kind":"cast", "type": "int"|"float"|"str", "value": Expr }

Course coverage (Python quick reference): print/input, variables, int/float/str conversion, f-strings, string + and methods, if/elif/else, and/or/not, for-over-list, for-range, while/break, lists (index/append/len/in/sum/max/min), def/return/call, tuple unpack return, assert, raise, try/except.

STRICT TRANSCRIPTION RULES:
- ONLY what the text literally says. Never infer, repair, or add steps.
- No print unless the line explicitly requests output.
- No invented defaults, tests, or extra output.
- If you cannot represent a construct, use "unknown" — do not guess.
- Each "line" must match the instruction line it represents.`;

export async function translateBlocksViaAst(
  blocks: Block[],
  options: TranslateOptions
): Promise<AstTranslationResult> {
  if (!options.separateBlocks) {
    const combined: Block = {
      id: blocks.map((block) => block.id).join(",") || "combined",
      text: blocks.map((block) => block.text).join("\n\n"),
    };
    return translateSingleBlockViaAst(combined, options);
  }

  const snippets: string[] = [];
  const diagnostics: string[] = [];
  for (const block of blocks) {
    const { pythonCode, diagnostics: blockDiagnostics } =
      await translateSingleBlockViaAst(block, options);
    if (pythonCode) snippets.push(pythonCode);
    diagnostics.push(
      ...blockDiagnostics.map((d) => `[${block.id}] ${d}`)
    );
  }
  return { pythonCode: snippets.join("\n\n"), diagnostics };
}

async function translateSingleBlockViaAst(
  block: Block,
  options: TranslateOptions
): Promise<AstTranslationResult> {
  const numberedSource = block.text
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");

  const userContent =
    "Convert the following numbered instructions into the JSON AST described above. " +
    "Cite each node's origin with its line number. Output only the JSON object.\n\n" +
    numberedSource;

  const rawText = await callLlm(
    AST_SYSTEM_PROMPT,
    userContent,
    options,
    options.reasoningEffort ?? "low"
  );

  let parsed: any;
  try {
    parsed = parseJsonObject(rawText);
  } catch (err: any) {
    const diagnostics = options.includeDiagnostics
      ? [`Could not parse model output as JSON: ${err.message ?? String(err)}`]
      : [];
    return { pythonCode: "", diagnostics };
  }

  const { statements, diagnostics } = verifyProgram(parsed, block.text, {
    strictOutputFidelity: options.strictOutputFidelity,
    collectDiagnostics: options.includeDiagnostics,
  });

  // When configured to fall back, hand any block containing constructs the AST
  // cannot represent to the direct (best-effort) translation mode instead of
  // emitting `# unsupported:` comments.
  if (options.unsupportedBehavior === "fallback" && statementsContainUnknown(statements)) {
    const pythonCode = await translateSingleBlock(block, options);
    const fallbackNote =
      "Block contained unsupported construct(s); fell back to direct best-effort translation.";
    return {
      pythonCode,
      diagnostics: options.includeDiagnostics
        ? [...diagnostics, fallbackNote]
        : diagnostics,
    };
  }

  return { pythonCode: generatePython(statements), diagnostics };
}

/**
 * Extracts a JSON object from a model response that may be wrapped in markdown
 * fences or surrounded by stray text.
 */
function parseJsonObject(text: string): any {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON object found in response");
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}
