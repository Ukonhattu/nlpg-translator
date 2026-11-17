import { describe, expect, it } from "vitest";
import { analyze, functionScopeKey, MAIN_SCOPE } from "../src/semantics/infer.js";
import { planDeclarations } from "../src/semantics/declarations.js";
import { typeToString, unify, INT, FLOAT, STR, listOf, CONFLICT, UNKNOWN } from "../src/semantics/types.js";
import * as b from "./helpers/astBuilders.js";

const { num, str, v, bin, list, call, input, cast, fstr, idx } = b;

const mainTypes = (stmts: ReturnType<typeof b.assign>[]) => {
  const a = analyze(stmts);
  return Object.fromEntries(
    [...a.scopes.get(MAIN_SCOPE)!.vars].map(([k, t]) => [k, typeToString(t)])
  );
};

describe("unify", () => {
  it("widens int and float, keeps unknown as identity, conflicts otherwise", () => {
    expect(unify(INT, FLOAT)).toEqual(FLOAT);
    expect(unify(UNKNOWN, STR)).toEqual(STR);
    expect(unify(listOf(UNKNOWN), listOf(INT))).toEqual(listOf(INT));
    expect(unify(STR, INT)).toEqual(CONFLICT);
    expect(unify(listOf(STR), listOf(INT))).toEqual(listOf(CONFLICT));
  });
});

describe("type inference", () => {
  it("types literals, input, casts and expressions", () => {
    expect(
      mainTypes([
        b.assign("a", num(1)),
        b.assign("b", num(10, "10.0")),
        b.assign("c", str("x")),
        b.assign("d", input()),
        b.assign("e", input(undefined, "int")),
        b.assign("f", cast("float", v("c"))),
        b.assign("g", bin("/", v("a"), num(2))),
        b.assign("h", bin("+", v("c"), str("!"))),
        b.assign("i", fstr("n=", v("a"))),
        b.assign("j", call("len", v("c"))),
        b.assign("k", b.cmp(">", v("a"), num(0))),
      ])
    ).toEqual({
      a: "int",
      b: "float",
      c: "str",
      d: "str",
      e: "int",
      f: "float",
      g: "float",
      h: "str",
      i: "str",
      j: "int",
      k: "bool",
    });
  });

  it("widens a variable that later holds a decimal", () => {
    expect(mainTypes([b.assign("x", num(5)), b.aug("x", "/", num(2))])).toEqual({ x: "float" });
  });

  it("types an empty list from later appends and loops from their iterable", () => {
    expect(
      mainTypes([
        b.assign("names", list()),
        b.append("names", str("Ann")),
        b.forin("name", v("names"), []),
        b.assign("first", idx(v("names"), num(0))),
      ])
    ).toEqual({ names: "list[str]", name: "str", first: "str" });
  });

  it("infers parameter types from call sites and return types from returns", () => {
    const a = analyze([
      b.def("half", ["x"], [b.ret(bin("/", v("x"), num(2)))]),
      b.def("shout", ["text"], [b.print(v("text"))]),
      b.assign("r", call("half", num(3))),
      b.exprstmt(call("shout", str("hi"))),
    ]);
    const half = a.functions.get("half")!;
    expect(half.paramTypes.map(typeToString)).toEqual(["int"]);
    expect(typeToString(half.returnType)).toBe("float");
    expect(typeToString(a.functions.get("shout")!.returnType)).toBe("none");
    expect(a.scopes.get(MAIN_SCOPE)!.vars.get("r")).toEqual(FLOAT);
  });

  it("assumes int for parameters that are never called, with a diagnostic", () => {
    const a = analyze([b.def("area", ["w", "h"], [b.ret(bin("*", v("w"), v("h")))])]);
    expect(a.functions.get("area")!.paramTypes).toEqual([INT, INT]);
    expect(a.diagnostics.map((d) => d.code)).toEqual(["TYPE_ASSUMED", "TYPE_ASSUMED"]);
  });

  it("reports variables used with incompatible types", () => {
    const a = analyze([b.assign("x", num(1)), b.assign("x", str("one"))]);
    expect(a.scopes.get(MAIN_SCOPE)!.vars.get("x")).toEqual(CONFLICT);
    expect(a.diagnostics.map((d) => d.code)).toEqual(["TYPE_CONFLICT"]);
  });

  it("follows Python scoping: assigned names are local, others are globals", () => {
    const a = analyze([
      b.assign("count", num(0)),
      b.def("show", [], [b.assign("tmp", v("count")), b.print(v("tmp"))]),
      b.exprstmt(call("show")),
    ]);
    expect([...a.globals]).toEqual(["count"]);
    expect(a.scopes.get(functionScopeKey("show"))!.vars.get("tmp")).toEqual(INT);
  });

  it("treats names that differ only in spacing as the same variable", () => {
    expect(mainTypes([b.assign("my total", num(1)), b.print(v("my_total"))])).toEqual({ my_total: "int" });
  });
});

describe("declaration placement", () => {
  const plan = (stmts: ReturnType<typeof b.assign>[]) => {
    const a = analyze(stmts);
    const names = new Set(a.scopes.get(MAIN_SCOPE)!.vars.keys());
    const p = planDeclarations(stmts, MAIN_SCOPE, a, names);
    return {
      hoisted: p.hoisted,
      inline: [...p.inline.values()],
      loopLocal: [...p.loopLocal.values()],
    };
  };

  it("declares at the first assignment when that comes first", () => {
    expect(plan([b.assign("total", num(0)), b.print(v("total"))])).toEqual({
      hoisted: [],
      inline: ["total"],
      loopLocal: [],
    });
  });

  it("declares a loop variable used only in its loop in the loop", () => {
    expect(plan([b.for_("i", num(0), num(3), [b.print(v("i"))])]).loopLocal).toEqual(["i"]);
    expect(
      plan([b.for_("i", num(0), num(3), []), b.print(v("i"))])
    ).toEqual({ hoisted: ["i"], inline: [], loopLocal: [] });
  });

  it("hoists a variable first assigned in a branch and used after it", () => {
    expect(
      plan([
        b.if_(b.bool(true), [b.assign("x", num(1))], [b.assign("x", num(2))]),
        b.print(v("x")),
      ]).hoisted
    ).toEqual(["x"]);
  });

  it("never declares inside a loop a variable read before it is set in an iteration", () => {
    // while: if seen: print(prev); prev = 1  -> prev must survive iterations
    const p = plan([
      b.assign("seen", b.bool(false)),
      b.while_(v("seen"), [b.if_(v("seen"), [b.print(v("prev"))]), b.assign("prev", num(1))]),
    ]);
    expect(p.hoisted).toContain("prev");
  });

  it("declares a variable used only inside one block at its first assignment there", () => {
    const p = plan([b.repeat(num(2), [b.assign("tmp", num(1)), b.print(v("tmp"))])]);
    expect(p.inline).toEqual(["tmp"]);
  });
});
