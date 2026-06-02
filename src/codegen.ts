/**
 * Deterministic AST -> Python code generator.
 *
 * This module is a pure, total function over the AST schema in ast.ts. It emits
 * exactly the statements present in the AST and nothing else; it cannot add
 * prints, fix logic, or invent steps. This is what makes the LLM->AST->Python
 * pipeline fidelity-preserving: all the "creativity" lives in parsing the
 * natural language into the AST, never in producing the code.
 */

import type { Expr, Stmt } from "./ast.js";

const INDENT = "    ";

function sanitizeIdentifier(name: string): string {
  let id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!id) id = "value";
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

function pyString(value: string): string {
  return JSON.stringify(value);
}

function needsParens(expr: Expr): boolean {
  return (
    expr.kind === "binop" ||
    expr.kind === "compare" ||
    expr.kind === "boolop" ||
    expr.kind === "not"
  );
}

function emitOperand(expr: Expr): string {
  const code = emitExpr(expr);
  return needsParens(expr) ? `(${code})` : code;
}

export function emitExpr(expr: Expr): string {
  switch (expr.kind) {
    case "num":
      return String(expr.value);
    case "str":
      return pyString(expr.value);
    case "bool":
      return expr.value ? "True" : "False";
    case "var":
      return sanitizeIdentifier(expr.name);
    case "binop":
      return `${emitOperand(expr.left)} ${expr.op} ${emitOperand(expr.right)}`;
    case "compare":
      return `${emitOperand(expr.left)} ${expr.op} ${emitOperand(expr.right)}`;
    case "boolop":
      return expr.values.map(emitOperand).join(` ${expr.op} `);
    case "not":
      return `not ${emitOperand(expr.value)}`;
    case "index":
      return `${emitOperand(expr.target)}[${emitExpr(expr.index)}]`;
    case "input": {
      const promptCode = expr.prompt ? emitExpr(expr.prompt) : "";
      const call = `input(${promptCode})`;
      return expr.cast ? `${expr.cast}(${call})` : call;
    }
  }
}

function emitBody(body: Stmt[], indent: string): string[] {
  const inner = indent + INDENT;
  const lines = body.flatMap((stmt) => emitStmt(stmt, inner));
  if (lines.length === 0) {
    return [`${inner}pass`];
  }
  return lines;
}

export function emitStmt(stmt: Stmt, indent = ""): string[] {
  switch (stmt.kind) {
    case "assign":
      return [
        `${indent}${sanitizeIdentifier(stmt.target)} = ${emitExpr(stmt.value)}`,
      ];
    case "augassign": {
      // Style rule: expand augmented assignment (`a += x`) into the explicit
      // form `a = a + x`. The value is parenthesized when needed so precedence
      // is preserved (e.g. `a = a * (2 + 3)`).
      const id = sanitizeIdentifier(stmt.target);
      return [`${indent}${id} = ${id} ${stmt.op} ${emitOperand(stmt.value)}`];
    }
    case "print":
      return [`${indent}print(${emitExpr(stmt.value)})`];
    case "if": {
      const lines = [`${indent}if ${emitExpr(stmt.test)}:`];
      lines.push(...emitBody(stmt.body, indent));
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
      const loopVar = sanitizeIdentifier(stmt.loopVar);
      const args = [emitExpr(stmt.start), emitExpr(stmt.stop)];
      if (stmt.step) args.push(emitExpr(stmt.step));
      const lines = [`${indent}for ${loopVar} in range(${args.join(", ")}):`];
      lines.push(...emitBody(stmt.body, indent));
      return lines;
    }
    case "unknown":
      // A construct in the source we could not model. Emitting it as a comment
      // keeps the output faithfully incomplete (useful teaching feedback)
      // without inventing behavior.
      return [`${indent}# unsupported: ${stmt.source.replace(/\s+/g, " ").trim()}`];
  }
}

export function generatePython(statements: Stmt[]): string {
  return statements.flatMap((stmt) => emitStmt(stmt, "")).join("\n").trim();
}
