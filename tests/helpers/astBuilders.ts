/** Terse AST constructors for tests. Every statement gets `source` and a line. */
import type { Expr, Stmt } from "../../src/ast.js";

export const num = (value: number, raw?: string): Expr =>
  raw === undefined ? { kind: "num", value } : { kind: "num", value, raw };
export const str = (value: string): Expr => ({ kind: "str", value });
export const bool = (value: boolean): Expr => ({ kind: "bool", value });
export const v = (name: string): Expr => ({ kind: "var", name });
export const bin = (op: "+" | "-" | "*" | "/" | "%", left: Expr, right: Expr): Expr => ({
  kind: "binop",
  op,
  left,
  right,
});
export const cmp = (op: ">" | "<" | ">=" | "<=" | "==" | "!=", left: Expr, right: Expr): Expr => ({
  kind: "compare",
  op,
  left,
  right,
});
export const and = (...values: Expr[]): Expr => ({ kind: "boolop", op: "and", values });
export const or = (...values: Expr[]): Expr => ({ kind: "boolop", op: "or", values });
export const not = (value: Expr): Expr => ({ kind: "not", value });
export const list = (...items: Expr[]): Expr => ({ kind: "list", items });
export const idx = (target: Expr, index: Expr): Expr => ({ kind: "index", target, index });
export const call = (func: string, ...args: Expr[]): Expr => ({ kind: "call", func, args });
export const meth = (target: Expr, method: string, ...args: Expr[]): Expr => ({
  kind: "methodcall",
  target,
  method,
  args,
});
export const input = (prompt?: Expr, cast?: "int" | "float"): Expr => ({
  kind: "input",
  ...(prompt ? { prompt } : {}),
  ...(cast ? { cast } : {}),
});
export const cast = (type: "int" | "float" | "str", value: Expr): Expr => ({ kind: "cast", type, value });
export const fstr = (...parts: Array<string | Expr>): Expr => ({
  kind: "fstring",
  parts: parts.map((p) => (typeof p === "string" ? { kind: "lit", value: p } : { kind: "expr", value: p })),
});
export const contains = (left: Expr, right: Expr): Expr => ({ kind: "contains", left, right });

let line = 0;
const src = () => ({ source: `step ${++line}`, line } as { source: string });

export const assign = (target: string, value: Expr): Stmt => ({ kind: "assign", target, value, ...src() });
export const setItem = (target: Expr, value: Expr): Stmt => ({ kind: "assign", targetExpr: target, value, ...src() });
export const aug = (target: string, op: "+" | "-" | "*" | "/", value: Expr): Stmt => ({
  kind: "augassign",
  target,
  op,
  value,
  ...src(),
});
export const print = (value: Expr): Stmt => ({ kind: "print", value, ...src() });
export const if_ = (test: Expr, body: Stmt[], orelse: Stmt[] = [], elifs?: Array<{ test: Expr; body: Stmt[] }>): Stmt => ({
  kind: "if",
  test,
  body,
  orelse,
  ...(elifs ? { elifs } : {}),
  ...src(),
});
export const while_ = (test: Expr, body: Stmt[]): Stmt => ({ kind: "while", test, body, ...src() });
export const repeat = (count: Expr, body: Stmt[]): Stmt => ({ kind: "repeat", count, body, ...src() });
export const for_ = (loopVar: string, start: Expr, stop: Expr, body: Stmt[], step?: Expr): Stmt => ({
  kind: "for",
  loopVar,
  start,
  stop,
  ...(step ? { step } : {}),
  body,
  ...src(),
});
export const forin = (loopVar: string, iterable: Expr, body: Stmt[]): Stmt => ({
  kind: "forin",
  loopVar,
  iterable,
  body,
  ...src(),
});
export const brk = (): Stmt => ({ kind: "break", ...src() });
export const pass = (): Stmt => ({ kind: "pass", ...src() });
export const append = (target: string, value: Expr): Stmt => ({ kind: "append", target, value, ...src() });
export const def = (name: string, params: string[], body: Stmt[], docstring?: string): Stmt => ({
  kind: "functiondef",
  name,
  params,
  body,
  ...(docstring ? { docstring } : {}),
  ...src(),
});
export const ret = (...values: Expr[]): Stmt => ({ kind: "return", values, ...src() });
export const assert_ = (test: Expr, message?: Expr): Stmt => ({
  kind: "assert",
  test,
  ...(message ? { message } : {}),
  ...src(),
});
export const raise = (excType: string, message?: Expr): Stmt => ({
  kind: "raise",
  excType,
  ...(message ? { message } : {}),
  ...src(),
});
export const try_ = (body: Stmt[], handlers: Array<{ exc?: string; body: Stmt[] }>): Stmt => ({
  kind: "try",
  body,
  handlers,
  ...src(),
});
export const exprstmt = (expr: Expr): Stmt => ({ kind: "exprstmt", expr, ...src() });
export const unpack = (targets: string[], value: Expr): Stmt => ({ kind: "unpackassign", targets, value, ...src() });
export const unknown = (source: string): Stmt => ({ kind: "unknown", source });
