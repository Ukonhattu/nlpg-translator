/**
 * Type and scope inference over verified AST statements.
 *
 * Scoping follows Python: the top level is one scope ("main"), every function
 * is one scope; a name assigned anywhere in a function (or a parameter) is
 * local to it, every other name refers to the top level. Variable identity is
 * the canonical (Python) identifier, so all targets agree on which names are
 * the same variable.
 *
 * Inference is a small fixpoint: statements are walked repeatedly, widening
 * variable, parameter and return types with `unify`, until nothing changes.
 * Parameter types come from call sites. A parameter that is never called with
 * a typed argument is assumed to be `int` (reported as TYPE_ASSUMED).
 */

import { childStatementLists as childBodies, type Expr, type Stmt } from "../ast.js";
import { toPythonIdentifier } from "../identifiers.js";
import type { CodegenDiagnostic } from "../targets/types.js";
import {
  BOOL,
  CONFLICT,
  FLOAT,
  INT,
  NONE,
  STR,
  UNKNOWN,
  containsConflict,
  isConcrete,
  isNumeric,
  listOf,
  typeEquals,
  typeToString,
  unify,
  type Type,
} from "./types.js";

export const MAIN_SCOPE = "main";

export type FunctionInfo = {
  /** Canonical name. */
  name: string;
  def: Extract<Stmt, { kind: "functiondef" }>;
  params: string[];
  paramTypes: Type[];
  /** Parameters whose type was assumed (never called with a known type). */
  assumedParams: Set<number>;
  /** `none` when the function never returns a value. */
  returnType: Type;
  /** True when the definition is not at the top level of the program. */
  nested: boolean;
  /** True for a second definition of an already defined name. */
  duplicate: boolean;
};

export type ScopeInfo = {
  key: string;
  /** Variable types, in first-seen order. Parameters are included. */
  vars: Map<string, Type>;
  /** Function scope only: the function. */
  fn?: FunctionInfo;
};

export type Analysis = {
  scopes: Map<string, ScopeInfo>;
  functions: Map<string, FunctionInfo>;
  /** Top-level variables that functions read or write (globals in C). */
  globals: Set<string>;
  /** Type of an expression as it appears in the program. */
  typeOf(expr: Expr): Type;
  /** Canonical variable key for a source name. */
  key(name: string): string;
  /** The scope that owns `name` when it is used inside `scopeKey`. */
  resolve(name: string, scopeKey: string): string;
  /** The synthetic `target op value` expression of an augassign. */
  augmentedValue(stmt: Extract<Stmt, { kind: "augassign" }>): Expr;
  diagnostics: CodegenDiagnostic[];
};

export function canonicalName(name: string): string {
  return toPythonIdentifier(name, "var");
}

export function functionScopeKey(name: string): string {
  return `fn:${name}`;
}

const MAX_PASSES = 25;

/** Names a function scope binds locally (parameters + assigned names). */
function localNames(def: Extract<Stmt, { kind: "functiondef" }>): Set<string> {
  const names = new Set(def.params.map(canonicalName));
  const visit = (stmts: Stmt[]) => {
    for (const s of stmts) {
      switch (s.kind) {
        case "assign":
          if (s.target) names.add(canonicalName(s.target));
          break;
        case "augassign":
          names.add(canonicalName(s.target));
          break;
        case "unpackassign":
          s.targets.forEach((t) => names.add(canonicalName(t)));
          break;
        case "for":
        case "forin":
          names.add(canonicalName(s.loopVar));
          break;
        case "functiondef":
          continue; // its own scope
      }
      for (const body of childBodies(s)) visit(body);
    }
  };
  visit(def.body);
  return names;
}

export function isFloatLiteral(expr: Extract<Expr, { kind: "num" }>): boolean {
  if (!Number.isInteger(expr.value)) return true;
  return typeof expr.raw === "string" && /[.eE]/.test(expr.raw);
}

const STR_TO_STR = new Set([
  "upper", "lower", "strip", "lstrip", "rstrip", "capitalize", "title", "replace", "swapcase",
]);
const STR_TO_BOOL = new Set([
  "startswith", "endswith", "isdigit", "isalpha", "isalnum", "isupper", "islower", "isspace",
]);
const STR_TO_INT = new Set(["find", "count", "index"]);

export function analyze(statements: Stmt[]): Analysis {
  const scopes = new Map<string, ScopeInfo>();
  const functions = new Map<string, FunctionInfo>();
  const locals = new Map<string, Set<string>>();
  const globals = new Set<string>();
  const exprTypes = new Map<Expr, Type>();
  const augValues = new Map<Stmt, Expr>();
  const diagnostics: CodegenDiagnostic[] = [];
  let changed = false;

  scopes.set(MAIN_SCOPE, { key: MAIN_SCOPE, vars: new Map() });

  // --- collect functions ---------------------------------------------------
  const collect = (stmts: Stmt[], nested: boolean) => {
    for (const s of stmts) {
      if (s.kind === "functiondef") {
        const name = canonicalName(s.name);
        const duplicate = functions.has(name);
        if (!duplicate) {
          const info: FunctionInfo = {
            name,
            def: s,
            params: s.params.map(canonicalName),
            paramTypes: s.params.map(() => UNKNOWN),
            assumedParams: new Set(),
            returnType: UNKNOWN,
            nested,
            duplicate,
          };
          functions.set(name, info);
          const key = functionScopeKey(name);
          scopes.set(key, { key, vars: new Map(), fn: info });
          locals.set(key, localNames(s));
        }
        collect(s.body, true);
        continue;
      }
      for (const body of childBodies(s)) collect(body, true);
    }
  };
  collect(statements, false);

  // --- helpers ---------------------------------------------------------------
  const resolve = (name: string, scopeKey: string): string => {
    if (scopeKey === MAIN_SCOPE) return MAIN_SCOPE;
    if (locals.get(scopeKey)?.has(name)) return scopeKey;
    globals.add(name);
    return MAIN_SCOPE;
  };

  const getVar = (name: string, scopeKey: string): Type =>
    scopes.get(resolve(name, scopeKey))!.vars.get(name) ?? UNKNOWN;

  const setVar = (rawName: string, t: Type, scopeKey: string) => {
    const name = canonicalName(rawName);
    const scope = scopes.get(resolve(name, scopeKey))!;
    const old = scope.vars.get(name);
    const next = old === undefined ? t : unify(old, t);
    if (old === undefined || !typeEquals(old, next)) {
      scope.vars.set(name, next);
      changed = true;
    }
  };

  const widen = (current: Type, t: Type): Type => {
    const next = unify(current, t);
    if (!typeEquals(current, next)) changed = true;
    return next;
  };

  const numericResult = (l: Type, r: Type): Type => {
    if (l.k === "unknown" || r.k === "unknown") return UNKNOWN;
    if (!isNumeric(l) || !isNumeric(r)) return CONFLICT;
    return l.k === "float" || r.k === "float" ? FLOAT : INT;
  };

  const binopType = (op: string, l: Type, r: Type): Type => {
    if (op === "+") {
      if (l.k === "str" && r.k === "str") return STR;
      if (l.k === "list" && r.k === "list") return unify(l, r);
      if ((l.k === "str" || l.k === "list") && r.k === "unknown") return l;
      if ((r.k === "str" || r.k === "list") && l.k === "unknown") return r;
    }
    if (op === "*") {
      if ((l.k === "str" && isNumeric(r)) || (r.k === "str" && isNumeric(l))) return STR;
      if (l.k === "list" && isNumeric(r)) return l;
    }
    if (op === "/") {
      const t = numericResult(l, r);
      return t.k === "int" ? FLOAT : t;
    }
    return numericResult(l, r);
  };

  // --- expressions -----------------------------------------------------------
  const typeOf = (e: Expr, scopeKey: string): Type => {
    const t = computeType(e, scopeKey);
    exprTypes.set(e, t);
    return t;
  };

  const computeType = (e: Expr, scopeKey: string): Type => {
    switch (e.kind) {
      case "num":
        return isFloatLiteral(e) ? FLOAT : INT;
      case "str":
        return STR;
      case "bool":
        return BOOL;
      case "var":
        return getVar(canonicalName(e.name), scopeKey);
      case "binop":
        return binopType(e.op, typeOf(e.left, scopeKey), typeOf(e.right, scopeKey));
      case "compare":
      case "contains":
        typeOf(e.left, scopeKey);
        typeOf(e.right, scopeKey);
        return BOOL;
      case "boolop":
        e.values.forEach((v) => typeOf(v, scopeKey));
        return BOOL;
      case "not":
        typeOf(e.value, scopeKey);
        return BOOL;
      case "index": {
        const t = typeOf(e.target, scopeKey);
        typeOf(e.index, scopeKey);
        if (t.k === "list") return t.elem;
        if (t.k === "str") return STR;
        return t.k === "unknown" ? UNKNOWN : CONFLICT;
      }
      case "input":
        if (e.prompt) typeOf(e.prompt, scopeKey);
        return e.cast === "int" ? INT : e.cast === "float" ? FLOAT : STR;
      case "cast":
        typeOf(e.value, scopeKey);
        return e.type === "int" ? INT : e.type === "float" ? FLOAT : STR;
      case "list":
        return listOf(
          e.items.reduce<Type>((acc, item) => unify(acc, typeOf(item, scopeKey)), UNKNOWN)
        );
      case "fstring":
        for (const part of e.parts) if (part.kind === "expr") typeOf(part.value, scopeKey);
        return STR;
      case "call":
        return callType(e, scopeKey);
      case "methodcall":
        return methodType(e, scopeKey);
    }
  };

  const callType = (e: Extract<Expr, { kind: "call" }>, scopeKey: string): Type => {
    const args = e.args.map((a) => typeOf(a, scopeKey));
    const name = canonicalName(e.func);
    const fn = functions.get(name);
    if (fn) {
      if (args.length === fn.params.length) {
        args.forEach((t, i) => {
          if (isConcrete(t)) fn.paramTypes[i] = widen(fn.paramTypes[i], t);
        });
      }
      return fn.returnType;
    }
    const first = args[0] ?? UNKNOWN;
    switch (name) {
      case "len":
        return INT;
      case "sum":
        return first.k === "list" ? first.elem : UNKNOWN;
      case "max":
      case "min":
        if (args.length === 1) return first.k === "list" ? first.elem : UNKNOWN;
        return args.reduce<Type>((acc, t) => unify(acc, t), UNKNOWN);
      case "abs":
        return first;
      case "round":
        return args.length >= 2 ? FLOAT : INT;
      case "int":
        return INT;
      case "float":
        return FLOAT;
      case "str":
      case "input":
        return STR;
      case "bool":
        return BOOL;
      default:
        return UNKNOWN;
    }
  };

  const methodType = (e: Extract<Expr, { kind: "methodcall" }>, scopeKey: string): Type => {
    const t = typeOf(e.target, scopeKey);
    e.args.forEach((a) => typeOf(a, scopeKey));
    const m = canonicalName(e.method);
    if (t.k === "str") {
      if (STR_TO_STR.has(m)) return STR;
      if (STR_TO_BOOL.has(m)) return BOOL;
      if (STR_TO_INT.has(m)) return INT;
      if (m === "split") return listOf(STR);
    }
    if (t.k === "list") {
      if (m === "pop") return t.elem;
      if (m === "index" || m === "count") return INT;
      if (m === "append") return NONE;
    }
    return UNKNOWN;
  };

  // --- statements ------------------------------------------------------------
  const walk = (stmts: Stmt[], scopeKey: string) => {
    for (const s of stmts) walkStmt(s, scopeKey);
  };

  const walkStmt = (s: Stmt, scopeKey: string) => {
    switch (s.kind) {
      case "assign": {
        const v = typeOf(s.value, scopeKey);
        if (s.target) {
          setVar(s.target, v, scopeKey);
        } else if (s.targetExpr) {
          typeOf(s.targetExpr, scopeKey);
          const base = s.targetExpr;
          if (base.kind === "index" && base.target.kind === "var") {
            setVar(base.target.name, listOf(v), scopeKey);
          }
        }
        return;
      }
      case "augassign": {
        let value = augValues.get(s);
        if (!value) {
          value = { kind: "binop", op: s.op, left: { kind: "var", name: s.target }, right: s.value };
          augValues.set(s, value);
        }
        setVar(s.target, typeOf(value, scopeKey), scopeKey);
        return;
      }
      case "unpackassign": {
        const v = typeOf(s.value, scopeKey);
        s.targets.forEach((t, i) => {
          if (v.k === "tuple" && v.items.length === s.targets.length) setVar(t, v.items[i], scopeKey);
          else if (v.k === "list") setVar(t, v.elem, scopeKey);
          else setVar(t, UNKNOWN, scopeKey);
        });
        return;
      }
      case "print":
        typeOf(s.value, scopeKey);
        return;
      case "if":
        typeOf(s.test, scopeKey);
        walk(s.body, scopeKey);
        for (const c of s.elifs ?? []) {
          typeOf(c.test, scopeKey);
          walk(c.body, scopeKey);
        }
        walk(s.orelse, scopeKey);
        return;
      case "while":
        typeOf(s.test, scopeKey);
        walk(s.body, scopeKey);
        return;
      case "repeat":
        typeOf(s.count, scopeKey);
        walk(s.body, scopeKey);
        return;
      case "for":
        typeOf(s.start, scopeKey);
        typeOf(s.stop, scopeKey);
        if (s.step) typeOf(s.step, scopeKey);
        setVar(s.loopVar, INT, scopeKey);
        walk(s.body, scopeKey);
        return;
      case "forin": {
        const it = typeOf(s.iterable, scopeKey);
        const elem = it.k === "list" ? it.elem : it.k === "str" ? STR : it.k === "unknown" ? UNKNOWN : CONFLICT;
        setVar(s.loopVar, elem, scopeKey);
        walk(s.body, scopeKey);
        return;
      }
      case "append":
        setVar(s.target, listOf(typeOf(s.value, scopeKey)), scopeKey);
        return;
      case "functiondef": {
        const info = functions.get(canonicalName(s.name));
        if (!info || info.def !== s) return; // duplicate definition: not analysed
        const key = functionScopeKey(info.name);
        info.params.forEach((p, i) => setVar(p, info.paramTypes[i], key));
        walk(s.body, key);
        return;
      }
      case "return": {
        const fn = scopes.get(scopeKey)?.fn;
        const types = s.values.map((v) => typeOf(v, scopeKey));
        if (!fn) return;
        const t: Type =
          types.length === 0 ? NONE : types.length === 1 ? types[0] : { k: "tuple", items: types };
        fn.returnType = widen(fn.returnType, t);
        return;
      }
      case "assert":
        typeOf(s.test, scopeKey);
        if (s.message) typeOf(s.message, scopeKey);
        return;
      case "raise":
        if (s.message) typeOf(s.message, scopeKey);
        return;
      case "try":
        walk(s.body, scopeKey);
        for (const h of s.handlers) walk(h.body, scopeKey);
        return;
      case "exprstmt":
        typeOf(s.expr, scopeKey);
        return;
      case "break":
      case "pass":
      case "unknown":
        return;
    }
  };

  const run = () => {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      changed = false;
      walk(statements, MAIN_SCOPE);
      if (!changed) return;
    }
  };

  run();

  // Parameters never called with a known type: assume int and re-run.
  let assumed = false;
  for (const fn of functions.values()) {
    fn.paramTypes.forEach((t, i) => {
      if (t.k === "unknown") {
        fn.paramTypes[i] = INT;
        fn.assumedParams.add(i);
        assumed = true;
        diagnostics.push({
          severity: "warning",
          code: "TYPE_ASSUMED",
          message: `The type of parameter '${fn.params[i]}' of '${fn.name}' could not be inferred (no call passes a typed value); assumed int.`,
        });
      }
    });
  }
  if (assumed) run();

  // Functions without any return statement return nothing.
  for (const fn of functions.values()) {
    if (fn.returnType.k === "unknown" && !hasReturnValue(fn.def.body)) fn.returnType = NONE;
  }

  for (const scope of scopes.values()) {
    for (const [name, t] of scope.vars) {
      if (containsConflict(t)) {
        diagnostics.push({
          severity: "warning",
          code: "TYPE_CONFLICT",
          message: `'${name}' is used with incompatible types${scope.fn ? ` in '${scope.fn.name}'` : ""}; a statically typed language cannot declare it.`,
        });
      }
    }
  }
  for (const fn of functions.values()) {
    if (containsConflict(fn.returnType)) {
      diagnostics.push({
        severity: "warning",
        code: "TYPE_CONFLICT",
        message: `'${fn.name}' returns values of incompatible types (${typeToString(fn.returnType)}).`,
      });
    }
  }

  return {
    scopes,
    functions,
    globals,
    typeOf: (e) => exprTypes.get(e) ?? UNKNOWN,
    key: canonicalName,
    resolve,
    augmentedValue: (s) => augValues.get(s)!,
    diagnostics,
  };
}

function hasReturnValue(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.kind === "return" && s.values.length > 0) return true;
    if (s.kind === "functiondef") continue;
    if (childBodies(s).some(hasReturnValue)) return true;
  }
  return false;
}
