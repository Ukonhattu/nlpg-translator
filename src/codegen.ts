/**
 * Deterministic AST -> Python code generator (Aalto intro course constructs).
 * Output targets Python 3.10 (no PEP 701 f-string nesting).
 */

import type { Expr, FStringPart, Stmt } from "./ast.js";
import {
  SHADOWABLE_BUILTINS,
  toPythonIdentifier,
  type IdentifierRole,
} from "./identifiers.js";

const INDENT = "    ";

// --- emit context (diagnostics + identifier collision tracking) ---------------

type EmitContext = {
  diagnostics: string[];
  /** emitted identifier -> distinct source names that mapped to it */
  names: Map<string, Set<string>>;
  warnedBuiltins: Set<string>;
};

let ctx: EmitContext | null = null;

function note(message: string): void {
  if (ctx && !ctx.diagnostics.includes(message)) ctx.diagnostics.push(message);
}

function ident(name: string, role: IdentifierRole, binding = false): string {
  const id = toPythonIdentifier(name, role);
  if (ctx) {
    const source = name.trim().replace(/\s+/g, " ");
    let seen = ctx.names.get(id);
    if (!seen) ctx.names.set(id, (seen = new Set()));
    if (!seen.has(source)) {
      seen.add(source);
      if (seen.size > 1) {
        note(
          `Names ${[...seen].map((s) => JSON.stringify(s)).join(" and ")} both map to the Python identifier '${id}'.`
        );
      }
    }
    if (binding && SHADOWABLE_BUILTINS.has(id) && !ctx.warnedBuiltins.has(id)) {
      ctx.warnedBuiltins.add(id);
      note(`'${id}' is assigned or defined, which shadows the Python built-in of the same name.`);
    }
  }
  return id;
}

// --- literals -----------------------------------------------------------------

function pyString(value: string): string {
  return JSON.stringify(value);
}

const RAW_FLOAT = /^-?\d+\.\d+([eE][+-]?\d+)?$/;
const RAW_INT_OR_EXP = /^-?(0|[1-9]\d*)([eE][+-]?\d+)?$/;

function emitNumber(expr: Extract<Expr, { kind: "num" }>): string {
  const raw = expr.raw;
  if (
    typeof raw === "string" &&
    (RAW_FLOAT.test(raw) || RAW_INT_OR_EXP.test(raw)) &&
    Number(raw) === expr.value
  ) {
    return raw;
  }
  return String(expr.value);
}

function isNegativeNumber(expr: Expr): boolean {
  return expr.kind === "num" && emitNumber(expr).startsWith("-");
}

// --- precedence ---------------------------------------------------------------

const P_OR = 1;
const P_AND = 2;
const P_NOT = 3;
const P_CMP = 4;
const P_ADD = 6;
const P_MUL = 7;
const P_UNARY = 8;
const P_PRIMARY = 10;

type Emitted = { code: string; prec: number };

/** Signals that an expression cannot be written inside a Python 3.10 f-string. */
class FStringUnsafe extends Error {}

type ExprCtx = { inFstring: boolean };
const TOP: ExprCtx = { inFstring: false };

function wrap(e: Emitted, minPrec: number): string {
  return e.prec < minPrec ? `(${e.code})` : e.code;
}

function emitBinopOperands(
  op: string,
  left: Expr,
  right: Expr,
  c: ExprCtx
): string {
  const prec = op === "+" || op === "-" ? P_ADD : P_MUL;
  const l = emit(left, c);
  const r = emit(right, c);
  const leftCode = wrap(l, prec);
  // Right operand: equal precedence needs parentheses unless it is the very
  // same associative operator (a + (b + c), a * (b * c)).
  const sameAssoc =
    (op === "+" || op === "*") &&
    right.kind === "binop" &&
    right.op === op;
  let rightCode: string;
  if (op === "-" && isNegativeNumber(right)) {
    rightCode = `(${r.code})`;
  } else {
    rightCode = wrap(r, sameAssoc ? prec : prec + 1);
  }
  return `${leftCode} ${op} ${rightCode}`;
}

function emitString(value: string, c: ExprCtx): string {
  if (!c.inFstring) return pyString(value);
  // Inside an f"..." expression (Python < 3.12) we may not use `"`, backslashes,
  // newlines or braces. Use single quotes when that is possible.
  // eslint-disable-next-line no-control-regex
  if (/["'\\\n\r{}#]/.test(value) || /[\u0000-\u001f]/.test(value)) {
    throw new FStringUnsafe();
  }
  return `'${value}'`;
}

function emitFstring(parts: FStringPart[], c: ExprCtx): Emitted {
  if (c.inFstring) throw new FStringUnsafe();
  try {
    const body = parts
      .map((part) => {
        if (part.kind === "lit") return escapeFstringLiteral(part.value);
        return `{${emit(part.value, { inFstring: true }).code}}`;
      })
      .join("");
    return { code: `f"${body}"`, prec: P_PRIMARY };
  } catch (err) {
    if (!(err instanceof FStringUnsafe)) throw err;
  }
  note(
    "An f-string contained text that Python 3.10 cannot express inside {...}; it was written as string concatenation instead."
  );
  const pieces = parts.map((part) =>
    part.kind === "lit"
      ? pyString(part.value)
      : `str(${emit(part.value, TOP).code})`
  );
  return {
    code: pieces.length > 0 ? pieces.join(" + ") : '""',
    prec: pieces.length > 1 ? P_ADD : P_PRIMARY,
  };
}

function escapeFstringLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .replace(/\{/g, "{{")
    .replace(/\}/g, "}}");
}

function emit(expr: Expr, c: ExprCtx): Emitted {
  switch (expr.kind) {
    case "num": {
      const code = emitNumber(expr);
      return { code, prec: code.startsWith("-") ? P_UNARY : P_PRIMARY };
    }
    case "str":
      return { code: emitString(expr.value, c), prec: P_PRIMARY };
    case "bool":
      return { code: expr.value ? "True" : "False", prec: P_PRIMARY };
    case "var":
      return { code: ident(expr.name, "var"), prec: P_PRIMARY };
    case "binop":
      return {
        code: emitBinopOperands(expr.op, expr.left, expr.right, c),
        prec: expr.op === "+" || expr.op === "-" ? P_ADD : P_MUL,
      };
    case "compare":
    case "contains": {
      const op = expr.kind === "compare" ? expr.op : "in";
      // Comparisons chain in Python, so a comparison operand is always wrapped.
      const l = wrap(emit(expr.left, c), P_CMP + 1);
      const r = wrap(emit(expr.right, c), P_CMP + 1);
      return { code: `${l} ${op} ${r}`, prec: P_CMP };
    }
    case "boolop": {
      const prec = expr.op === "or" ? P_OR : P_AND;
      const code = expr.values
        .map((v) => wrap(emit(v, c), prec))
        .join(` ${expr.op} `);
      return { code, prec };
    }
    case "not":
      return {
        code: `not ${wrap(emit(expr.value, c), P_NOT)}`,
        prec: P_NOT,
      };
    case "index":
      return {
        code: `${wrap(emit(expr.target, c), P_PRIMARY)}[${emit(expr.index, c).code}]`,
        prec: P_PRIMARY,
      };
    case "input": {
      const promptCode = expr.prompt ? emit(expr.prompt, c).code : "";
      const call = `input(${promptCode})`;
      return { code: expr.cast ? `${expr.cast}(${call})` : call, prec: P_PRIMARY };
    }
    case "cast":
      return {
        code: `${expr.type}(${emit(expr.value, c).code})`,
        prec: P_PRIMARY,
      };
    case "list":
      return {
        code: `[${expr.items.map((i) => emit(i, c).code).join(", ")}]`,
        prec: P_PRIMARY,
      };
    case "call":
      return {
        code: `${ident(expr.func, "func")}(${expr.args.map((a) => emit(a, c).code).join(", ")})`,
        prec: P_PRIMARY,
      };
    case "methodcall": {
      // `5.upper()` is a syntax error, so literal numbers are always wrapped.
      const target =
        expr.target.kind === "num"
          ? `(${emit(expr.target, c).code})`
          : wrap(emit(expr.target, c), P_PRIMARY);
      return {
        code: `${target}.${toPythonIdentifier(expr.method, "attr")}(${expr.args.map((a) => emit(a, c).code).join(", ")})`,
        prec: P_PRIMARY,
      };
    }
    case "fstring":
      return emitFstring(expr.parts, c);
  }
}

export function emitExpr(expr: Expr): string {
  return emit(expr, TOP).code;
}

// --- statements ---------------------------------------------------------------

function emitAssignTarget(stmt: Extract<Stmt, { kind: "assign" }>): string {
  if (stmt.targetExpr) return emitExpr(stmt.targetExpr);
  return ident(stmt.target!, "var", true);
}

function emitBody(body: Stmt[], indent: string): string[] {
  const inner = indent + INDENT;
  const lines = body.flatMap((stmt) => emitStmt(stmt, inner));
  if (lines.length === 0) {
    return [`${inner}pass`];
  }
  return lines;
}

function emitDocstring(text: string, indent: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, `\n${indent}`);
  return `${indent}"""${escaped}"""`;
}

export function emitStmt(stmt: Stmt, indent = ""): string[] {
  switch (stmt.kind) {
    case "assign":
      return [`${indent}${emitAssignTarget(stmt)} = ${emitExpr(stmt.value)}`];
    case "unpackassign": {
      const targets = stmt.targets.map((t) => ident(t, "var", true)).join(", ");
      return [`${indent}${targets} = ${emitExpr(stmt.value)}`];
    }
    case "augassign": {
      const id = ident(stmt.target, "var");
      const rhs = emitBinopOperands(
        stmt.op,
        { kind: "var", name: stmt.target },
        stmt.value,
        TOP
      );
      return [`${indent}${id} = ${rhs}`];
    }
    case "print":
      return [`${indent}print(${emitExpr(stmt.value)})`];
    case "if": {
      const lines = [`${indent}if ${emitExpr(stmt.test)}:`];
      lines.push(...emitBody(stmt.body, indent));
      for (const clause of stmt.elifs ?? []) {
        lines.push(`${indent}elif ${emitExpr(clause.test)}:`);
        lines.push(...emitBody(clause.body, indent));
      }
      if (stmt.orelse.length > 0) {
        lines.push(`${indent}else:`);
        lines.push(...emitBody(stmt.orelse, indent));
      }
      return lines;
    }
    case "while": {
      const lines = [`${indent}while ${emitExpr(stmt.test)}:`];
      lines.push(...emitBody(stmt.body, indent));
      return lines;
    }
    case "repeat": {
      const lines = [`${indent}for _ in range(${emitExpr(stmt.count)}):`];
      lines.push(...emitBody(stmt.body, indent));
      return lines;
    }
    case "for": {
      const loopVar = ident(stmt.loopVar, "var", true);
      const args = [emitExpr(stmt.start), emitExpr(stmt.stop)];
      if (stmt.step) args.push(emitExpr(stmt.step));
      const lines = [`${indent}for ${loopVar} in range(${args.join(", ")}):`];
      lines.push(...emitBody(stmt.body, indent));
      return lines;
    }
    case "forin": {
      const loopVar = ident(stmt.loopVar, "var", true);
      const lines = [`${indent}for ${loopVar} in ${emitExpr(stmt.iterable)}:`];
      lines.push(...emitBody(stmt.body, indent));
      return lines;
    }
    case "break":
      return [`${indent}break`];
    case "pass":
      return [`${indent}pass`];
    case "append":
      return [
        `${indent}${ident(stmt.target, "var")}.append(${emitExpr(stmt.value)})`,
      ];
    case "functiondef": {
      const name = ident(stmt.name, "func", true);
      const params = stmt.params.map((p) => ident(p, "param", true)).join(", ");
      const lines = [`${indent}def ${name}(${params}):`];
      if (stmt.docstring) {
        lines.push(emitDocstring(stmt.docstring, indent + INDENT));
      }
      lines.push(...emitBody(stmt.body, indent));
      return lines;
    }
    case "return":
      if (stmt.values.length === 0) return [`${indent}return`];
      return [`${indent}return ${stmt.values.map(emitExpr).join(", ")}`];
    case "assert": {
      const msg = stmt.message ? `, ${emitExpr(stmt.message)}` : "";
      return [`${indent}assert ${emitExpr(stmt.test)}${msg}`];
    }
    case "raise": {
      const msg = stmt.message ? `(${emitExpr(stmt.message)})` : "()";
      return [`${indent}raise ${toPythonIdentifier(stmt.excType, "exception")}${msg}`];
    }
    case "try": {
      const lines = [`${indent}try:`];
      lines.push(...emitBody(stmt.body, indent));
      for (const handler of stmt.handlers) {
        const exc = handler.exc?.trim()
          ? ` ${toPythonIdentifier(handler.exc, "exception")}`
          : "";
        lines.push(`${indent}except${exc}:`);
        lines.push(...emitBody(handler.body, indent));
      }
      return lines;
    }
    case "exprstmt":
      return [`${indent}${emitExpr(stmt.expr)}`];
    case "unknown":
      return [
        `${indent}# unsupported: ${stmt.source.replace(/\s+/g, " ").trim()}`,
      ];
  }
}

/**
 * Generate Python for verified statements. Notices (shadowed builtins, name
 * collisions, f-string fallbacks) are appended to `diagnostics` when given.
 */
export function generatePython(
  statements: Stmt[],
  diagnostics: string[] = []
): string {
  const previous = ctx;
  ctx = { diagnostics, names: new Map(), warnedBuiltins: new Set() };
  try {
    return statements.flatMap((stmt) => emitStmt(stmt, "")).join("\n").trim();
  } finally {
    ctx = previous;
  }
}
