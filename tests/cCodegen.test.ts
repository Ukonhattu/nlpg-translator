import { describe, expect, it } from "vitest";
import type { Stmt } from "../src/ast.js";
import { cString, generateC } from "../src/targets/c/codegen.js";
import { toCIdentifier } from "../src/targets/c/identifiers.js";
import type { CodegenDiagnostic } from "../src/targets/types.js";
import * as b from "./helpers/astBuilders.js";
import { assertCompiles, LENIENT_FLAGS, runC, hasCC } from "./helpers/c.js";

const { num, str, v, bin, cmp, list, call, input, fstr, idx, and, or, not } = b;

function gen(stmts: Stmt[]) {
  const diagnostics: CodegenDiagnostic[] = [];
  const result = generateC(stmts, diagnostics);
  return { ...result, diagnostics, codes: diagnostics.map((d) => d.code) };
}

/** The body of main() without the 4-space indent. */
function mainBody(code: string): string[] {
  const lines = code.split("\n");
  const start = lines.indexOf("int main(void) {");
  return lines.slice(start + 1, lines.lastIndexOf("}")).map((l) => l.replace(/^ {4}/, ""));
}

describe("C codegen: exact output", () => {
  it("writes a minimal, idiomatic program", () => {
    const { code, unsupportedNodes } = gen([
      b.assign("total", num(0)),
      b.for_("i", num(1), num(4), [b.aug("total", "+", v("i"))]),
      b.print(fstr("Total: ", v("total"))),
    ]);
    expect(unsupportedNodes).toBe(0);
    expect(code).toBe(
      [
        "#include <stdio.h>",
        "",
        "int main(void) {",
        "    int total = 0;",
        "    for (int i = 1; i < 4; i++) {",
        "        total = total + i;",
        "    }",
        '    printf("Total: %d\\n", total);',
        "    return 0;",
        "}",
      ].join("\n")
    );
    assertCompiles(code);
  });

  it("returns empty code for an empty program", () => {
    expect(gen([]).code).toBe("");
  });

  it("prints by type: %d for ints and bools, %g for decimals, %s for text", () => {
    const { code } = gen([
      b.assign("n", num(3)),
      b.assign("x", num(2.5, "2.5")),
      b.assign("s", str("hi")),
      b.assign("ok", b.bool(true)),
      b.print(v("n")),
      b.print(v("x")),
      b.print(v("s")),
      b.print(v("ok")),
      b.print(str("100% done")),
    ]);
    expect(mainBody(code).filter((l) => l.startsWith("printf"))).toEqual([
      'printf("%d\\n", n);',
      'printf("%g\\n", x);',
      'printf("%s\\n", s);',
      'printf("%d\\n", ok);',
      'printf("100%% done\\n");',
    ]);
    assertCompiles(code);
  });

  it("keeps true division for whole numbers and says so", () => {
    const r = gen([b.assign("a", num(7)), b.print(bin("/", v("a"), num(2)))]);
    expect(mainBody(r.code)).toContain('printf("%g\\n", (double)a / 2);');
    expect(r.codes).toContain("INT_DIVISION");
  });

  it("uses else if chains and C operators", () => {
    const { code } = gen([
      b.assign("n", input(str("n? "), "int")),
      b.if_(
        or(and(cmp(">", v("n"), num(0)), cmp("<", v("n"), num(10))), not(cmp("==", v("n"), num(5)))),
        [b.print(str("a"))],
        [b.print(str("c"))],
        [{ test: cmp("==", v("n"), num(5)), body: [b.print(str("b"))] }]
      ),
    ]);
    expect(mainBody(code).slice(0, 8)).toEqual([
      'int n = nl_str_to_int(nl_input("n? "));',
      "if ((n > 0 && n < 10) || !(n == 5)) {",
      '    printf("a\\n");',
      "} else if (n == 5) {",
      '    printf("b\\n");',
      "} else {",
      '    printf("c\\n");',
      "}",
    ]);
    assertCompiles(code);
  });

  it("compares strings with strcmp and tests text and lists for emptiness", () => {
    const { code } = gen([
      b.assign("name", input()),
      b.assign("xs", list(num(1))),
      b.if_(cmp("==", v("name"), str("Bo")), [b.print(str("hi Bo"))]),
      b.if_(v("name"), [b.print(str("non-empty"))]),
      b.if_(v("xs"), [b.print(str("has items"))]),
    ]);
    const body = mainBody(code);
    expect(body).toContain('if (strcmp(name, "Bo") == 0) {');
    expect(body).toContain("if (name[0] != '\\0') {");
    expect(body).toContain("if (xs->len > 0) {");
    assertCompiles(code);
  });

  it("emits functions before main, with a prototype only when needed", () => {
    const { code } = gen([
      b.def("is_even", ["n"], [b.ret(cmp("==", bin("%", v("n"), num(2)), num(0)))]),
      b.def("first", [], [b.ret(call("second"))]),
      b.def("second", [], [b.ret(num(2))]),
      b.print(call("is_even", num(4))),
      b.print(call("first")),
    ]);
    expect(code).toContain("bool is_even(int n) {\n    return n % 2 == 0;\n}");
    expect(code).toContain("int second(void);\n");
    expect(code).not.toContain("bool is_even(int n);");
    assertCompiles(code);
  });

  it("makes top-level variables that functions read into globals", () => {
    const { code } = gen([
      b.assign("count", num(0)),
      b.def("show", [], [b.print(v("count"))]),
      b.assign("count", num(5)),
      b.exprstmt(call("show")),
    ]);
    expect(code).toMatch(/^int count;$/m);
    expect(mainBody(code).slice(0, 2)).toEqual(["count = 0;", "count = 5;"]);
    assertCompiles(code);
  });

  it("renames C keywords, library names and the runtime prefix, transliterates letters", () => {
    expect(toCIdentifier("määrä")).toBe("maara");
    expect(toCIdentifier("int")).toBe("int_");
    expect(toCIdentifier("printf")).toBe("printf_");
    expect(toCIdentifier("nl_list")).toBe("user_nl_list");
    expect(toCIdentifier("log")).toBe("log");
    expect(toCIdentifier("log", true)).toBe("log_");
    expect(toCIdentifier("π")).toBe("value");
  });

  it("reports names that collapse to the same C identifier", () => {
    const r = gen([b.assign("määrä", num(1)), b.assign("maara", num(2)), b.print(v("määrä"))]);
    expect(r.codes).toContain("NAME_COLLISION");
  });

  it("escapes C string literals, including trigraph-like text", () => {
    expect(cString('a"b\\c\n\t??=')).toBe('"a\\"b\\\\c\\n\\t?\\?="');
    expect(cString("\u0001")).toBe('"\\001"');
    expect(cString("äö")).toBe('"äö"');
  });

  it("emits only the runtime helpers that are used", () => {
    const { code } = gen([b.assign("xs", list(num(1), num(2))), b.print(idx(v("xs"), num(-1)))]);
    expect(code).toContain("nl_list_int_get");
    expect(code).not.toContain("nl_list_int_sum");
    expect(code).not.toContain("nl_list_int_set");
    assertCompiles(code);
  });
});

describe("C codegen: unsupported constructs", () => {
  it("comments out try/except, raise and tuple returns, and counts them", () => {
    const r = gen([
      b.assign("x", num(1)),
      b.try_([b.print(bin("/", num(1), v("x")))], [{ exc: "ZeroDivisionError", body: [b.print(str("error"))] }]),
      b.raise("ValueError", str("bad")),
      b.def("pair", [], [b.ret(num(1), num(2))]),
    ]);
    expect(r.unsupportedNodes).toBe(3);
    expect(r.codes.filter((c) => c === "TARGET_UNSUPPORTED")).toHaveLength(3);
    expect(r.code).toMatch(/\/\/ unsupported in C: step \d+/);
    assertCompiles(r.code, LENIENT_FLAGS);
  });

  it("does not count `unknown` steps as target-unsupported", () => {
    const r = gen([b.unknown("Do something odd."), b.print(num(1))]);
    expect(r.unsupportedNodes).toBe(0);
    expect(r.code).toContain("// unsupported: Do something odd.");
  });

  it("comments out uses of a variable with conflicting types", () => {
    const r = gen([b.assign("x", num(1)), b.assign("x", str("one")), b.print(v("x"))]);
    expect(r.codes).toContain("TYPE_CONFLICT");
    expect(r.unsupportedNodes).toBe(3);
    assertCompiles(r.code, LENIENT_FLAGS);
  });

  it("still declares a variable whose declaring statement could not be translated", () => {
    const r = gen([
      b.assign("total", call("mystery")),
      b.assign("total", num(1)),
      b.print(v("total")),
    ]);
    expect(r.unsupportedNodes).toBe(1);
    expect(mainBody(r.code).slice(0, 2)).toEqual(["int total;", "// unsupported in C: step " + (r.code.match(/step (\d+)/)![1])]);
    assertCompiles(r.code, LENIENT_FLAGS);
  });

  it("rejects a literal division by zero instead of emitting undefined behaviour", () => {
    expect(gen([b.print(bin("/", num(1), num(0)))]).unsupportedNodes).toBe(1);
  });
});

describe("C runtime behaviour", () => {
  (hasCC ? it : it.skip)("fails like Python on a bad index or bad number input", () => {
    const outOfRange = runC(gen([b.assign("xs", list(num(1))), b.print(idx(v("xs"), num(5)))]).code);
    expect(outOfRange.code).toBe(1);
    expect(outOfRange.stderr).toContain("list index out of range");
    const badInt = runC(gen([b.assign("n", input(undefined, "int")), b.print(v("n"))]).code, "abc\n");
    expect(badInt.code).toBe(1);
    expect(badInt.stderr).toContain("invalid literal for int()");
  });
});
