/**
 * Deterministic AST -> C11 code generator.
 *
 * Output is one translation unit: includes, the runtime helpers actually used
 * (see runtime.ts), globals, functions and `int main(void)`. Types come from
 * the semantic pass (src/semantics). Statements C cannot express (try/except,
 * raise, tuple returns, values whose type cannot be inferred, ...) become
 * `// unsupported in C:` comments with a TARGET_UNSUPPORTED diagnostic, and
 * are counted so the block is reported as "partial".
 *
 * Output conventions: whole numbers are `int`, decimals are `double` printed
 * with `%g`, booleans print as 1/0, and `/` keeps true division
 * (`(double)a / b` for two ints) because the instructions say "divide".
 */

import { childStatementLists, type Expr, type FStringPart, type Stmt } from "../../ast.js";
import {
  headerExprs,
  planDeclarations,
  walkExpr,
  type DeclarationPlan,
} from "../../semantics/declarations.js";
import {
  analyze,
  canonicalName,
  functionScopeKey,
  isFloatLiteral,
  MAIN_SCOPE,
  type Analysis,
  type FunctionInfo,
} from "../../semantics/infer.js";
import { isConcrete, isNumeric, typeToString, type Type } from "../../semantics/types.js";
import type { CodegenDiagnostic, GenerateResult } from "../types.js";
import { toCIdentifier } from "./identifiers.js";
import { listFn, listTypeName, renderRuntime, type ListElem } from "./runtime.js";

const INDENT = "    ";

class Unsupported extends Error {}

const P_OR = 1;
const P_AND = 2;
const P_EQ = 3;
const P_REL = 4;
const P_ADD = 5;
const P_MUL = 6;
const P_UNARY = 7;
const P_POSTFIX = 8;
const P_PRIMARY = 9;

type Emitted = { code: string; prec: number };

function wrap(e: Emitted, minPrec: number): string {
  return e.prec < minPrec ? `(${e.code})` : e.code;
}

/** A C string literal. `??` is split so it can never form a trigraph. */
export function cString(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, "0")}`;
    else if (ch === "?" && out.endsWith("?")) out += "\\?";
    else out += ch;
  }
  return `"${out}"`;
}

/** Text that is safe inside a `//` comment (no line continuation, no trigraphs). */
function commentText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\?\?/g, "? ?").replace(/\\+$/, "");
}

const RAW_FLOAT = /^-?\d+\.\d+([eE][+-]?\d+)?$|^-?\d+[eE][+-]?\d+$/;
const RAW_INT = /^-?(0|[1-9]\d*)$/;
const INT_MAX = 2147483647;

function numberLiteral(e: Extract<Expr, { kind: "num" }>): string {
  if (isFloatLiteral(e)) {
    if (typeof e.raw === "string" && RAW_FLOAT.test(e.raw) && Number(e.raw) === e.value) {
      return e.raw;
    }
    const s = String(e.value);
    return /[.eE]/.test(s) ? s : `${s}.0`;
  }
  if (Math.abs(e.value) > INT_MAX) {
    throw new Unsupported(`the number ${e.value} is too large for an int`);
  }
  if (typeof e.raw === "string" && RAW_INT.test(e.raw) && Number(e.raw) === e.value) return e.raw;
  return String(e.value);
}

function listElem(t: Type): ListElem {
  switch (t.k) {
    case "int":
      return "int";
    case "float":
      return "double";
    case "bool":
      return "bool";
    case "str":
      return "str";
    default:
      throw new Unsupported(`a list of ${typeToString(t)} values`);
  }
}

type Snapshot = {
  helpers: Set<string>;
  includes: Set<string>;
  unsupported: number;
  diagnostics: number;
  notes: Set<string>;
};

class CGenerator {
  helpers = new Set<string>();
  includes = new Set<string>();
  unsupported = 0;
  notes = new Set<string>();
  /** C identifier -> canonical names mapped to it. */
  idents = new Map<string, Set<string>>();
  scope = MAIN_SCOPE;
  plan: DeclarationPlan = { hoisted: [], inline: new Map(), loopLocal: new Map() };
  counter = 0;
  callable = new Set<string>();

  constructor(
    readonly analysis: Analysis,
    readonly diagnostics: CodegenDiagnostic[]
  ) {}

  // --- bookkeeping -----------------------------------------------------------

  note(code: string, message: string, severity: CodegenDiagnostic["severity"] = "warning", line?: number) {
    if (this.notes.has(message)) return;
    this.notes.add(message);
    this.diagnostics.push({ severity, code, message, ...(line !== undefined ? { line } : {}) });
  }

  use(helper: string) {
    this.helpers.add(helper);
  }

  include(header: string) {
    this.includes.add(header);
  }

  snapshot(): Snapshot {
    return {
      helpers: new Set(this.helpers),
      includes: new Set(this.includes),
      unsupported: this.unsupported,
      diagnostics: this.diagnostics.length,
      notes: new Set(this.notes),
    };
  }

  restore(s: Snapshot) {
    this.helpers = s.helpers;
    this.includes = s.includes;
    this.unsupported = s.unsupported;
    this.diagnostics.length = s.diagnostics;
    this.notes = s.notes;
  }

  /** `fileScope`: globals and functions, which must not reuse C library names. */
  ident(canonical: string, fileScope = false): string {
    const id = toCIdentifier(canonical, fileScope);
    let seen = this.idents.get(id);
    if (!seen) this.idents.set(id, (seen = new Set()));
    if (!seen.has(canonical)) {
      seen.add(canonical);
      if (seen.size > 1) {
        this.note(
          "NAME_COLLISION",
          `Names ${[...seen].map((s) => JSON.stringify(s)).join(" and ")} all map to the C identifier '${id}'.`
        );
      }
    }
    return id;
  }

  varIdent(name: string): string {
    const key = canonicalName(name);
    return this.ident(key, this.isGlobal(key));
  }

  isGlobal(key: string): boolean {
    return this.analysis.resolve(key, this.scope) === MAIN_SCOPE && this.analysis.globals.has(key);
  }

  varType(name: string): Type {
    const key = canonicalName(name);
    const owner = this.analysis.resolve(key, this.scope);
    return this.analysis.scopes.get(owner)?.vars.get(key) ?? { k: "unknown" };
  }

  // --- types -----------------------------------------------------------------

  ctype(t: Type): string {
    switch (t.k) {
      case "int":
        return "int";
      case "float":
        return "double";
      case "bool":
        this.include("stdbool.h");
        return "bool";
      case "str":
        return "const char *";
      case "list": {
        const elem = listElem(t.elem);
        this.use(`list_${elem}_type`);
        return `${listTypeName(elem)} *`;
      }
      default:
        throw new Unsupported(`a value whose type cannot be determined (${typeToString(t)})`);
    }
  }

  declaration(t: Type, id: string): string {
    const c = this.ctype(t);
    return c.endsWith("*") ? `${c}${id}` : `${c} ${id}`;
  }

  typeOf(e: Expr): Type {
    const t = this.analysis.typeOf(e);
    if (!isConcrete(t)) {
      const what = e.kind === "var" ? `'${e.name}'` : "a value";
      throw new Unsupported(`the type of ${what} cannot be determined (${typeToString(t)})`);
    }
    return t;
  }

  // --- expressions -----------------------------------------------------------

  /** Emits `e` for a slot of type `want` (list literals adopt the wanted element type). */
  emitAs(e: Expr, want: Type | undefined): Emitted {
    if (e.kind === "list" && want?.k === "list" && isConcrete(want.elem)) {
      return this.listLiteral(e, want.elem);
    }
    return this.emit(e);
  }

  /** As emitAs, but converts ints explicitly where C would not (variadic arguments). */
  emitVariadic(e: Expr, want: Type): string {
    const got = this.emitAs(e, want);
    if (want.k === "float" && this.typeOf(e).k !== "float") return `(double)${wrap(got, P_UNARY)}`;
    return got.code;
  }

  emit(e: Expr): Emitted {
    switch (e.kind) {
      case "num": {
        const code = numberLiteral(e);
        return { code, prec: code.startsWith("-") ? P_UNARY : P_PRIMARY };
      }
      case "str":
        return { code: cString(e.value), prec: P_PRIMARY };
      case "bool":
        this.include("stdbool.h");
        return { code: e.value ? "true" : "false", prec: P_PRIMARY };
      case "var":
        this.typeOf(e);
        return { code: this.varIdent(e.name), prec: P_PRIMARY };
      case "binop":
        return this.binop(e);
      case "compare":
        return this.compare(e);
      case "boolop": {
        const prec = e.op === "or" ? P_OR : P_AND;
        const op = e.op === "or" ? " || " : " && ";
        // `a || (b && c)`: compilers ask for the parentheses, and they help readers.
        return { code: e.values.map((v) => wrap(this.truthy(v), P_AND + 1)).join(op), prec };
      }
      case "not":
        return { code: `!${wrap(this.truthy(e.value), P_UNARY)}`, prec: P_UNARY };
      case "contains":
        return this.contains(e);
      case "index":
        return this.index(e);
      case "input":
        return this.input(e.prompt, e.cast);
      case "cast":
        return this.castTo(e.type, e.value);
      case "list": {
        const t = this.typeOf(e);
        return this.listLiteral(e, t.k === "list" ? t.elem : t);
      }
      case "call":
        return this.call(e);
      case "methodcall":
        return this.methodcall(e);
      case "fstring":
        return this.fstring(e.parts);
    }
  }

  binop(e: Extract<Expr, { kind: "binop" }>): Emitted {
    const t = this.typeOf(e);
    const lt = this.typeOf(e.left);
    const rt = this.typeOf(e.right);
    if (t.k === "str") {
      if (e.op === "+") {
        this.use("str_concat");
        return { code: `nl_str_concat(${this.emit(e.left).code}, ${this.emit(e.right).code})`, prec: P_POSTFIX };
      }
      if (e.op === "*") {
        this.use("str_repeat");
        const [s, n] = lt.k === "str" ? [e.left, e.right] : [e.right, e.left];
        return { code: `nl_str_repeat(${this.emit(s).code}, ${this.emit(n).code})`, prec: P_POSTFIX };
      }
      throw new Unsupported(`the operator '${e.op}' on text`);
    }
    if (t.k === "list") {
      if (e.op !== "+") throw new Unsupported(`the operator '${e.op}' on a list`);
      const elem = listElem(t.elem);
      this.use(`list_${elem}_concat`);
      return {
        code: `${listFn(elem, "concat")}(${this.emitAs(e.left, t).code}, ${this.emitAs(e.right, t).code})`,
        prec: P_POSTFIX,
      };
    }
    if (!isNumeric(lt) || !isNumeric(rt)) {
      throw new Unsupported(`the operator '${e.op}' on ${typeToString(lt)} and ${typeToString(rt)}`);
    }
    if ((e.op === "/" || e.op === "%") && e.right.kind === "num" && e.right.value === 0) {
      throw new Unsupported("division by zero");
    }
    if (e.op === "%" && t.k === "float") {
      this.include("math.h");
      return { code: `fmod(${this.emit(e.left).code}, ${this.emit(e.right).code})`, prec: P_POSTFIX };
    }
    const prec = e.op === "+" || e.op === "-" ? P_ADD : P_MUL;
    const l = this.emit(e.left);
    const r = this.emit(e.right);
    let leftCode = wrap(l, prec);
    if (e.op === "/" && lt.k !== "float" && rt.k !== "float") {
      leftCode = `(double)${wrap(l, P_UNARY)}`;
      this.note(
        "INT_DIVISION",
        "Division of two whole numbers is written as (double)a / b so the result keeps its fractional part.",
        "info"
      );
    }
    const sameAssoc = (e.op === "+" || e.op === "*") && e.right.kind === "binop" && e.right.op === e.op;
    const rightCode =
      (e.op === "-" || e.op === "+") && r.code.startsWith("-")
        ? `(${r.code})`
        : wrap(r, sameAssoc ? prec : prec + 1);
    return { code: `${leftCode} ${e.op} ${rightCode}`, prec };
  }

  compare(e: Extract<Expr, { kind: "compare" }>): Emitted {
    const lt = this.typeOf(e.left);
    const rt = this.typeOf(e.right);
    const prec = e.op === "==" || e.op === "!=" ? P_EQ : P_REL;
    if (lt.k === "str" && rt.k === "str") {
      this.include("string.h");
      return { code: `strcmp(${this.emit(e.left).code}, ${this.emit(e.right).code}) ${e.op} 0`, prec };
    }
    if (isNumeric(lt) && isNumeric(rt)) {
      // Comparison and `!x` operands are always parenthesised.
      const operand = (x: Expr) => {
        const em = this.emit(x);
        return x.kind === "not" ? `(${em.code})` : wrap(em, P_ADD);
      };
      return { code: `${operand(e.left)} ${e.op} ${operand(e.right)}`, prec };
    }
    throw new Unsupported(`comparing ${typeToString(lt)} with ${typeToString(rt)}`);
  }

  /** A condition: numbers as they are, text non-empty, lists non-empty. */
  truthy(e: Expr): Emitted {
    const t = this.typeOf(e);
    if (t.k === "float" || (e.kind === "num" && e.value !== 0 && e.value !== 1)) {
      return { code: `${wrap(this.emit(e), P_REL + 1)} != 0`, prec: P_EQ };
    }
    if (isNumeric(t)) return this.emit(e);
    if (t.k === "str") {
      return { code: `${wrap(this.emit(e), P_POSTFIX)}[0] != '\\0'`, prec: P_EQ };
    }
    if (t.k === "list") {
      return { code: `${wrap(this.emit(e), P_POSTFIX)}->len > 0`, prec: P_REL };
    }
    throw new Unsupported(`using ${typeToString(t)} as a condition`);
  }

  contains(e: Extract<Expr, { kind: "contains" }>): Emitted {
    const lt = this.typeOf(e.left);
    const rt = this.typeOf(e.right);
    if (rt.k === "list" && (lt.k === "str") === (rt.elem.k === "str")) {
      const elem = listElem(rt.elem);
      this.use(`list_${elem}_contains`);
      return {
        code: `${listFn(elem, "contains")}(${this.emit(e.right).code}, ${this.emitAs(e.left, rt.elem).code})`,
        prec: P_POSTFIX,
      };
    }
    if (rt.k === "str" && lt.k === "str") {
      this.include("string.h");
      return { code: `strstr(${this.emit(e.right).code}, ${this.emit(e.left).code}) != NULL`, prec: P_EQ };
    }
    throw new Unsupported(`'in' with ${typeToString(lt)} and ${typeToString(rt)}`);
  }

  index(e: Extract<Expr, { kind: "index" }>): Emitted {
    const t = this.typeOf(e.target);
    const it = this.typeOf(e.index);
    if (it.k !== "int" && it.k !== "bool") throw new Unsupported(`an index of type ${typeToString(it)}`);
    if (t.k === "list") {
      const elem = listElem(t.elem);
      this.use(`list_${elem}_get`);
      return { code: `${listFn(elem, "get")}(${this.emit(e.target).code}, ${this.emit(e.index).code})`, prec: P_POSTFIX };
    }
    if (t.k === "str") {
      this.use("str_char_at");
      return { code: `nl_str_char_at(${this.emit(e.target).code}, ${this.emit(e.index).code})`, prec: P_POSTFIX };
    }
    throw new Unsupported(`indexing ${typeToString(t)}`);
  }

  input(prompt: Expr | undefined, cast: "int" | "float" | undefined): Emitted {
    if (prompt && this.typeOf(prompt).k !== "str") throw new Unsupported("an input prompt that is not text");
    this.use("input");
    const call = `nl_input(${prompt ? this.emit(prompt).code : '""'})`;
    if (cast === "int") {
      this.use("str_to_int");
      return { code: `nl_str_to_int(${call})`, prec: P_POSTFIX };
    }
    if (cast === "float") {
      this.use("str_to_double");
      return { code: `nl_str_to_double(${call})`, prec: P_POSTFIX };
    }
    return { code: call, prec: P_POSTFIX };
  }

  castTo(type: "int" | "float" | "str", value: Expr): Emitted {
    const vt = this.typeOf(value);
    const v = this.emit(value);
    if (type === "int") {
      if (vt.k === "int") return v;
      if (vt.k === "float" || vt.k === "bool") return { code: `(int)${wrap(v, P_UNARY)}`, prec: P_UNARY };
      if (vt.k === "str") {
        this.use("str_to_int");
        return { code: `nl_str_to_int(${v.code})`, prec: P_POSTFIX };
      }
    }
    if (type === "float") {
      if (vt.k === "float") return v;
      if (vt.k === "int" || vt.k === "bool") return { code: `(double)${wrap(v, P_UNARY)}`, prec: P_UNARY };
      if (vt.k === "str") {
        this.use("str_to_double");
        return { code: `nl_str_to_double(${v.code})`, prec: P_POSTFIX };
      }
    }
    if (type === "str") {
      if (vt.k === "str") return v;
      if (vt.k === "int" || vt.k === "bool") {
        this.use("int_to_str");
        return { code: `nl_int_to_str(${v.code})`, prec: P_POSTFIX };
      }
      if (vt.k === "float") {
        this.use("double_to_str");
        return { code: `nl_double_to_str(${v.code})`, prec: P_POSTFIX };
      }
      if (vt.k === "list") {
        const elem = listElem(vt.elem);
        this.use(`list_${elem}_to_str`);
        return { code: `${listFn(elem, "to_str")}(${v.code})`, prec: P_POSTFIX };
      }
    }
    throw new Unsupported(`converting ${typeToString(vt)} to ${type}`);
  }

  listLiteral(e: Extract<Expr, { kind: "list" }>, elemType: Type): Emitted {
    const elem = listElem(elemType);
    if (e.items.length === 0) {
      this.use(`list_${elem}_new`);
      return { code: `${listFn(elem, "new")}()`, prec: P_POSTFIX };
    }
    for (const item of e.items) {
      const it = this.typeOf(item);
      if ((it.k === "str") !== (elem === "str") || it.k === "list") {
        throw new Unsupported(`a list mixing ${typeToString(it)} with ${elem} values`);
      }
    }
    this.use(`list_${elem}_of`);
    const items = e.items.map((item) => this.emitVariadic(item, elemType));
    return { code: `${listFn(elem, "of")}(${e.items.length}, ${items.join(", ")})`, prec: P_POSTFIX };
  }

  call(e: Extract<Expr, { kind: "call" }>): Emitted {
    const name = canonicalName(e.func);
    const fn = this.analysis.functions.get(name);
    if (fn) {
      if (!this.callable.has(name)) throw new Unsupported(`a call to '${e.func}', which could not be translated`);
      if (e.args.length !== fn.params.length) {
        throw new Unsupported(`calling '${e.func}' with ${e.args.length} argument(s) instead of ${fn.params.length}`);
      }
      const args = e.args.map((a, i) => this.emitAs(a, fn.paramTypes[i]).code);
      return { code: `${this.ident(fn.name, true)}(${args.join(", ")})`, prec: P_POSTFIX };
    }
    const types = e.args.map((a) => this.typeOf(a));
    const one = (what: string) => {
      if (e.args.length !== 1) throw new Unsupported(`${what} with ${e.args.length} arguments`);
      return { arg: e.args[0], t: types[0] };
    };
    switch (name) {
      case "len": {
        const { arg, t } = one("len()");
        if (t.k === "list") return { code: `${wrap(this.emit(arg), P_POSTFIX)}->len`, prec: P_POSTFIX };
        if (t.k === "str") {
          this.include("string.h");
          return { code: `(int)strlen(${this.emit(arg).code})`, prec: P_UNARY };
        }
        throw new Unsupported(`len() of ${typeToString(t)}`);
      }
      case "sum": {
        const { arg, t } = one("sum()");
        if (t.k === "list" && (t.elem.k === "int" || t.elem.k === "float")) {
          const elem = listElem(t.elem);
          this.use(`list_${elem}_sum`);
          return { code: `${listFn(elem, "sum")}(${this.emit(arg).code})`, prec: P_POSTFIX };
        }
        throw new Unsupported(`sum() of ${typeToString(t)}`);
      }
      case "max":
      case "min": {
        if (e.args.length === 1) {
          const t = types[0];
          if (t.k === "list" && (t.elem.k === "int" || t.elem.k === "float")) {
            const elem = listElem(t.elem);
            this.use(`list_${elem}_${name}`);
            return { code: `${listFn(elem, name)}(${this.emit(e.args[0]).code})`, prec: P_POSTFIX };
          }
          throw new Unsupported(`${name}() of ${typeToString(t)}`);
        }
        if (e.args.length < 2 || !types.every(isNumeric)) {
          throw new Unsupported(`${name}() of ${types.map(typeToString).join(", ")}`);
        }
        const suffix = types.some((t) => t.k === "float") ? "double" : "int";
        this.use(`${name}_${suffix}`);
        const fnName = `nl_${name}_${suffix}`;
        const codes = e.args.map((a) => this.emit(a).code);
        const code = codes.slice(1).reduce((acc, c) => `${fnName}(${acc}, ${c})`, codes[0]);
        return { code, prec: P_POSTFIX };
      }
      case "abs": {
        const { arg, t } = one("abs()");
        if (t.k === "float") {
          this.include("math.h");
          return { code: `fabs(${this.emit(arg).code})`, prec: P_POSTFIX };
        }
        if (t.k === "int" || t.k === "bool") {
          this.include("stdlib.h");
          return { code: `abs(${this.emit(arg).code})`, prec: P_POSTFIX };
        }
        throw new Unsupported(`abs() of ${typeToString(t)}`);
      }
      case "round": {
        const { arg, t } = one("round()");
        if (t.k === "float") {
          // nearbyint rounds halves to even, like Python's round().
          this.include("math.h");
          return { code: `(int)nearbyint(${this.emit(arg).code})`, prec: P_UNARY };
        }
        if (t.k === "int") return this.emit(arg);
        throw new Unsupported(`round() of ${typeToString(t)}`);
      }
      case "int":
      case "float":
      case "str":
        return this.castTo(name, one(`${name}()`).arg);
      case "bool": {
        const { arg, t } = one("bool()");
        if (t.k === "int" || t.k === "float") return { code: `${wrap(this.emit(arg), P_REL + 1)} != 0`, prec: P_EQ };
        return this.truthy(arg);
      }
      case "input":
        if (e.args.length > 1) throw new Unsupported("input() with several arguments");
        return this.input(e.args[0], undefined);
      default:
        throw new Unsupported(`the function '${e.func}', which C does not have`);
    }
  }

  methodcall(e: Extract<Expr, { kind: "methodcall" }>): Emitted {
    const t = this.typeOf(e.target);
    const m = canonicalName(e.method);
    const target = () => this.emit(e.target).code;
    const strArgs = (n: number) => {
      if (e.args.length !== n || !e.args.every((a) => this.typeOf(a).k === "str")) {
        throw new Unsupported(`.${e.method}() with these arguments`);
      }
      return e.args.map((a) => this.emit(a).code);
    };
    if (t.k === "str") {
      const simple: Record<string, string> = {
        upper: "str_upper",
        lower: "str_lower",
        capitalize: "str_capitalize",
        strip: "str_strip",
        lstrip: "str_lstrip",
        rstrip: "str_rstrip",
      };
      if (simple[m]) {
        strArgs(0);
        this.use(simple[m]);
        return { code: `nl_${simple[m]}(${target()})`, prec: P_POSTFIX };
      }
      if (m === "replace" || m === "startswith" || m === "endswith") {
        const args = strArgs(m === "replace" ? 2 : 1);
        this.use(`str_${m}`);
        return { code: `nl_str_${m}(${[target(), ...args].join(", ")})`, prec: P_POSTFIX };
      }
    }
    if (t.k === "list") {
      const elem = listElem(t.elem);
      if (m === "append" && e.args.length === 1) {
        this.use(`list_${elem}_append`);
        return {
          code: `${listFn(elem, "append")}(${target()}, ${this.emitAs(e.args[0], t.elem).code})`,
          prec: P_POSTFIX,
        };
      }
      if (m === "pop" && e.args.length === 0) {
        this.use(`list_${elem}_pop`);
        return { code: `${listFn(elem, "pop")}(${target()})`, prec: P_POSTFIX };
      }
    }
    throw new Unsupported(`the method .${e.method}() on ${typeToString(t)}`);
  }

  /** printf-style format string and arguments for f-string parts. */
  formatParts(parts: FStringPart[]): { format: string; args: string[] } {
    let format = "";
    const args: string[] = [];
    for (const part of parts) {
      if (part.kind === "lit") {
        format += part.value.replace(/%/g, "%%");
        continue;
      }
      const t = this.typeOf(part.value);
      const code = this.emit(part.value).code;
      if (t.k === "int" || t.k === "bool") {
        format += "%d";
        args.push(code);
      } else if (t.k === "float") {
        format += "%g";
        args.push(code);
      } else if (t.k === "str") {
        format += "%s";
        args.push(code);
      } else if (t.k === "list") {
        const elem = listElem(t.elem);
        this.use(`list_${elem}_to_str`);
        format += "%s";
        args.push(`${listFn(elem, "to_str")}(${code})`);
      } else {
        throw new Unsupported(`formatting ${typeToString(t)}`);
      }
    }
    return { format, args };
  }

  fstring(parts: FStringPart[]): Emitted {
    const { format, args } = this.formatParts(parts);
    if (args.length === 0) {
      return { code: cString(parts.map((p) => (p.kind === "lit" ? p.value : "")).join("")), prec: P_PRIMARY };
    }
    this.use("format");
    return { code: `nl_format(${[cString(format), ...args].join(", ")})`, prec: P_POSTFIX };
  }

  // --- statements --------------------------------------------------------------

  block(stmts: Stmt[], indent: string): string[] {
    return stmts.flatMap((s) => this.statement(s, indent));
  }

  /** One statement; anything C cannot express becomes an `unsupported` comment. */
  statement(s: Stmt, indent: string): string[] {
    const saved = this.snapshot();
    try {
      return this.emitStmt(s, indent);
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      this.restore(saved);
      const lines: string[] = [];
      // A variable this assignment would have declared is still needed later.
      const declared = this.plan.inline.get(s);
      if (declared) {
        try {
          lines.push(`${indent}${this.declaration(this.varType(declared), this.ident(declared))};`);
        } catch (inner) {
          if (!(inner instanceof Unsupported)) throw inner;
        }
      }
      this.unsupported++;
      const line = (s as { line?: number }).line;
      this.diagnostics.push({
        severity: "warning",
        code: "TARGET_UNSUPPORTED",
        message: `${line ? `Line ${line}: ` : ""}not translated to C: ${err.message}.`,
        ...(line ? { line } : {}),
      });
      return [...lines, ...this.commentOut(s, indent, "unsupported in C")];
    }
  }

  /** The statement's source line(s) as comments; each source line appears once. */
  commentOut(s: Stmt, indent: string, label: string, seen = new Set<string>()): string[] {
    const lines: string[] = [];
    const text = commentText(s.source ?? "");
    const key = `${(s as { line?: number }).line ?? ""}:${text}`;
    if (!seen.has(key)) {
      seen.add(key);
      lines.push(`${indent}// ${label}: ${text}`);
    }
    for (const body of childStatementLists(s)) {
      for (const child of body) lines.push(...this.commentOut(child, indent + INDENT, label, seen));
    }
    return lines;
  }

  braced(header: string, body: Stmt[], indent: string, prefix: string[] = []): string[] {
    return [`${indent}${header} {`, ...prefix, ...this.block(body, indent + INDENT), `${indent}}`];
  }

  emitStmt(s: Stmt, indent: string): string[] {
    switch (s.kind) {
      case "assign": {
        if (s.targetExpr) {
          const te = s.targetExpr;
          if (te.kind !== "index") throw new Unsupported("this assignment target");
          const lt = this.typeOf(te.target);
          if (lt.k !== "list") throw new Unsupported(`assigning into ${typeToString(lt)}`);
          const elem = listElem(lt.elem);
          this.use(`list_${elem}_set`);
          const it = this.typeOf(te.index);
          if (it.k !== "int" && it.k !== "bool") throw new Unsupported(`an index of type ${typeToString(it)}`);
          return [
            `${indent}${listFn(elem, "set")}(${this.emit(te.target).code}, ${this.emit(te.index).code}, ${this.emitAs(s.value, lt.elem).code});`,
          ];
        }
        const vt = this.varType(s.target!);
        const value = this.emitAs(s.value, vt).code;
        const id = this.varIdent(s.target!);
        if (this.plan.inline.get(s) === canonicalName(s.target!)) {
          return [`${indent}${this.declaration(vt, id)} = ${value};`];
        }
        this.ctype(vt);
        return [`${indent}${id} = ${value};`];
      }
      case "augassign": {
        const vt = this.varType(s.target);
        this.ctype(vt);
        const value = this.emitAs(this.analysis.augmentedValue(s), vt).code;
        return [`${indent}${this.varIdent(s.target)} = ${value};`];
      }
      case "unpackassign":
        throw new Unsupported("assigning several values at once");
      case "print":
        return [`${indent}${this.print(s.value)};`];
      case "if": {
        const lines = [`${indent}if (${this.truthy(s.test).code}) {`, ...this.block(s.body, indent + INDENT)];
        for (const clause of s.elifs ?? []) {
          lines.push(`${indent}} else if (${this.truthy(clause.test).code}) {`, ...this.block(clause.body, indent + INDENT));
        }
        if (s.orelse.length > 0) lines.push(`${indent}} else {`, ...this.block(s.orelse, indent + INDENT));
        lines.push(`${indent}}`);
        return lines;
      }
      case "while":
        return this.braced(`while (${this.truthy(s.test).code})`, s.body, indent);
      case "repeat": {
        const ct = this.typeOf(s.count);
        if (ct.k !== "int" && ct.k !== "bool") throw new Unsupported(`repeating ${typeToString(ct)} times`);
        const i = `nl_i${++this.counter}`;
        const count = this.emit(s.count);
        const pre: string[] = [];
        let limit = count.code;
        if (s.count.kind !== "num" && s.count.kind !== "var") {
          limit = `nl_n${this.counter}`;
          pre.push(`${indent}int ${limit} = ${count.code};`);
        }
        return [...pre, ...this.braced(`for (int ${i} = 0; ${i} < ${wrap({ code: limit, prec: P_PRIMARY }, P_ADD)}; ${i}++)`, s.body, indent)];
      }
      case "for":
        return this.forRange(s, indent);
      case "forin":
        return this.forIn(s, indent);
      case "break":
        return [`${indent}break;`];
      case "pass":
        return [];
      case "append": {
        const lt = this.varType(s.target);
        if (lt.k !== "list") throw new Unsupported(`appending to ${typeToString(lt)}`);
        const elem = listElem(lt.elem);
        this.use(`list_${elem}_append`);
        return [`${indent}${listFn(elem, "append")}(${this.varIdent(s.target)}, ${this.emitAs(s.value, lt.elem).code});`];
      }
      case "functiondef":
        throw new Unsupported("a function defined inside another block");
      case "return": {
        const fn = this.analysis.scopes.get(this.scope)?.fn;
        if (!fn) throw new Unsupported("return outside a function");
        if (s.values.length > 1) throw new Unsupported("returning several values");
        if (s.values.length === 0) return [`${indent}return;`];
        return [`${indent}return ${this.emitAs(s.values[0], fn.returnType).code};`];
      }
      case "assert": {
        this.include("assert.h");
        const test = this.truthy(s.test);
        if (s.message?.kind === "str") {
          return [`${indent}assert(${wrap(test, P_AND + 1)} && ${cString(s.message.value)});`];
        }
        if (s.message) {
          this.note("ASSERT_MESSAGE_DROPPED", "An assert message that is not fixed text was left out (C's assert prints the condition).", "info");
        }
        return [`${indent}assert(${test.code});`];
      }
      case "raise":
        throw new Unsupported("raising an exception (C has no exceptions)");
      case "try":
        throw new Unsupported("try/except (C has no exceptions)");
      case "exprstmt":
        return [`${indent}${this.emit(s.expr).code};`];
      case "unknown":
        return [`${indent}// unsupported: ${commentText(s.source ?? "")}`];
    }
  }

  print(value: Expr): string {
    this.include("stdio.h");
    if (value.kind === "str") return `printf(${cString(value.value.replace(/%/g, "%%") + "\n")})`;
    if (value.kind === "fstring") {
      const { format, args } = this.formatParts(value.parts);
      return `printf(${[cString(format + "\n"), ...args].join(", ")})`;
    }
    const t = this.typeOf(value);
    const code = this.emit(value).code;
    switch (t.k) {
      case "int":
      case "bool":
        return `printf("%d\\n", ${code})`;
      case "float":
        return `printf("%g\\n", ${code})`;
      case "str":
        return `printf("%s\\n", ${code})`;
      case "list": {
        const elem = listElem(t.elem);
        this.use(`list_${elem}_to_str`);
        return `printf("%s\\n", ${listFn(elem, "to_str")}(${code}))`;
      }
      default:
        throw new Unsupported(`printing ${typeToString(t)}`);
    }
  }

  forRange(s: Extract<Stmt, { kind: "for" }>, indent: string): string[] {
    for (const e of [s.start, s.stop, ...(s.step ? [s.step] : [])]) {
      const t = this.typeOf(e);
      if (t.k !== "int" && t.k !== "bool") throw new Unsupported(`a range over ${typeToString(t)} values`);
    }
    let step = 1;
    if (s.step) {
      if (s.step.kind !== "num") throw new Unsupported("a range step that is not a fixed number");
      step = s.step.value;
      if (step === 0) throw new Unsupported("a range step of zero");
    }
    const id = this.varIdent(s.loopVar);
    const vt = this.varType(s.loopVar);
    if (vt.k !== "int") throw new Unsupported(`a loop variable of type ${typeToString(vt)}`);
    const init = this.plan.loopLocal.get(s) ? `int ${id}` : id;
    const cmp = step > 0 ? "<" : ">";
    const update =
      step === 1 ? `${id}++` : step === -1 ? `${id}--` : step > 0 ? `${id} += ${step}` : `${id} -= ${-step}`;
    const header = `for (${init} = ${this.emit(s.start).code}; ${id} ${cmp} ${wrap(this.emit(s.stop), P_ADD)}; ${update})`;
    return this.braced(header, s.body, indent);
  }

  forIn(s: Extract<Stmt, { kind: "forin" }>, indent: string): string[] {
    const it = this.typeOf(s.iterable);
    const id = this.varIdent(s.loopVar);
    const vt = this.varType(s.loopVar);
    const loopLocal = this.plan.loopLocal.get(s) !== undefined;
    this.ctype(vt);
    const i = `nl_i${++this.counter}`;
    const pre: string[] = [];
    let seq = this.emit(s.iterable);
    if (s.iterable.kind !== "var") {
      const name = `nl_seq${this.counter}`;
      pre.push(`${indent}${this.declaration(it, name)} = ${seq.code};`);
      seq = { code: name, prec: P_PRIMARY };
    }
    const bind = (value: string) =>
      `${indent}${INDENT}${loopLocal ? this.declaration(vt, id) : id} = ${value};`;
    if (it.k === "list") {
      const header = `for (int ${i} = 0; ${i} < ${wrap(seq, P_POSTFIX)}->len; ${i}++)`;
      return [...pre, ...this.braced(header, s.body, indent, [bind(`${wrap(seq, P_POSTFIX)}->items[${i}]`)])];
    }
    if (it.k === "str") {
      this.use("str_char_at");
      const header = `for (int ${i} = 0; ${wrap(seq, P_POSTFIX)}[${i}] != '\\0'; ${i}++)`;
      return [...pre, ...this.braced(header, s.body, indent, [bind(`nl_str_char_at(${seq.code}, ${i})`)])];
    }
    throw new Unsupported(`a loop over ${typeToString(it)}`);
  }

  // --- program -------------------------------------------------------------------

  /** Locals of a scope to declare: not parameters, not globals. */
  localsToDeclare(scopeKey: string, fn?: FunctionInfo): Set<string> {
    const vars = this.analysis.scopes.get(scopeKey)?.vars ?? new Map();
    const names = new Set<string>();
    for (const name of vars.keys()) {
      if (fn?.params.includes(name)) continue;
      if (scopeKey === MAIN_SCOPE && this.analysis.globals.has(name)) continue;
      names.add(name);
    }
    return names;
  }

  hoistedDeclarations(scopeKey: string, indent: string): string[] {
    const vars = this.analysis.scopes.get(scopeKey)!.vars;
    const lines: string[] = [];
    for (const name of this.plan.hoisted) {
      const t = vars.get(name);
      if (!t || !isConcrete(t)) continue;
      try {
        lines.push(`${indent}${this.declaration(t, this.ident(name))};`);
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
      }
    }
    return lines;
  }

  signature(fn: FunctionInfo): string {
    if (new Set(fn.params).size !== fn.params.length) {
      throw new Unsupported("two parameters with the same name");
    }
    const ret = fn.returnType.k === "none" ? "void" : this.ctype(fn.returnType);
    const params = fn.params.map((p, i) => this.declaration(fn.paramTypes[i], this.ident(p)));
    const name = this.ident(fn.name, true);
    const head = ret.endsWith("*") ? `${ret}${name}` : `${ret} ${name}`;
    return `${head}(${params.length > 0 ? params.join(", ") : "void"})`;
  }

  generate(statements: Stmt[]): string {
    const defs = statements.filter(
      (s): s is Extract<Stmt, { kind: "functiondef" }> => s.kind === "functiondef"
    );
    const mainStmts = statements.filter((s) => s.kind !== "functiondef");

    // Signatures first, so calls know which functions exist in C.
    const signatures = new Map<Stmt, string>();
    const rejected = new Map<Stmt, string>();
    for (const def of defs) {
      const fn = this.analysis.functions.get(canonicalName(def.name));
      if (!fn || fn.def !== def) {
        rejected.set(def, `a second definition of '${def.name}'`);
        continue;
      }
      if ([...this.analysis.scopes.values()].some((sc) => sc.vars.has(fn.name))) {
        rejected.set(def, `the function '${def.name}' (the same name is also used for a variable)`);
        continue;
      }
      const saved = this.snapshot();
      try {
        signatures.set(def, this.signature(fn));
        this.callable.add(fn.name);
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
        this.restore(saved);
        rejected.set(def, `the function '${def.name}' (${err.message})`);
      }
    }

    const functionCode: string[][] = [];
    const prototypes: string[] = [];
    defs.forEach((def, index) => {
      const reason = rejected.get(def);
      if (reason) {
        this.unsupported++;
        const line = (def as { line?: number }).line;
        this.diagnostics.push({
          severity: "warning",
          code: "TARGET_UNSUPPORTED",
          message: `${line ? `Line ${line}: ` : ""}not translated to C: ${reason}.`,
          ...(line ? { line } : {}),
        });
        functionCode.push(this.commentOut(def, "", "unsupported in C"));
        return;
      }
      const fn = this.analysis.functions.get(canonicalName(def.name))!;
      this.scope = functionScopeKey(fn.name);
      this.plan = planDeclarations(def.body, this.scope, this.analysis, this.localsToDeclare(this.scope, fn));
      const lines: string[] = [];
      if (def.docstring) lines.push(...docComment(def.docstring));
      lines.push(`${signatures.get(def)} {`);
      lines.push(...this.hoistedDeclarations(this.scope, INDENT));
      lines.push(...this.block(def.body, INDENT));
      lines.push("}");
      functionCode.push(lines);
      // A prototype is needed when an earlier function calls this one.
      if (defs.slice(0, index).some((d) => callsFunction(d.body, fn.name))) {
        prototypes.push(`${signatures.get(def)};`);
      }
    });

    this.scope = MAIN_SCOPE;
    this.plan = planDeclarations(mainStmts, MAIN_SCOPE, this.analysis, this.localsToDeclare(MAIN_SCOPE));
    const mainLines = [
      "int main(void) {",
      ...this.hoistedDeclarations(MAIN_SCOPE, INDENT),
      ...this.block(mainStmts, INDENT),
      `${INDENT}return 0;`,
      "}",
    ];

    const globals: string[] = [];
    const mainVars = this.analysis.scopes.get(MAIN_SCOPE)!.vars;
    for (const name of this.analysis.globals) {
      const t = mainVars.get(name);
      if (!t || !isConcrete(t)) continue;
      try {
        globals.push(`${this.declaration(t, this.ident(name, true))};`);
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
      }
    }

    if (statements.length === 0) return "";
    const runtime = renderRuntime(this.helpers, this.includes);
    const sections: string[] = [runtime.includes.map((h) => `#include <${h}>`).join("\n")];
    if (runtime.code.length > 0) sections.push(runtime.code.join("\n\n"));
    if (globals.length > 0) sections.push(globals.join("\n"));
    if (prototypes.length > 0) sections.push(prototypes.join("\n"));
    for (const f of functionCode) sections.push(f.join("\n"));
    sections.push(mainLines.join("\n"));
    return sections.filter((s) => s.trim() !== "").join("\n\n");
  }
}

function docComment(text: string): string[] {
  const lines = text.replace(/\*\//g, "* /").split(/\r?\n/);
  if (lines.length === 1) return [`/* ${lines[0].trim()} */`];
  return ["/*", ...lines.map((l) => ` * ${l.trim()}`.trimEnd()), " */"];
}

function callsFunction(stmts: Stmt[], name: string): boolean {
  let found = false;
  const visit = (list: Stmt[]) => {
    for (const s of list) {
      for (const e of headerExprs(s)) {
        walkExpr(e, (x) => {
          if (x.kind === "call" && canonicalName(x.func) === name) found = true;
        });
      }
      childStatementLists(s).forEach(visit);
    }
  };
  visit(stmts);
  return found;
}

export function generateC(statements: Stmt[], diagnostics: CodegenDiagnostic[] = []): GenerateResult {
  const analysis = analyze(statements);
  const local: CodegenDiagnostic[] = [];
  const gen = new CGenerator(analysis, local);
  const code = gen.generate(statements);
  diagnostics.push(...analysis.diagnostics, ...local);
  return { code, unsupportedNodes: gen.unsupported };
}
