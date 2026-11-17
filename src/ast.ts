import {
  promoteOrphanPassIntoLoopBodies,
  tryRecoverUnknownFromSource,
} from "./astRecovery.js";
import { isValidNormalizedIdentifier } from "./identifiers.js";
import { lineRequestsOutput } from "./outputVerbs.js";

/**
 * Intermediate representation (AST) for the natural-language -> Python pipeline.
 * Covers constructs from the Aalto Intro to Programming Python quick reference.
 */

export type FStringPart =
  | { kind: "lit"; value: string }
  | { kind: "expr"; value: Expr };

export type Expr =
  | { kind: "num"; value: number; raw?: string }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "var"; name: string }
  | { kind: "binop"; op: "+" | "-" | "*" | "/" | "%"; left: Expr; right: Expr }
  | {
      kind: "compare";
      op: ">" | "<" | ">=" | "<=" | "==" | "!=";
      left: Expr;
      right: Expr;
    }
  | { kind: "boolop"; op: "and" | "or"; values: Expr[] }
  | { kind: "not"; value: Expr }
  | { kind: "index"; target: Expr; index: Expr }
  | { kind: "input"; prompt?: Expr; cast?: "int" | "float" }
  | { kind: "cast"; type: "int" | "float" | "str"; value: Expr }
  | { kind: "list"; items: Expr[] }
  | { kind: "call"; func: string; args: Expr[] }
  | { kind: "methodcall"; target: Expr; method: string; args: Expr[] }
  | { kind: "fstring"; parts: FStringPart[] }
  | { kind: "contains"; left: Expr; right: Expr };

export type ElifClause = { test: Expr; body: Stmt[] };

export type ExceptHandler = { exc?: string; body: Stmt[] };

/** Version of the AST schema the model is asked to produce (v2 adds evidence/outputCue). */
export const AST_SCHEMA_VERSION = 2;

/**
 * Statement nodes. Every statement may carry `evidence`: a verbatim substring of
 * the cited source line that expresses the step (schema v2). Used only for
 * grounding checks; it never affects generated code.
 */
export type Stmt = StmtNode & { evidence?: string };

type StmtNode =
  | {
      kind: "assign";
      target?: string;
      targetExpr?: Expr;
      value: Expr;
      source: string;
    }
  | {
      kind: "augassign";
      target: string;
      op: "+" | "-" | "*" | "/";
      value: Expr;
      source: string;
    }
  | { kind: "unpackassign"; targets: string[]; value: Expr; source: string }
  | { kind: "print"; value: Expr; source: string; outputCue?: string }
  | {
      kind: "if";
      test: Expr;
      body: Stmt[];
      elifs?: ElifClause[];
      orelse: Stmt[];
      source: string;
    }
  | { kind: "while"; test: Expr; body: Stmt[]; source: string }
  | { kind: "repeat"; count: Expr; body: Stmt[]; source: string }
  | {
      kind: "for";
      loopVar: string;
      start: Expr;
      stop: Expr;
      step?: Expr;
      body: Stmt[];
      source: string;
    }
  | {
      kind: "forin";
      loopVar: string;
      iterable: Expr;
      body: Stmt[];
      source: string;
    }
  | { kind: "break"; source: string }
  | { kind: "pass"; source: string }
  | { kind: "append"; target: string; value: Expr; source: string }
  | {
      kind: "functiondef";
      name: string;
      params: string[];
      body: Stmt[];
      docstring?: string;
      source: string;
    }
  | { kind: "return"; values: Expr[]; source: string }
  | { kind: "assert"; test: Expr; message?: Expr; source: string }
  | { kind: "raise"; excType: string; message?: Expr; source: string }
  | {
      kind: "try";
      body: Stmt[];
      handlers: ExceptHandler[];
      source: string;
    }
  | { kind: "exprstmt"; expr: Expr; source: string }
  | { kind: "unknown"; source: string; note?: string };

export type Program = { statements: Stmt[] };

const EXPR_KINDS = new Set([
  "num",
  "str",
  "bool",
  "var",
  "binop",
  "compare",
  "boolop",
  "not",
  "index",
  "input",
  "cast",
  "list",
  "call",
  "methodcall",
  "fstring",
  "contains",
]);

const STMT_KINDS = new Set([
  "assign",
  "augassign",
  "unpackassign",
  "print",
  "if",
  "while",
  "repeat",
  "for",
  "forin",
  "break",
  "pass",
  "append",
  "functiondef",
  "return",
  "assert",
  "raise",
  "try",
  "exprstmt",
  "unknown",
]);

const COMPARE_OPS = new Set([">", "<", ">=", "<=", "==", "!="]);
const BINOPS = new Set(["+", "-", "*", "/", "%"]);
const AUG_OPS = new Set(["+", "-", "*", "/"]);
const CAST_TYPES = new Set(["int", "float", "str"]);

export type VerifyDiagnostic = {
  line?: number;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
};

export type VerifyOptions = {
  /** When true, drop print nodes not grounded in output verbs on the cited line. */
  strictOutputFidelity?: boolean;
  /**
   * @deprecated Diagnostics are always collected; the translator decides whether
   * to return them (`includeDiagnostics`). Kept so existing callers compile.
   */
  collectDiagnostics?: boolean;
  /** Internal: receives structured diagnostics alongside the string list. */
  detailed?: VerifyDiagnostic[];
  /** Internal: counts nodes dropped during verification. */
  stats?: { dropped: number };
};

export type VerifyResult = {
  statements: Stmt[];
  /** Human-readable messages (always collected). */
  diagnostics: string[];
  diagnosticsDetailed: VerifyDiagnostic[];
  /** Number of nodes dropped as invalid / ungrounded / too deep. */
  droppedNodes: number;
};

/** Maximum statement nesting depth; deeper subtrees are dropped. */
export const MAX_AST_DEPTH = 32;
/** Maximum expression nesting depth. */
const MAX_EXPR_DEPTH = 64;

function report(
  diagnostics: string[],
  options: VerifyOptions,
  d: Omit<VerifyDiagnostic, "severity"> & { severity?: VerifyDiagnostic["severity"] },
  dropped = false
): void {
  diagnostics.push(d.message);
  options.detailed?.push({ severity: "warning", ...d });
  if (dropped && options.stats) options.stats.dropped++;
}

function isFstringPart(part: any): part is FStringPart {
  if (!part || typeof part !== "object") return false;
  if (part.kind === "lit") return typeof part.value === "string";
  if (part.kind === "expr") return isExpr(part.value);
  return false;
}

let exprDepth = 0;

function isExpr(node: any): node is Expr {
  if (!node || typeof node !== "object" || !EXPR_KINDS.has(node.kind)) {
    return false;
  }
  if (exprDepth >= MAX_EXPR_DEPTH) return false;
  exprDepth++;
  try {
    return isExprShape(node);
  } finally {
    exprDepth--;
  }
}

function isExprShape(node: any): boolean {
  switch (node.kind) {
    case "num":
      if (typeof node.raw !== "string") delete node.raw;
      return typeof node.value === "number" && Number.isFinite(node.value);
    case "str":
      return typeof node.value === "string";
    case "bool":
      return typeof node.value === "boolean";
    case "var":
      return typeof node.name === "string" && node.name.trim().length > 0;
    case "binop":
      return BINOPS.has(node.op) && isExpr(node.left) && isExpr(node.right);
    case "compare":
      return (
        COMPARE_OPS.has(node.op) && isExpr(node.left) && isExpr(node.right)
      );
    case "boolop":
      return (
        (node.op === "and" || node.op === "or") &&
        Array.isArray(node.values) &&
        node.values.length >= 2 &&
        node.values.every(isExpr)
      );
    case "not":
      return isExpr(node.value);
    case "index":
      return isExpr(node.target) && isExpr(node.index);
    case "input":
      return (
        (node.prompt === undefined || isExpr(node.prompt)) &&
        (node.cast === undefined ||
          node.cast === "int" ||
          node.cast === "float")
      );
    case "cast":
      return CAST_TYPES.has(node.type) && isExpr(node.value);
    case "list":
      return Array.isArray(node.items) && node.items.every(isExpr);
    case "call":
      return (
        isValidNormalizedIdentifier(node.func) &&
        Array.isArray(node.args) &&
        node.args.every(isExpr)
      );
    case "methodcall":
      return (
        isValidNormalizedIdentifier(node.method) &&
        isExpr(node.target) &&
        Array.isArray(node.args) &&
        node.args.every(isExpr)
      );
    case "fstring":
      return (
        Array.isArray(node.parts) &&
        node.parts.length > 0 &&
        node.parts.every(isFstringPart)
      );
    case "contains":
      return isExpr(node.left) && isExpr(node.right);
    default:
      return false;
  }
}

/** A subscript target such as `items[0]` (or a bare variable). */
function isAssignableExpr(node: any): boolean {
  if (!isExpr(node)) return false;
  if (node.kind === "var") return true;
  return node.kind === "index" && isAssignableExpr(node.target);
}

function isAssignTargetValid(node: any): boolean {
  const hasName =
    typeof node.target === "string" && node.target.trim().length > 0;
  const hasExpr =
    node.targetExpr !== undefined && isAssignableExpr(node.targetExpr);
  return hasName !== hasExpr;
}

function isElifClause(clause: any): clause is ElifClause {
  return (
    clause &&
    typeof clause === "object" &&
    isExpr(clause.test) &&
    Array.isArray(clause.body)
  );
}

function isExceptHandler(handler: any): handler is ExceptHandler {
  return (
    handler &&
    typeof handler === "object" &&
    (handler.exc === undefined ||
      handler.exc === "" ||
      isValidNormalizedIdentifier(handler.exc)) &&
    Array.isArray(handler.body)
  );
}

function validateStmtShape(node: any): boolean {
  if (!node || typeof node !== "object" || !STMT_KINDS.has(node.kind)) {
    return false;
  }
  if (!Number.isInteger(node.line) || node.line < 1) return false;
  // Optional grounding fields: ignore (drop) anything that is not a string.
  if (node.evidence !== undefined && typeof node.evidence !== "string") delete node.evidence;
  if (node.outputCue !== undefined && typeof node.outputCue !== "string") delete node.outputCue;

  switch (node.kind) {
    case "assign":
      return isAssignTargetValid(node) && isExpr(node.value);
    case "augassign":
      return (
        typeof node.target === "string" &&
        AUG_OPS.has(node.op) &&
        isExpr(node.value)
      );
    case "unpackassign":
      return (
        Array.isArray(node.targets) &&
        node.targets.length >= 1 &&
        node.targets.every(
          (t: unknown) => typeof t === "string" && (t as string).trim().length > 0
        ) &&
        isExpr(node.value)
      );
    case "print":
      return isExpr(node.value);
    case "if":
      return (
        isExpr(node.test) &&
        Array.isArray(node.body) &&
        Array.isArray(node.orelse) &&
        (node.elifs === undefined ||
          (Array.isArray(node.elifs) && node.elifs.every(isElifClause)))
      );
    case "while":
      return isExpr(node.test) && Array.isArray(node.body);
    case "repeat":
      return isExpr(node.count) && Array.isArray(node.body);
    case "for":
      return (
        typeof node.loopVar === "string" &&
        node.loopVar.trim().length > 0 &&
        isExpr(node.start) &&
        isExpr(node.stop) &&
        (node.step === undefined || isExpr(node.step)) &&
        Array.isArray(node.body)
      );
    case "forin":
      return (
        typeof node.loopVar === "string" &&
        node.loopVar.trim().length > 0 &&
        isExpr(node.iterable) &&
        Array.isArray(node.body)
      );
    case "break":
    case "pass":
      return true;
    case "append":
      return (
        typeof node.target === "string" &&
        node.target.trim().length > 0 &&
        isExpr(node.value)
      );
    case "functiondef":
      return (
        typeof node.name === "string" &&
        node.name.trim().length > 0 &&
        Array.isArray(node.params) &&
        node.params.every(isValidNormalizedIdentifier) &&
        (node.docstring === undefined || typeof node.docstring === "string") &&
        Array.isArray(node.body)
      );
    case "return":
      return Array.isArray(node.values) && node.values.every(isExpr);
    case "assert":
      return (
        isExpr(node.test) &&
        (node.message === undefined || isExpr(node.message))
      );
    case "raise":
      return (
        isValidNormalizedIdentifier(node.excType) &&
        (node.message === undefined || isExpr(node.message))
      );
    case "try":
      return (
        Array.isArray(node.body) &&
        Array.isArray(node.handlers) &&
        node.handlers.length >= 1 &&
        node.handlers.every(isExceptHandler)
      );
    case "exprstmt":
      return (
        (node.expr?.kind === "call" || node.expr?.kind === "methodcall") &&
        isExpr(node.expr)
      );
    case "unknown":
      return true;
    default:
      return false;
  }
}

/** Nested statement lists inside a node (for verification and unknown detection). */
export function childStatementLists(stmt: Stmt): Stmt[][] {
  switch (stmt.kind) {
    case "if": {
      const lists = [stmt.body, stmt.orelse];
      for (const clause of stmt.elifs ?? []) lists.push(clause.body);
      return lists;
    }
    case "while":
    case "repeat":
    case "for":
    case "forin":
      return [stmt.body];
    case "functiondef":
      return [stmt.body];
    case "try": {
      const lists = [stmt.body];
      for (const h of stmt.handlers) lists.push(h.body);
      return lists;
    }
    default:
      return [];
  }
}

export function statementsContainUnknown(statements: Stmt[]): boolean {
  for (const stmt of statements) {
    if (stmt.kind === "unknown") return true;
    for (const body of childStatementLists(stmt)) {
      if (statementsContainUnknown(body)) return true;
    }
  }
  return false;
}

function verifyStmtBodies(
  node: any,
  sourceLines: string[],
  diagnostics: string[],
  where: string,
  options: VerifyOptions,
  depth: number
): void {
  switch (node.kind) {
    case "if":
      node.body = verifyStatements(
        node.body,
        sourceLines,
        diagnostics,
        `${where}.body`,
        options,
        depth + 1
      );
      if (Array.isArray(node.elifs)) {
        node.elifs.forEach((clause: ElifClause, i: number) => {
          clause.body = verifyStatements(
            clause.body,
            sourceLines,
            diagnostics,
            `${where}.elifs[${i}].body`,
            options,
            depth + 1
          );
        });
      }
      node.orelse = verifyStatements(
        node.orelse,
        sourceLines,
        diagnostics,
        `${where}.orelse`,
        options,
        depth + 1
      );
      break;
    case "while":
    case "repeat":
    case "for":
    case "forin":
      node.body = verifyStatements(
        node.body,
        sourceLines,
        diagnostics,
        `${where}.body`,
        options,
        depth + 1
      );
      break;
    case "functiondef":
      node.body = verifyStatements(
        node.body,
        sourceLines,
        diagnostics,
        `${where}.body`,
        options,
        depth + 1
      );
      break;
    case "try":
      node.body = verifyStatements(
        node.body,
        sourceLines,
        diagnostics,
        `${where}.body`,
        options,
        depth + 1
      );
      node.handlers.forEach((handler: ExceptHandler, i: number) => {
        handler.body = verifyStatements(
          handler.body,
          sourceLines,
          diagnostics,
          `${where}.handlers[${i}].body`,
          options,
          depth + 1
        );
      });
      break;
  }
}

export function verifyStatements(
  nodes: any,
  sourceLines: string[],
  diagnostics: string[],
  path = "program",
  options: VerifyOptions = {},
  depth = 0
): Stmt[] {
  const result: Stmt[] = [];
  const say = (
    code: string,
    message: string,
    line?: number,
    severity: VerifyDiagnostic["severity"] = "warning",
    dropped = false
  ) => report(diagnostics, options, { code, message, line, severity }, dropped);

  if (!Array.isArray(nodes)) {
    say("BODY_NOT_ARRAY", `Expected a list of steps at ${path}; treated as empty.`);
    return result;
  }
  if (depth > MAX_AST_DEPTH) {
    say(
      "DEPTH_LIMIT",
      `Dropped ${nodes.length} step(s) at ${path}: nesting is deeper than ${MAX_AST_DEPTH}.`,
      undefined,
      "warning"
    );
    if (options.stats) options.stats.dropped += nodes.length;
    return result;
  }

  const recoveredHeaders = new Set<any>();

  nodes.forEach((node, index) => {
    const where = `${path}[${index}]`;

    if (!node || typeof node !== "object" || Array.isArray(node)) {
      say("INVALID_STEP", `Skipped invalid step at ${where} (not an object).`, undefined, "warning", true);
      return;
    }

    if (node.kind === "unknown") {
      const recovered = tryRecoverUnknownFromSource(
        sourceLines[(Number.isInteger(node.line) ? node.line : 1) - 1] ?? ""
      );
      if (recovered) {
        const recoveredLine = sourceLines[(Number.isInteger(node.line) ? node.line : 1) - 1] ?? "";
        node = { ...recovered, line: node.line, evidence: recoveredLine.trim() };
        if (LOOP_KINDS.has(node.kind)) recoveredHeaders.add(node);
      }
    }

    if (!validateStmtShape(node)) {
      say(
        "INVALID_STEP",
        `Skipped invalid step at ${where} (kind: ${node?.kind ?? "unknown"}).`,
        Number.isInteger(node?.line) ? node.line : undefined,
        "warning",
        true
      );
      return;
    }

    if (node.line > sourceLines.length) {
      say(
        "LINE_OUT_OF_RANGE",
        `Skipped '${node.kind}' at ${where}: line ${node.line} is outside the input (${sourceLines.length} lines).`,
        node.line,
        "warning",
        true
      );
      return;
    }
    node.source = sourceLines[node.line - 1];

    if (node.kind === "pass" && node.source.trim().toLowerCase() !== "pass") {
      say(
        "PASS_NOT_PLACEHOLDER",
        `Skipped 'pass' at ${where}: line ${node.line} is not a pass placeholder (got: ${JSON.stringify(node.source.trim())}).`,
        node.line,
        "warning",
        true
      );
      return;
    }

    // With an explicit `outputCue` the grounding step decides; the verb table is
    // only the fallback for v1 ASTs (no cue).
    const hasCue = typeof node.outputCue === "string" && node.outputCue.trim() !== "";
    if (node.kind === "print" && !hasCue && !lineRequestsOutput(node.source)) {
      if (options.strictOutputFidelity) {
        say(
          "PRINT_OMITTED",
          `Line ${node.line}: omitted print (source line does not request output).`,
          node.line,
          "warning",
          true
        );
        return;
      }
      say(
        "PRINT_UNGROUNDED",
        `Line ${node.line}: print may not match source (no output verb on that line).`,
        node.line
      );
    }

    verifyStmtBodies(node, sourceLines, diagnostics, where, options, depth);
    result.push(node as Stmt);
  });

  return reparentRecoveredLoopBodies(result, recoveredHeaders, (message, line) =>
    say("RECOVERED_LOOP_BODY", message, line, "info")
  );
}

const LOOP_KINDS = new Set(["for", "forin", "while", "repeat"]);

function indentWidth(line: string): number {
  const lead = /^[ \t]*/.exec(line)![0];
  return lead.replace(/\t/g, "    ").length;
}

/**
 * A loop header recovered from source text has an empty body. Move the
 * following sibling statements that are indented deeper than the header
 * (according to the original text) into that body.
 */
function reparentRecoveredLoopBodies(
  statements: Stmt[],
  recovered: Set<any>,
  note: (message: string, line?: number) => void
): Stmt[] {
  if (recovered.size === 0) return statements;
  const out: Stmt[] = [];
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i] as any;
    out.push(stmt);
    if (!recovered.has(stmt) || (stmt.body?.length ?? 0) > 0) continue;
    const headerIndent = indentWidth(stmt.source ?? "");
    let j = i + 1;
    while (
      j < statements.length &&
      statements[j].kind !== "unknown" &&
      indentWidth((statements[j] as any).source ?? "") > headerIndent
    ) {
      j++;
    }
    if (j > i + 1) {
      stmt.body = statements.slice(i + 1, j);
      i = j - 1;
    } else {
      note(
        `Recovered loop header at line ${stmt.line}; body could not be determined.`,
        stmt.line
      );
    }
  }
  return out;
}

export function verifyProgram(
  raw: any,
  sourceText: string,
  options: VerifyOptions = {}
): VerifyResult {
  const diagnostics: string[] = [];
  const diagnosticsDetailed: VerifyDiagnostic[] = [];
  const stats = { dropped: 0 };
  const opts: VerifyOptions = { ...options, detailed: diagnosticsDetailed, stats };
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.statements)) {
    report(diagnostics, opts, {
      code: "INVALID_PROGRAM",
      message: "Model did not return a valid program object.",
      severity: "error",
    });
    return { statements: [], diagnostics, diagnosticsDetailed, droppedNodes: 0 };
  }
  const sourceLines = sourceText.split(/\r?\n/);
  const statements = promoteOrphanPassIntoLoopBodies(
    verifyStatements(raw.statements, sourceLines, diagnostics, "program", opts)
  );
  return { statements, diagnostics, diagnosticsDetailed, droppedNodes: stats.dropped };
}
