/**
 * Evidence-based grounding of a verified AST against its source block.
 *
 * Principle: the model supplies evidence and the code checks it. This verifies
 * that what the AST says is *traceable to the text* (cited lines, literals,
 * names, output cues). It cannot verify that the interpretation is semantically
 * right: a faithful-looking AST can still misread the instructions.
 *
 * Codes (all `GROUNDING_*`):
 *   EVIDENCE      evidence is not a substring of the cited line      [strict]
 *   OUTPUT_CUE    print without a valid output cue on its line        [strict]
 *   LITERAL       a number/string literal does not appear on the line [strict]
 *   IDENTIFIER    a name token appears nowhere in the block           [warning]
 *   LINE_UNCITED  a source line no statement cites                    [warning]
 *   LINE_MULTI    a line cited by too many statements in one scope    [warning]
 *   NESTING       a child statement's line is outside its parent span [warning]
 *   V1_INPUT      statements without evidence (AST v1); checks skipped [info]
 *
 * In "strict" mode a statement failing EVIDENCE / OUTPUT_CUE / LITERAL is
 * replaced by an `unknown` node (rendered as `# unsupported:`); a compound
 * statement takes its nested steps with it.
 */

import type { Expr, Stmt, VerifyDiagnostic } from "./ast.js";
import { numberWordValues } from "./numberWords.js";

export type GroundingMode = "off" | "warn" | "strict";

export type GroundingOptions = {
  mode: Exclude<GroundingMode, "off">;
  /** Max statements per source line within one scope (default 2). */
  maxStatementsPerLine?: number;
};

export type GroundingResult = {
  statements: Stmt[];
  diagnostics: VerifyDiagnostic[];
};

export function normalizeText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}

const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "are", "it",
  "this", "that", "then", "if", "for", "with", "as", "at", "by", "be",
  // Finnish
  "ja", "on", "se", "ei", "että", "tai", "ole", "oli", "kun", "jos", "niin",
  "tämä", "ne", "nämä",
]);

/** Functions that need no support in the text. */
const BUILTIN_FUNCS = new Set([
  "len", "sum", "max", "min", "int", "float", "str", "input", "print", "range",
  "abs", "round", "sorted", "list", "bool",
]);

/** Phrases that justify a constant the instruction does not spell out. */
const IMPLIED_CONSTANTS: Array<{ values: number[]; re: RegExp }> = [
  { values: [1], re: /\b(increment|decrement|once|next|previous|increase|decrease)\b|kerran|kasvata|pienennä|seuraava|edellinen/u },
  { values: [0], re: /\b(first|start|count)\b|ensimmäi|alku|laske/u },
  { values: [1], re: /\b(count)\b|laske/u },
  { values: [-1], re: /\b(last|final)\b|viimei/u },
  { values: [2], re: /\b(twice|double|half)\b|kahdesti|kaksinkertais|puolikas|puolet/u },
  { values: [0.5], re: /\bhalf\b|puolikas|puolet/u },
  { values: [0, 1, 2], re: /\b(even|odd)\b|parillinen|pariton|parilliset|parittomat/u },
];

function numericTokens(lineNorm: string): Set<number> {
  const out = new Set<number>();
  for (const m of lineNorm.matchAll(/\d+(?:[.,]\d+)?/gu)) {
    const n = Number(m[0].replace(",", "."));
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

function lineNumbers(lineNorm: string): Set<number> {
  const set = numericTokens(lineNorm);
  for (const v of numberWordValues(lineNorm)) set.add(v);
  for (const { values, re } of IMPLIED_CONSTANTS) {
    if (re.test(lineNorm)) values.forEach((v) => set.add(v));
  }
  return set;
}

// --- AST traversal helpers ----------------------------------------------------

type Fail = { code: string; message: string; strict: boolean };

export function walkExpr(expr: Expr, visit: (e: Expr) => void): void {
  visit(expr);
  switch (expr.kind) {
    case "binop":
    case "compare":
    case "contains":
      walkExpr(expr.left, visit);
      walkExpr(expr.right, visit);
      break;
    case "boolop":
      expr.values.forEach((v) => walkExpr(v, visit));
      break;
    case "not":
    case "cast":
      walkExpr(expr.value, visit);
      break;
    case "index":
      walkExpr(expr.target, visit);
      walkExpr(expr.index, visit);
      break;
    case "input":
      if (expr.prompt) walkExpr(expr.prompt, visit);
      break;
    case "list":
      expr.items.forEach((v) => walkExpr(v, visit));
      break;
    case "call":
      expr.args.forEach((v) => walkExpr(v, visit));
      break;
    case "methodcall":
      walkExpr(expr.target, visit);
      expr.args.forEach((v) => walkExpr(v, visit));
      break;
    case "fstring":
      expr.parts.forEach((p) => p.kind === "expr" && walkExpr(p.value, visit));
      break;
    default:
      break;
  }
}

/** Expressions that belong to the statement's own line (not its nested bodies). */
function ownExprs(stmt: Stmt): Expr[] {
  switch (stmt.kind) {
    case "assign":
      return [stmt.value, ...(stmt.targetExpr ? [stmt.targetExpr] : [])];
    case "augassign":
    case "unpackassign":
    case "print":
    case "append":
      return [stmt.value];
    case "if":
    case "while":
      return [stmt.test];
    case "repeat":
      return [stmt.count];
    case "for":
      return [stmt.start, stmt.stop, ...(stmt.step ? [stmt.step] : [])];
    case "forin":
      return [stmt.iterable];
    case "return":
      return stmt.values;
    case "assert":
      return [stmt.test, ...(stmt.message ? [stmt.message] : [])];
    case "raise":
      return stmt.message ? [stmt.message] : [];
    case "exprstmt":
      return [stmt.expr];
    default:
      return [];
  }
}

function ownNames(stmt: Stmt): string[] {
  const names: string[] = [];
  switch (stmt.kind) {
    case "assign":
      if (stmt.target) names.push(stmt.target);
      break;
    case "augassign":
    case "append":
      names.push(stmt.target);
      break;
    case "unpackassign":
      names.push(...stmt.targets);
      break;
    case "for":
    case "forin":
      names.push(stmt.loopVar);
      break;
    case "functiondef":
      names.push(stmt.name, ...stmt.params);
      break;
    default:
      break;
  }
  const exprs = [...ownExprs(stmt)];
  if (stmt.kind === "if") stmt.elifs?.forEach((c) => exprs.push(c.test));
  for (const e of exprs) {
    walkExpr(e, (x) => {
      if (x.kind === "var") names.push(x.name);
      if (x.kind === "call" && !BUILTIN_FUNCS.has(x.func)) names.push(x.func);
    });
  }
  return names;
}

function nameTokens(name: string): string[] {
  return name
    .normalize("NFC")
    .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, "$1_$2")
    .split(/[_\s-]+/u)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

const lineOf = (s: Stmt): number => (s as { line?: number }).line ?? 0;

function childLists(stmt: Stmt): Stmt[][] {
  switch (stmt.kind) {
    case "if":
      return [stmt.body, ...(stmt.elifs ?? []).map((c) => c.body), stmt.orelse];
    case "while":
    case "repeat":
    case "for":
    case "forin":
    case "functiondef":
      return [stmt.body];
    case "try":
      return [stmt.body, ...stmt.handlers.map((h) => h.body)];
    default:
      return [];
  }
}

function mapChildren(stmt: Stmt, fn: (list: Stmt[]) => Stmt[]): Stmt {
  switch (stmt.kind) {
    case "if":
      return {
        ...stmt,
        body: fn(stmt.body),
        elifs: stmt.elifs?.map((c) => ({ ...c, body: fn(c.body) })),
        orelse: fn(stmt.orelse),
      };
    case "while":
    case "repeat":
    case "for":
    case "forin":
    case "functiondef":
      return { ...stmt, body: fn(stmt.body) };
    case "try":
      return {
        ...stmt,
        body: fn(stmt.body),
        handlers: stmt.handlers.map((h) => ({ ...h, body: fn(h.body) })),
      };
    default:
      return stmt;
  }
}

const OPENER_LINE =
  /^(else\b|otherwise\b|muuten\b|elif\b|else if\b|except\b|finally\b|try\b|yritä\b|#)/iu;

// --- the checks -----------------------------------------------------------------

export function checkGrounding(
  statements: Stmt[],
  blockText: string,
  options: GroundingOptions
): GroundingResult {
  const diagnostics: VerifyDiagnostic[] = [];
  const strict = options.mode === "strict";
  const maxPerLine = options.maxStatementsPerLine ?? 2;
  const blockNorm = normalizeText(blockText);
  const sourceLines = blockText.split(/\r?\n/);

  const emit = (d: Omit<VerifyDiagnostic, "severity"> & { severity?: VerifyDiagnostic["severity"] }) =>
    diagnostics.push({ severity: "warning", ...d });

  const cited = new Set<number>();
  let missingEvidence = 0;

  const checkStatement = (stmt: Stmt): Fail[] => {
    const fails: Fail[] = [];
    if (stmt.kind === "unknown") return fails;
    const lineNorm = normalizeText((stmt as { source?: string }).source ?? "");

    // 1. evidence
    const hasEvidence = typeof stmt.evidence === "string";
    if (!hasEvidence) {
      missingEvidence++;
    } else {
      const ev = normalizeText(stmt.evidence!);
      if (!ev || !lineNorm.includes(ev)) {
        fails.push({
          code: "GROUNDING_EVIDENCE",
          message: `Line ${lineOf(stmt)}: evidence ${JSON.stringify(stmt.evidence)} is not on the cited line.`,
          strict: true,
        });
      }
    }

    // 2. output cue
    if (stmt.kind === "print" && typeof stmt.outputCue === "string") {
      const cue = normalizeText(stmt.outputCue).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!cue || STOP_WORDS.has(cue) || !lineNorm.includes(cue)) {
        fails.push({
          code: "GROUNDING_OUTPUT_CUE",
          message: `Line ${lineOf(stmt)}: print has no valid output cue (got ${JSON.stringify(stmt.outputCue)}).`,
          strict: true,
        });
      }
    }

    // 3. literals (the statement's own expressions; elif tests live on other lines)
    const numbers = lineNumbers(lineNorm);
    const bad: string[] = [];
    const checkLiteral = (e: Expr, against: string, nums: Set<number>) => {
      walkExpr(e, (x) => {
        if (x.kind === "num") {
          const rawOk = x.raw !== undefined && against.includes(normalizeText(x.raw));
          if (!rawOk && !nums.has(Math.abs(x.value)) && !nums.has(x.value)) {
            bad.push(String(x.raw ?? x.value));
          }
        } else if (x.kind === "str") {
          const v = normalizeText(x.value);
          if (v && !against.includes(v)) bad.push(JSON.stringify(x.value));
        } else if (x.kind === "fstring") {
          for (const p of x.parts) {
            const v = p.kind === "lit" ? normalizeText(p.value) : "";
            if (v && !against.includes(v)) bad.push(JSON.stringify(p.value));
          }
        }
      });
    };
    ownExprs(stmt).forEach((e) => checkLiteral(e, lineNorm, numbers));
    if (stmt.kind === "if") {
      const blockNumbers = lineNumbers(blockNorm);
      stmt.elifs?.forEach((c) => checkLiteral(c.test, blockNorm, blockNumbers));
    }
    if (bad.length > 0) {
      fails.push({
        code: "GROUNDING_LITERAL",
        message: `Line ${lineOf(stmt)}: literal(s) ${[...new Set(bad)].join(", ")} not found on the cited line.`,
        strict: true,
      });
    }

    // 4. identifiers (anywhere in the block, to allow pronouns / back-references)
    const missing = new Set<string>();
    for (const name of ownNames(stmt)) {
      for (const token of nameTokens(name)) {
        if (!blockNorm.includes(token)) missing.add(token);
      }
    }
    if (missing.size > 0) {
      fails.push({
        code: "GROUNDING_IDENTIFIER",
        message: `Line ${lineOf(stmt)}: name part(s) ${[...missing].map((t) => JSON.stringify(t)).join(", ")} do not appear in the instructions.`,
        strict: false,
      });
    }
    return fails;
  };

  const ground = (list: Stmt[]): Stmt[] => {
    // 6. same line cited too often within one scope
    const perLine = new Map<number, number>();
    for (const s of list) perLine.set(lineOf(s), (perLine.get(lineOf(s)) ?? 0) + 1);
    for (const [line, count] of perLine) {
      if (count > maxPerLine) {
        emit({
          code: "GROUNDING_LINE_MULTI",
          line,
          message: `Line ${line} is cited by ${count} statements in the same scope (more than ${maxPerLine}).`,
        });
      }
    }

    return list.map((stmt, i) => {
      cited.add(lineOf(stmt));
      const next = list[i + 1];

      // 7. nesting: children must lie between this line and the next sibling's line
      for (const child of childLists(stmt).flat()) {
        const cl = lineOf(child);
        if (cl < lineOf(stmt) || (next && cl > lineOf(next))) {
          emit({
            code: "GROUNDING_NESTING",
            line: cl,
            message: `Line ${cl}: nested step is outside its parent's span (parent at line ${lineOf(stmt)}${next ? `, next step at line ${lineOf(next)}` : ""}).`,
          });
        }
      }

      // children first, so their diagnostics are reported even if the parent is replaced
      const withChildren = mapChildren(stmt, (child) =>
        ground(child)
      );

      const fails = checkStatement(stmt);
      for (const f of fails) {
        emit({ code: f.code, line: lineOf(stmt), message: f.message });
      }
      const strictFail = fails.find((f) => f.strict);
      if (strict && strictFail) {
        const replaced = {
          kind: "unknown",
          source: (stmt as { source?: string }).source ?? "",
          line: lineOf(stmt),
          note: strictFail.code,
        } as unknown as Stmt;
        return replaced;
      }
      return withChildren;
    });
  };

  const result = ground(statements);

  // 5. source lines nobody cites
  sourceLines.forEach((text, idx) => {
    const lineNo = idx + 1;
    if (!text.trim() || cited.has(lineNo) || OPENER_LINE.test(text.trim())) return;
    emit({
      code: "GROUNDING_LINE_UNCITED",
      line: lineNo,
      message: `Line ${lineNo} is not represented by any step: ${JSON.stringify(text.trim())}.`,
    });
  });

  if (missingEvidence > 0) {
    diagnostics.unshift({
      severity: "info",
      code: "GROUNDING_V1_INPUT",
      message: `${missingEvidence} step(s) carry no evidence (AST v1 style); evidence-based checks were skipped for them.`,
    });
  }

  return { statements: result, diagnostics };
}
