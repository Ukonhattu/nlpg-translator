/**
 * Where to declare each local variable in a block-scoped language (C, Java…).
 *
 * Python variables live for the whole function; C variables live in the block
 * that declares them. For every variable we find the innermost block that
 * contains all of its uses and then pick, in order of preference:
 *
 *  1. loop-local: all uses are inside one `for`/`forin` whose loop variable it
 *     is -> `for (int i = ...)` / declared at the top of the loop body;
 *  2. inline: the first statement of that block that uses it is a plain
 *     assignment to it -> `int total = 0;` at that assignment (every other use
 *     comes later in the same block, so nothing is read before it is set, even
 *     across loop iterations);
 *  3. hoisted: declared at the top of the function (or `main`).
 */

import { childStatementLists, type Expr, type Stmt } from "../ast.js";
import { canonicalName, MAIN_SCOPE, type Analysis } from "./infer.js";

export type DeclarationPlan = {
  /** Declared at the top of the scope, in first-use order. */
  hoisted: string[];
  /** `assign` statements that also declare their target. */
  inline: Map<Stmt, string>;
  /** `for`/`forin` statements whose loop variable is declared by the loop. */
  loopLocal: Map<Stmt, string>;
};

type PathEntry = { block: Stmt[]; index: number };

/** Direct sub-expressions of an expression. */
export function subExprs(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "binop":
    case "compare":
    case "contains":
      return [expr.left, expr.right];
    case "boolop":
      return expr.values;
    case "not":
    case "cast":
      return [expr.value];
    case "index":
      return [expr.target, expr.index];
    case "input":
      return expr.prompt ? [expr.prompt] : [];
    case "list":
      return expr.items;
    case "call":
      return expr.args;
    case "methodcall":
      return [expr.target, ...expr.args];
    case "fstring":
      return expr.parts.flatMap((p) => (p.kind === "expr" ? [p.value] : []));
    default:
      return [];
  }
}

/** Calls `fn` for `expr` and every expression inside it. */
export function walkExpr(expr: Expr, fn: (e: Expr) => void): void {
  fn(expr);
  for (const sub of subExprs(expr)) walkExpr(sub, fn);
}

export function exprNames(expr: Expr, out: Set<string> = new Set()): Set<string> {
  walkExpr(expr, (e) => {
    if (e.kind === "var") out.add(canonicalName(e.name));
  });
  return out;
}

/** Expressions in a statement's own header (not in nested bodies). */
export function headerExprs(s: Stmt): Expr[] {
  const list = (...es: Array<Expr | undefined>) => es.filter((e): e is Expr => e !== undefined);
  switch (s.kind) {
    case "assign":
      return list(s.targetExpr, s.value);
    case "augassign":
    case "unpackassign":
    case "print":
    case "append":
      return [s.value];
    case "if":
      return [s.test, ...(s.elifs ?? []).map((c) => c.test)];
    case "while":
      return [s.test];
    case "repeat":
      return [s.count];
    case "for":
      return list(s.start, s.stop, s.step);
    case "forin":
      return [s.iterable];
    case "return":
      return s.values;
    case "assert":
      return list(s.test, s.message);
    case "raise":
      return list(s.message);
    case "exprstmt":
      return [s.expr];
    default:
      return [];
  }
}

/** Names a statement uses or binds in its own header (not in nested bodies). */
export function headerNames(s: Stmt): Set<string> {
  const out = new Set<string>();
  switch (s.kind) {
    case "assign":
      if (s.target) out.add(canonicalName(s.target));
      break;
    case "augassign":
    case "append":
      out.add(canonicalName(s.target));
      break;
    case "unpackassign":
      s.targets.forEach((t) => out.add(canonicalName(t)));
      break;
    case "for":
    case "forin":
      out.add(canonicalName(s.loopVar));
      break;
  }
  for (const e of headerExprs(s)) exprNames(e, out);
  return out;
}

export function planDeclarations(
  statements: Stmt[],
  scopeKey: string,
  analysis: Analysis,
  /** Variables to place (locals of the scope, without parameters/globals). */
  names: Set<string>
): DeclarationPlan {
  const occurrences = new Map<string, PathEntry[][]>();

  const visit = (block: Stmt[], prefix: PathEntry[]) => {
    block.forEach((s, index) => {
      if (s.kind === "functiondef") return; // own scope
      const path = [...prefix, { block, index }];
      for (const name of headerNames(s)) {
        if (!names.has(name)) continue;
        if (scopeKey !== MAIN_SCOPE && analysis.resolve(name, scopeKey) !== scopeKey) continue;
        let list = occurrences.get(name);
        if (!list) occurrences.set(name, (list = []));
        list.push(path);
      }
      for (const body of childStatementLists(s)) visit(body, path);
    });
  };
  visit(statements, []);

  const plan: DeclarationPlan = { hoisted: [], inline: new Map(), loopLocal: new Map() };
  for (const [name, paths] of occurrences) {
    // Deepest block containing every use.
    let k = 0;
    for (;;) {
      const block = paths[0][k].block;
      const index = paths[0][k].index;
      const sameStmt = paths.every((p) => p[k].block === block && p[k].index === index);
      const allDeeper = paths.every((p) => p.length > k + 1);
      if (sameStmt && allDeeper && paths.every((p) => p[k + 1].block === paths[0][k + 1].block)) {
        k++;
        continue;
      }
      break;
    }
    const block = paths[0][k].block;
    const indices = paths.map((p) => p[k].index);
    const first = Math.min(...indices);
    const stmt = block[first];

    if (
      indices.every((i) => i === first) &&
      (stmt.kind === "for" || stmt.kind === "forin") &&
      canonicalName(stmt.loopVar) === name &&
      !loopHeaderUses(stmt, name) &&
      !plan.loopLocal.has(stmt)
    ) {
      plan.loopLocal.set(stmt, name);
      continue;
    }
    if (
      stmt.kind === "assign" &&
      stmt.target !== undefined &&
      canonicalName(stmt.target) === name &&
      !exprNames(stmt.value).has(name)
    ) {
      plan.inline.set(stmt, name);
      continue;
    }
    plan.hoisted.push(name);
  }
  return plan;
}

function loopHeaderUses(s: Extract<Stmt, { kind: "for" | "forin" }>, name: string): boolean {
  const exprs = s.kind === "for" ? [s.start, s.stop, s.step] : [s.iterable];
  return exprs.some((e) => e !== undefined && exprNames(e).has(name));
}
