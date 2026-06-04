/**
 * Deterministic AST -> Python code generator (Aalto intro course constructs).
 */

import type { Expr, FStringPart, Stmt } from "./ast.js";

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

function sanitizeFuncName(name: string): string {
  const id = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
    return sanitizeIdentifier(name);
  }
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
    expr.kind === "not" ||
    expr.kind === "contains" ||
    expr.kind === "cast" ||
    expr.kind === "call" ||
    expr.kind === "methodcall"
  );
}

function emitOperand(expr: Expr): string {
  const code = emitExpr(expr);
  return needsParens(expr) ? `(${code})` : code;
}

function emitFstringPart(part: FStringPart): string {
  if (part.kind === "lit") {
    return part.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\{/g, "{{").replace(/\}/g, "}}");
  }
  return `{${emitExpr(part.value)}}`;
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
    case "cast":
      return `${expr.type}(${emitOperand(expr.value)})`;
    case "list":
      return `[${expr.items.map(emitExpr).join(", ")}]`;
    case "call":
      return `${sanitizeFuncName(expr.func)}(${expr.args.map(emitExpr).join(", ")})`;
    case "methodcall": {
      const args =
        expr.args.length > 0 ? `(${expr.args.map(emitExpr).join(", ")})` : "()";
      return `${emitOperand(expr.target)}.${expr.method}${args}`;
    }
    case "fstring":
      return `f"${expr.parts.map(emitFstringPart).join("")}"`;
    case "contains":
      return `${emitOperand(expr.left)} in ${emitOperand(expr.right)}`;
  }
}

function emitAssignTarget(stmt: Extract<Stmt, { kind: "assign" }>): string {
  if (stmt.targetExpr) return emitExpr(stmt.targetExpr);
  return sanitizeIdentifier(stmt.target!);
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
      return [`${indent}${emitAssignTarget(stmt)} = ${emitExpr(stmt.value)}`];
    case "unpackassign": {
      const targets = stmt.targets.map(sanitizeIdentifier).join(", ");
      return [`${indent}${targets} = ${emitExpr(stmt.value)}`];
    }
    case "augassign": {
      const id = sanitizeIdentifier(stmt.target);
      return [`${indent}${id} = ${id} ${stmt.op} ${emitOperand(stmt.value)}`];
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
      const loopVar = sanitizeIdentifier(stmt.loopVar);
      const args = [emitExpr(stmt.start), emitExpr(stmt.stop)];
      if (stmt.step) args.push(emitExpr(stmt.step));
      const lines = [`${indent}for ${loopVar} in range(${args.join(", ")}):`];
      lines.push(...emitBody(stmt.body, indent));
      return lines;
    }
    case "forin": {
      const loopVar = sanitizeIdentifier(stmt.loopVar);
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
        `${indent}${sanitizeIdentifier(stmt.target)}.append(${emitExpr(stmt.value)})`,
      ];
    case "functiondef": {
      const params = stmt.params.map(sanitizeIdentifier).join(", ");
      const lines = [`${indent}def ${sanitizeIdentifier(stmt.name)}(${params}):`];
      if (stmt.docstring) {
        lines.push(`${indent}${INDENT}"""${stmt.docstring}"""`);
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
      return [`${indent}raise ${sanitizeFuncName(stmt.excType)}${msg}`];
    }
    case "try": {
      const lines = [`${indent}try:`];
      lines.push(...emitBody(stmt.body, indent));
      for (const handler of stmt.handlers) {
        const exc = handler.exc ? ` ${handler.exc}` : "";
        lines.push(`${indent}except${exc}:`);
        lines.push(...emitBody(handler.body, indent));
      }
      return lines;
    }
    case "unknown":
      return [
        `${indent}# unsupported: ${stmt.source.replace(/\s+/g, " ").trim()}`,
      ];
  }
}

export function generatePython(statements: Stmt[]): string {
  return statements.flatMap((stmt) => emitStmt(stmt, "")).join("\n").trim();
}
