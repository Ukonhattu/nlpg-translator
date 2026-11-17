/**
 * Differential test: one AST, two targets. The Python and the C program
 * generated from the same statements must print the same output for the same
 * input. Any difference is a code generation bug in one of the targets.
 *
 * Known, intended differences are normalised away: C prints decimals with %g
 * (6 significant digits, no trailing ".0") and booleans as 1/0.
 */
import { describe, expect, it } from "vitest";
import type { Stmt } from "../src/ast.js";
import { generatePython } from "../src/codegen.js";
import { verifyProgram } from "../src/ast.js";
import { generateC } from "../src/targets/c/codegen.js";
import type { CodegenDiagnostic } from "../src/targets/types.js";
import { loadGolden } from "./fixtures/loadGolden.js";
import * as b from "./helpers/astBuilders.js";
import { hasCC, runC } from "./helpers/c.js";
import { hasPython, runPython } from "./helpers/python.js";

function normalize(out: string): string {
  return out
    .replace(/-?\d+\.\d+(?:e[+-]?\d+)?|-?\d+e[+-]?\d+/gi, (m) => String(Number(Number(m).toPrecision(6))))
    .replace(/\bTrue\b/g, "1")
    .replace(/\bFalse\b/g, "0");
}

type Case = { name: string; program: Stmt[]; stdin?: string };

const { num, str, v, bin, cmp, list, idx, call, meth, input, cast, fstr, contains, and, not } = b;

const cases: Case[] = [
  {
    name: "arithmetic and true division",
    program: [
      b.assign("a", num(7)),
      b.assign("b", num(2)),
      b.print(bin("/", v("a"), v("b"))),
      b.print(bin("%", v("a"), v("b"))),
      b.print(bin("-", bin("*", v("a"), v("b")), num(1))),
      b.print(bin("-", v("a"), bin("-", v("b"), num(1)))),
      b.assign("x", num(10, "10.0")),
      b.print(v("x")),
      b.aug("x", "/", num(4)),
      b.print(v("x")),
      b.print(bin("%", num(7.5, "7.5"), num(2))),
      b.assign("n", num(5)),
      b.aug("n", "/", num(2)),
      b.print(v("n")),
    ],
  },
  {
    name: "if / elif / else on input",
    stdin: "7\n",
    program: [
      b.assign("n", input(str("Number: "), "int")),
      b.if_(cmp(">", v("n"), num(10)), [b.print(str("big"))], [b.print(str("small"))], [
        { test: cmp(">", v("n"), num(5)), body: [b.print(str("medium"))] },
      ]),
      b.if_(and(cmp(">", v("n"), num(0)), not(cmp("==", v("n"), num(3)))), [b.print(str("positive, not 3"))]),
    ],
  },
  {
    name: "while, break and counters",
    program: [
      b.assign("i", num(0)),
      b.assign("total", num(0)),
      b.while_(b.bool(true), [
        b.aug("i", "+", num(1)),
        b.if_(cmp(">", v("i"), num(5)), [b.brk()]),
        b.aug("total", "+", v("i")),
      ]),
      b.print(v("total")),
      b.print(v("i")),
    ],
  },
  {
    name: "range loops and repeat",
    program: [
      b.for_("i", num(0), num(3), [b.print(v("i"))]),
      b.for_("j", num(10), num(0), [b.print(v("j"))], num(-3)),
      b.for_("k", num(1), num(10), [b.print(v("k"))], num(4)),
      b.repeat(num(2), [b.print(str("hi"))]),
      b.assign("times", num(3)),
      b.repeat(bin("+", v("times"), num(1)), [b.print(str("again"))]),
    ],
  },
  {
    name: "strings",
    stdin: "  ada lovelace  \n",
    program: [
      b.assign("raw", input(str("Name? "))),
      b.assign("name", meth(v("raw"), "strip")),
      b.print(bin("+", str("Hello, "), v("name"))),
      b.print(meth(v("name"), "upper")),
      b.print(meth(v("name"), "capitalize")),
      b.print(meth(v("name"), "replace", str("a"), str("4"))),
      b.print(call("len", v("name"))),
      b.print(fstr(v("name"), " has ", call("len", v("name")), " characters (100%)")),
      b.if_(contains(str("love"), v("name")), [b.print(str("contains love"))]),
      b.if_(meth(v("name"), "startswith", str("ada")), [b.print(str("starts with ada"))]),
      b.print(idx(v("name"), num(0))),
      b.print(idx(v("name"), num(-1))),
      b.print(bin("*", str("ab"), num(3))),
      b.if_(v("name"), [b.print(str("not empty"))]),
      b.forin("ch", str("abc"), [b.print(v("ch"))]),
      b.print(str("tab\there, quote \" and backslash \\ ??=")),
    ],
  },
  {
    name: "lists",
    program: [
      b.assign("numbers", list(num(4), num(8), num(15))),
      b.append("numbers", num(16)),
      b.print(v("numbers")),
      b.print(idx(v("numbers"), num(0))),
      b.print(idx(v("numbers"), num(-1))),
      b.print(call("len", v("numbers"))),
      b.print(call("sum", v("numbers"))),
      b.print(call("max", v("numbers"))),
      b.print(call("min", v("numbers"))),
      b.if_(contains(num(8), v("numbers")), [b.print(str("has 8"))]),
      b.setItem(idx(v("numbers"), num(1)), num(42)),
      b.forin("n", v("numbers"), [b.print(bin("*", v("n"), num(2)))]),
      b.assign("names", list()),
      b.append("names", str("Ann")),
      b.append("names", str("Bo")),
      b.print(v("names")),
      b.print(meth(v("names"), "pop")),
      b.assign("prices", list(num(1.5, "1.5"), num(2))),
      b.print(call("sum", v("prices"))),
      b.if_(v("prices"), [b.print(str("prices not empty"))]),
      b.forin("x", list(num(1), num(2)), [b.print(v("x"))]),
    ],
  },
  {
    name: "functions, globals and recursion",
    program: [
      b.def("area", ["width", "height"], [b.ret(bin("*", v("width"), v("height")))], "Area of a rectangle."),
      b.def("greet", ["who"], [b.print(fstr("Hi ", v("who"), "!"))]),
      b.def("factorial", ["n"], [
        b.if_(cmp("<=", v("n"), num(1)), [b.ret(num(1))]),
        b.ret(bin("*", v("n"), call("factorial", bin("-", v("n"), num(1))))),
      ]),
      b.def("bump", [], [b.append("log", str("bumped"))]),
      b.assign("log", list()),
      b.print(call("area", num(3), num(4))),
      b.exprstmt(call("greet", str("Bo"))),
      b.print(call("factorial", num(5))),
      b.exprstmt(call("bump")),
      b.exprstmt(call("bump")),
      b.print(call("len", v("log"))),
      b.def("half", ["x"], [b.ret(bin("/", v("x"), num(2)))]),
      b.print(call("half", num(5))),
    ],
  },
  {
    name: "conversions, rounding and builtins",
    stdin: "2.5\n41\n",
    program: [
      b.assign("price", input(undefined, "float")),
      b.assign("count", cast("int", input())),
      b.print(bin("*", v("price"), num(3))),
      b.print(bin("+", v("count"), num(1))),
      b.print(bin("+", str("count="), cast("str", v("count")))),
      b.print(bin("+", str("price="), cast("str", v("price")))),
      b.print(call("round", num(2.5, "2.5"))),
      b.print(call("round", num(3.5, "3.5"))),
      b.print(call("abs", num(-3))),
      b.print(call("max", num(3), num(9), num(4))),
      b.print(call("min", num(2.5, "2.5"), num(1))),
      b.print(cast("int", num(7.9, "7.9"))),
      b.print(cast("float", num(2))),
      b.assign("flag", cmp(">", v("count"), num(10))),
      b.print(v("flag")),
      b.assert_(cmp(">", v("count"), num(0)), str("count must be positive")),
      b.print(str("done")),
    ],
  },
];

const runnable = hasCC && hasPython ? it : it.skip;

describe("Python and C agree (differential)", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const diagnostics: CodegenDiagnostic[] = [];
    const generated = generateC(c.program, diagnostics);
    expect(generated.unsupportedNodes, JSON.stringify(diagnostics, null, 1)).toBe(0);
    if (!hasCC || !hasPython) return;
    const py = runPython(generatePython(c.program), c.stdin);
    expect(py.stderr).toBe("");
    const cRun = runC(generated.code, c.stdin);
    expect(cRun.compileError, `${generated.code}\n${cRun.compileError}`).toBeUndefined();
    expect(cRun.stderr).toBe("");
    expect(normalize(cRun.stdout)).toBe(normalize(py.stdout));
  });

  runnable.each(["lists-loops.v2", "combined-course-features.v2"])("golden fixture %s", (name) => {
    const fixture = loadGolden(name);
    const { statements } = verifyProgram(fixture.raw, fixture.source);
    const generated = generateC(statements);
    const run = runC(generated.code, "", undefined);
    expect(run.compileError, generated.code).toBeUndefined();
    if (generated.unsupportedNodes === 0) {
      expect(normalize(run.stdout)).toBe(normalize(runPython(generatePython(statements)).stdout));
    }
  });
});
