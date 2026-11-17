import { describe, expect, it } from "vitest";
import { verifyProgram, type Expr, type Stmt } from "../src/ast.js";
import { generatePython } from "../src/codegen.js";
import {
  isValidPythonIdentifier,
  toPythonIdentifier,
} from "../src/identifiers.js";
import { assertParses } from "./helpers/python.js";

const s = (x: object) => ({ source: "", ...x }) as Stmt;
const str = (value: string): Expr => ({ kind: "str", value });
const v = (name: string): Expr => ({ kind: "var", name });

describe("toPythonIdentifier", () => {
  it.each([
    ["total score", "total_score"],
    ["my-var", "my_var"],
    ["calculateArea", "calculateArea"],
    ["MyList", "MyList"],
    ["määrä", "määrä"],
    ["mÄÄrÖ", "mÄÄrÖ"],
    ["2fast", "_2fast"],
    ["class", "class_"],
    ["None", "None_"],
    ["a.b!", "ab"],
    ["", "value"],
    ["  !!  ", "value"],
    ["match", "match"],
  ])("%j -> %j", (input, expected) => {
    expect(toPythonIdentifier(input)).toBe(expected);
    expect(isValidPythonIdentifier(toPythonIdentifier(input))).toBe(true);
  });

  it("rejects non-identifiers", () => {
    for (const bad of ["a b", "x;y", "class", "1x", "a.b", ""]) {
      expect(isValidPythonIdentifier(bad)).toBe(false);
    }
  });
});

describe("codegen diagnostics", () => {
  it("reports shadowed builtins without renaming", () => {
    const d: string[] = [];
    const code = generatePython(
      [s({ kind: "assign", target: "list", value: { kind: "list", items: [] } })],
      d
    );
    expect(code).toBe("list = []");
    expect(d.join("\n")).toMatch(/shadows the Python built-in/);
  });

  it("does not warn when a builtin is only called", () => {
    const d: string[] = [];
    generatePython(
      [s({ kind: "print", value: { kind: "call", func: "len", args: [v("x")] } })],
      d
    );
    expect(d).toEqual([]);
  });

  it("reports two source names that collapse to one identifier", () => {
    const d: string[] = [];
    generatePython(
      [
        s({ kind: "assign", target: "my var", value: { kind: "num", value: 1 } }),
        s({ kind: "assign", target: "my_var", value: { kind: "num", value: 2 } }),
      ],
      d
    );
    expect(d.join("\n")).toMatch(/both map to the Python identifier 'my_var'/);
  });
});

describe("docstrings", () => {
  it("escapes quotes and backslashes and indents continuation lines", () => {
    const code = generatePython([
      s({
        kind: "functiondef",
        name: "f",
        params: [],
        docstring: 'say """hi"""\\ now\nsecond',
        body: [s({ kind: "pass" })],
      }),
    ]);
    assertParses(code);
    expect(code).toContain('\n    """say \\"\\"\\"hi\\"\\"\\"\\\\ now\n    second"""');
  });
});

describe("float literals", () => {
  it("uses raw when it matches the value", () => {
    const e = (raw: string, value: number) =>
      generatePython([s({ kind: "print", value: { kind: "num", value, raw } })]);
    expect(e("10.0", 10)).toBe("print(10.0)");
    expect(e("1e3", 1000)).toBe("print(1e3)");
    expect(e("99.0", 10)).toBe("print(10)"); // mismatching raw ignored
    expect(e("1; import os", 1)).toBe("print(1)"); // junk raw ignored
    expect(e("007", 7)).toBe("print(7)"); // invalid Python literal
  });
});

describe("f-strings", () => {
  const fs = (parts: object[]) =>
    generatePython([s({ kind: "print", value: { kind: "fstring", parts } })]);

  it("escapes literals and braces", () => {
    const code = fs([{ kind: "lit", value: 'a"b\\c\n{x}\t' }, { kind: "expr", value: v("n") }]);
    assertParses(code);
    expect(code).toBe('print(f"a\\"b\\\\c\\n{{x}}\\t{n}")');
  });

  it("uses single quotes for simple nested strings", () => {
    const code = fs([
      { kind: "expr", value: { kind: "methodcall", target: str("a"), method: "upper", args: [] } },
    ]);
    expect(code).toBe("print(f\"{'a'.upper()}\")");
  });

  it("falls back to concatenation (with a diagnostic) for unsafe nested strings", () => {
    const d: string[] = [];
    const code = generatePython(
      [
        s({
          kind: "print",
          value: {
            kind: "fstring",
            parts: [
              { kind: "lit", value: "x=" },
              { kind: "expr", value: { kind: "methodcall", target: v("t"), method: "replace", args: [str('"'), str("it's")] } },
            ],
          },
        }),
      ],
      d
    );
    assertParses(code);
    expect(code).toBe('print("x=" + str(t.replace("\\"", "it\'s")))');
    expect(d.join()).toMatch(/string concatenation/);
  });

  it("parenthesises a concatenation fallback used as an operand", () => {
    const e: Expr = {
      kind: "binop",
      op: "*",
      left: { kind: "fstring", parts: [{ kind: "expr", value: str('"') }, { kind: "lit", value: "z" }] },
      right: { kind: "num", value: 2 },
    };
    const code = generatePython([s({ kind: "print", value: e })]);
    assertParses(code);
    expect(code).toContain("(str(");
  });
});

describe("verify-time identifier checks (§2.2)", () => {
  const verify = (node: object, src = "x") =>
    verifyProgram({ statements: [{ line: 1, ...node }] }, src, { collectDiagnostics: true });

  it.each([
    ["methodcall.method", { kind: "print", value: { kind: "methodcall", target: str("a"), method: "upper(); x", args: [] } }],
    ["call.func", { kind: "print", value: { kind: "call", func: "class", args: [] } }],
    ["raise.excType", { kind: "raise", excType: "A\nimport os" }],
    ["handler.exc", { kind: "try", body: [], handlers: [{ exc: "a.b", body: [] }] }],
    ["functiondef.params", { kind: "functiondef", name: "f", params: ["a, b"], body: [] }],
    ["assign targetExpr call", { kind: "assign", targetExpr: { kind: "call", func: "f", args: [] }, value: { kind: "num", value: 1 } }],
  ])("drops a node with an invalid %s", (_name, node) => {
    const { statements, diagnostics } = verify(node);
    expect(statements).toEqual([]);
    expect(diagnostics.join()).toMatch(/Skipped invalid step/);
  });

  it("accepts names that only need whitespace normalisation", () => {
    const { statements } = verify({
      kind: "functiondef", name: "my func", params: ["side length"], body: [],
    });
    expect(statements).toHaveLength(1);
    expect(generatePython(statements)).toBe("def my_func(side_length):\n    pass");
  });
});

describe("recovered loop headers (§2.6)", () => {
  const run = (source: string, lines: number[]) => {
    const raw = {
      statements: [
        { kind: "unknown", line: 1 },
        ...lines.map((line) => ({ kind: "print", value: str("x"), line })),
      ],
    };
    return verifyProgram(raw, source, { collectDiagnostics: true });
  };

  it("moves more-indented following statements into the recovered loop", () => {
    const { statements } = run("For each item in items:\n    Print a\n    Print b\nPrint c", [2, 3, 4]);
    expect(generatePython(statements)).toBe(
      'for item in items:\n    print("x")\n    print("x")\nprint("x")'
    );
  });

  it("keeps old behaviour and warns when the source has no indentation", () => {
    const { statements, diagnostics } = run("For each item in items:\nPrint a", [2]);
    expect(statements).toHaveLength(2);
    expect(diagnostics.join()).toMatch(/Recovered loop header at line 1; body could not be determined/);
  });
});
