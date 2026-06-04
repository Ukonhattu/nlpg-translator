import { lineRequestsOutput } from "./outputVerbs.js";

/**
 * Intermediate representation (AST) for the natural-language -> Python pipeline.
 * Covers constructs from the Aalto Intro to Programming Python quick reference.
 */

export type FStringPart =
  | { kind: "lit"; value: string }
  | { kind: "expr"; value: Expr };

export type Expr =
  | { kind: "num"; value: number }
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

export type Stmt =
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
  | { kind: "print"; value: Expr; source: string }
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
  "unknown",
]);

const COMPARE_OPS = new Set([">", "<", ">=", "<=", "==", "!="]);
const BINOPS = new Set(["+", "-", "*", "/", "%"]);
const AUG_OPS = new Set(["+", "-", "*", "/"]);
const CAST_TYPES = new Set(["int", "float", "str"]);

export type VerifyOptions = {
  /** When true, drop print nodes not grounded in output verbs on the cited line. */
  strictOutputFidelity?: boolean;
  /** When true, record messages in diagnostics (default false). */
  collectDiagnostics?: boolean;
};

export type VerifyResult = {
  statements: Stmt[];
  diagnostics: string[];
};

function isFstringPart(part: any): part is FStringPart {
  if (!part || typeof part !== "object") return false;
  if (part.kind === "lit") return typeof part.value === "string";
  if (part.kind === "expr") return isExpr(part.value);
  return false;
}

function isExpr(node: any): node is Expr {
  if (!node || typeof node !== "object" || !EXPR_KINDS.has(node.kind)) {
    return false;
  }
  switch (node.kind) {
    case "num":
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
        typeof node.func === "string" &&
        node.func.trim().length > 0 &&
        Array.isArray(node.args) &&
        node.args.every(isExpr)
      );
    case "methodcall":
      return (
        typeof node.method === "string" &&
        node.method.trim().length > 0 &&
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

function isAssignTargetValid(node: any): boolean {
  const hasName =
    typeof node.target === "string" && node.target.trim().length > 0;
  const hasExpr = node.targetExpr !== undefined && isExpr(node.targetExpr);
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
    (handler.exc === undefined || typeof handler.exc === "string") &&
    Array.isArray(handler.body)
  );
}

function validateStmtShape(node: any): boolean {
  if (!node || typeof node !== "object" || !STMT_KINDS.has(node.kind)) {
    return false;
  }
  if (!Number.isInteger(node.line) || node.line < 1) return false;

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
        node.params.every(
          (p: unknown) => typeof p === "string" && (p as string).trim().length > 0
        ) &&
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
        typeof node.excType === "string" &&
        node.excType.trim().length > 0 &&
        (node.message === undefined || isExpr(node.message))
      );
    case "try":
      return (
        Array.isArray(node.body) &&
        Array.isArray(node.handlers) &&
        node.handlers.length >= 1 &&
        node.handlers.every(isExceptHandler)
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
  options: VerifyOptions
): void {
  switch (node.kind) {
    case "if":
      node.body = verifyStatements(
        node.body,
        sourceLines,
        diagnostics,
        `${where}.body`,
        options
      );
      if (Array.isArray(node.elifs)) {
        node.elifs.forEach((clause: ElifClause, i: number) => {
          clause.body = verifyStatements(
            clause.body,
            sourceLines,
            diagnostics,
            `${where}.elifs[${i}].body`,
            options
          );
        });
      }
      node.orelse = verifyStatements(
        node.orelse,
        sourceLines,
        diagnostics,
        `${where}.orelse`,
        options
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
        options
      );
      break;
    case "functiondef":
      node.body = verifyStatements(
        node.body,
        sourceLines,
        diagnostics,
        `${where}.body`,
        options
      );
      break;
    case "try":
      node.body = verifyStatements(
        node.body,
        sourceLines,
        diagnostics,
        `${where}.body`,
        options
      );
      node.handlers.forEach((handler: ExceptHandler, i: number) => {
        handler.body = verifyStatements(
          handler.body,
          sourceLines,
          diagnostics,
          `${where}.handlers[${i}].body`,
          options
        );
      });
      break;
  }
}

export function verifyStatements(
  nodes: any[],
  sourceLines: string[],
  diagnostics: string[],
  path = "program",
  options: VerifyOptions = {}
): Stmt[] {
  const result: Stmt[] = [];
  const note = (message: string) => {
    if (options.collectDiagnostics) diagnostics.push(message);
  };

  nodes.forEach((node, index) => {
    const where = `${path}[${index}]`;

    if (!validateStmtShape(node)) {
      note(`Skipped invalid step at ${where} (kind: ${node?.kind ?? "unknown"}).`);
      return;
    }

    if (node.line > sourceLines.length) {
      note(
        `Skipped '${node.kind}' at ${where}: line ${node.line} is outside the input (${sourceLines.length} lines).`
      );
      return;
    }
    node.source = sourceLines[node.line - 1];

    if (node.kind === "pass" && node.source.trim().toLowerCase() !== "pass") {
      note(
        `Skipped 'pass' at ${where}: line ${node.line} is not a pass placeholder (got: ${JSON.stringify(node.source.trim())}).`
      );
      return;
    }

    if (node.kind === "print" && !lineRequestsOutput(node.source)) {
      if (options.strictOutputFidelity) {
        note(
          `Line ${node.line}: omitted print (source line does not request output).`
        );
        return;
      }
      note(
        `Line ${node.line}: print may not match source (no output verb on that line).`
      );
    }

    verifyStmtBodies(node, sourceLines, diagnostics, where, options);
    result.push(node as Stmt);
  });

  return result;
}

export function verifyProgram(
  raw: any,
  sourceText: string,
  options: VerifyOptions = {}
): VerifyResult {
  const diagnostics: string[] = [];
  const note = (message: string) => {
    if (options.collectDiagnostics) diagnostics.push(message);
  };
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.statements)) {
    note("Model did not return a valid program object.");
    return { statements: [], diagnostics };
  }
  const sourceLines = sourceText.split(/\r?\n/);
  const statements = verifyStatements(
    raw.statements,
    sourceLines,
    diagnostics,
    "program",
    options
  );
  return { statements, diagnostics };
}
