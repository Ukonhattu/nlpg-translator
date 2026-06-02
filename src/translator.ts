import fetch from "node-fetch";
import type { Block, TranslateOptions } from "./index.js";
import { verifyProgram } from "./ast.js";
import { generatePython } from "./codegen.js";

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
    "show, display, or output something. Do not add prints to show results, to debug, or to be helpful.\n" +
    "- Do not add example usage, test code, default values, or extra output.\n" +
    "- Produce code for each given step only; do not introduce steps that are not there.\n" +
    "- Output only raw Python code: no comments, no explanations, no markdown code fences.";

  const userContent =
    "Translate the following block into Python. " +
    "Preserve the logical structure and order of steps, using simple code suitable for beginners. " +
    "Add nothing that is not explicitly stated in the instructions.\n\n" +
    block.text;

  const rawText = await callAaltoResponses(systemPrompt, userContent, options);
  return enforceFidelity(rawText, block.text);
}

async function callAaltoResponses(
  systemPrompt: string,
  userContent: string,
  options: TranslateOptions
): Promise<string> {
  const {
    aaltoApiKey,
    aaltoEndpoint = "https://aalto-openai-apigw.azure-api.net/v1/openai/responses",
    aaltoModel = "gpt-5-2025-08-07",
  } = options;

  const body = {
    model: aaltoModel,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  const res = await fetch(aaltoEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": aaltoApiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aalto AI request failed (${res.status}): ${text}`);
  }

  const data: any = await res.json();
  return extractResponseText(data);
}

function extractResponseText(data: any): string {
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
 * Deterministically removes content the model may have added that is not
 * present in the source instructions. The prompt asks the model not to add
 * anything, but this is a hard guarantee on top of that:
 *  - strips markdown code fences (non-code lines)
 *  - removes print() statements beyond the number explicitly requested in the
 *    natural language source, keeping the resulting Python valid.
 */
export function enforceFidelity(modelText: string, sourceText: string): string {
  const withoutFences = stripCodeFences(modelText);
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

/**
 * Counts how many output statements the source explicitly requests. Only an
 * explicit print/show/display/output verb counts; anything else is treated as
 * "not requested" so the model cannot smuggle in extra prints.
 */
function countRequestedPrints(sourceText: string): number {
  return sourceText
    .split(/\r?\n/)
    .filter((line) => /\b(print|display|show|output)\b/i.test(line)).length;
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
  warnings: string[];
};

const AST_SYSTEM_PROMPT = `You are a parser. Convert beginner-friendly natural language programming instructions into a JSON Abstract Syntax Tree (AST). You DO NOT write Python and you DO NOT execute logic.

Output ONLY a single JSON object, no prose, no markdown fences. Shape:
{ "statements": Stmt[] }

Statement nodes (each MUST include "source": the exact snippet of the input it came from):
- { "kind": "assign", "target": string, "value": Expr, "source": string }            // "Let the score be 0"
- { "kind": "augassign", "target": string, "op": "+"|"-"|"*"|"/", "value": Expr, "source": string } // "Add 10 to the score"
- { "kind": "print", "value": Expr, "source": string }                                  // only when output is explicitly requested
- { "kind": "if", "test": Expr, "body": Stmt[], "orelse": Stmt[], "source": string }
- { "kind": "while", "test": Expr, "body": Stmt[], "source": string }
- { "kind": "repeat", "count": Expr, "body": Stmt[], "source": string }                 // "Repeat 3 times" (no loop variable)
- { "kind": "for", "loopVar": string, "start": Expr, "stop": Expr, "step"?: Expr, "body": Stmt[], "source": string } // "For each i from 1 to 5"; renders as range(start, stop[, step]); stop is EXCLUSIVE
- { "kind": "unknown", "source": string, "note"?: string }                              // construct you cannot represent

Expression nodes:
- { "kind": "num", "value": number }
- { "kind": "str", "value": string }
- { "kind": "bool", "value": boolean }
- { "kind": "var", "name": string }
- { "kind": "binop", "op": "+"|"-"|"*"|"/"|"%", "left": Expr, "right": Expr }
- { "kind": "compare", "op": ">"|"<"|">="|"<="|"=="|"!=", "left": Expr, "right": Expr }
- { "kind": "boolop", "op": "and"|"or", "values": Expr[] }
- { "kind": "not", "value": Expr }
- { "kind": "input", "prompt"?: Expr, "cast"?: "int"|"float" }

STRICT TRANSCRIPTION RULES:
- Represent ONLY what the text literally says. Never add, infer, complete, or "fix" anything.
- Do NOT add print/output unless the text explicitly asks to print/show/display/output.
- Do NOT invent default values, helper steps, example usage, or extra output.
- If the instructions are vague, incomplete, or wrong, faithfully produce a vague/incomplete/wrong AST. Do not repair it.
- If you cannot represent a construct, emit an "unknown" node instead of guessing.
- Every node's "source" must be copied verbatim from the input.`;

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
  const warnings: string[] = [];
  for (const block of blocks) {
    const { pythonCode, warnings: blockWarnings } =
      await translateSingleBlockViaAst(block, options);
    if (pythonCode) snippets.push(pythonCode);
    warnings.push(...blockWarnings.map((w) => `[${block.id}] ${w}`));
  }
  return { pythonCode: snippets.join("\n\n"), warnings };
}

async function translateSingleBlockViaAst(
  block: Block,
  options: TranslateOptions
): Promise<AstTranslationResult> {
  const userContent =
    "Convert the following instructions into the JSON AST described above. " +
    "Output only the JSON object.\n\n" +
    block.text;

  const rawText = await callAaltoResponses(
    AST_SYSTEM_PROMPT,
    userContent,
    options
  );

  let parsed: any;
  try {
    parsed = parseJsonObject(rawText);
  } catch (err: any) {
    return {
      pythonCode: "",
      warnings: [
        `Could not parse model output as JSON: ${err.message ?? String(err)}`,
      ],
    };
  }

  const { statements, warnings } = verifyProgram(parsed, block.text);
  return { pythonCode: generatePython(statements), warnings };
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
