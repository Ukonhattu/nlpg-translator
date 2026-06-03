import { describe, expect, it } from "vitest";
import type { Stmt } from "../src/ast.js";
import { generatePython } from "../src/codegen.js";

function stmt(s: Omit<Stmt, "source"> & { source?: string }): Stmt {
  return { source: "", ...s } as Stmt;
}

describe("generatePython", () => {
  it("emits assign, augassign, and print", () => {
    const code = generatePython([
      stmt({
        kind: "assign",
        target: "score",
        value: { kind: "num", value: 0 },
      }),
      stmt({
        kind: "augassign",
        target: "score",
        op: "+",
        value: { kind: "num", value: 10 },
      }),
      stmt({
        kind: "print",
        value: { kind: "str", value: "done" },
      }),
    ]);

    expect(code).toBe(
      'score = 0\nscore = score + 10\nprint("done")'
    );
  });

  it("emits if/elif/else", () => {
    const code = generatePython([
      stmt({
        kind: "if",
        test: {
          kind: "compare",
          op: ">",
          left: { kind: "var", name: "score" },
          right: { kind: "num", value: 20 },
        },
        body: [
          stmt({
            kind: "print",
            value: { kind: "str", value: "High" },
          }),
        ],
        elifs: [
          {
            test: {
              kind: "compare",
              op: ">",
              left: { kind: "var", name: "score" },
              right: { kind: "num", value: 10 },
            },
            body: [
              stmt({
                kind: "print",
                value: { kind: "str", value: "Mid" },
              }),
            ],
          },
        ],
        orelse: [
          stmt({
            kind: "print",
            value: { kind: "str", value: "Low" },
          }),
        ],
      }),
    ]);

    expect(code).toContain("if score > 20:");
    expect(code).toContain("elif score > 10:");
    expect(code).toContain("else:");
  });

  it("emits subscript assign and f-strings", () => {
    const code = generatePython([
      stmt({
        kind: "assign",
        targetExpr: {
          kind: "index",
          target: { kind: "var", name: "items" },
          index: { kind: "num", value: 0 },
        },
        value: { kind: "num", value: 1 },
      }),
      stmt({
        kind: "print",
        value: {
          kind: "fstring",
          parts: [
            { kind: "lit", value: "x=" },
            { kind: "expr", value: { kind: "var", name: "x" } },
          ],
        },
      }),
    ]);

    expect(code).toContain("items[0] = 1");
    expect(code).toContain('print(f"x={x}")');
  });

  it("emits empty block bodies as pass", () => {
    const code = generatePython([
      stmt({
        kind: "while",
        test: { kind: "bool", value: false },
        body: [],
      }),
    ]);

    expect(code).toBe("while False:\n    pass");
  });

  it("emits for-range with step, for-in, and break", () => {
    const code = generatePython([
      stmt({
        kind: "for",
        loopVar: "i",
        start: { kind: "num", value: 0 },
        stop: { kind: "num", value: 10 },
        step: { kind: "num", value: 2 },
        body: [{ kind: "break", source: "" }],
      }),
      stmt({
        kind: "forin",
        loopVar: "item",
        iterable: { kind: "var", name: "items" },
        body: [],
      }),
    ]);

    expect(code).toContain("for i in range(0, 10, 2):");
    expect(code).toContain("break");
    expect(code).toContain("for item in items:");
    expect(code).toContain("pass");
  });

  it("emits functions, assert, raise, and try/except", () => {
    const code = generatePython([
      stmt({
        kind: "functiondef",
        name: "foo",
        params: ["x"],
        docstring: "doc",
        body: [
          stmt({
            kind: "return",
            values: [{ kind: "var", name: "x" }],
          }),
        ],
      }),
      stmt({
        kind: "assert",
        test: { kind: "bool", value: true },
        message: { kind: "str", value: "ok" },
      }),
      stmt({
        kind: "raise",
        excType: "ValueError",
        message: { kind: "str", value: "bad" },
      }),
      stmt({
        kind: "try",
        body: [stmt({ kind: "break", source: "" })],
        handlers: [
          {
            exc: "ValueError",
            body: [
              stmt({
                kind: "print",
                value: { kind: "str", value: "caught" },
              }),
            ],
          },
        ],
      }),
    ]);

    expect(code).toContain('def foo(x):');
    expect(code).toContain('"""doc"""');
    expect(code).toContain("return x");
    expect(code).toContain('assert True, "ok"');
    expect(code).toContain('raise ValueError("bad")');
    expect(code).toContain("try:");
    expect(code).toContain("except ValueError:");
  });

  it("emits unpack assign, append, membership, and method calls", () => {
    const code = generatePython([
      stmt({
        kind: "unpackassign",
        targets: ["a", "b"],
        value: { kind: "call", func: "divmod", args: [{ kind: "num", value: 7 }, { kind: "num", value: 3 }] },
      }),
      stmt({
        kind: "append",
        target: "items",
        value: { kind: "num", value: 9 },
      }),
      stmt({
        kind: "if",
        test: {
          kind: "contains",
          left: { kind: "num", value: 2 },
          right: { kind: "var", name: "items" },
        },
        body: [],
        orelse: [],
      }),
      stmt({
        kind: "assign",
        target: "name",
        value: {
          kind: "methodcall",
          target: { kind: "var", name: "name" },
          method: "strip",
          args: [],
        },
      }),
    ]);

    expect(code).toContain("a, b = divmod(7, 3)");
    expect(code).toContain("items.append(9)");
    expect(code).toContain("2 in items");
    expect(code).toContain("name.strip()");
  });

  it("escapes braces in f-string literal parts", () => {
    const code = generatePython([
      stmt({
        kind: "print",
        value: {
          kind: "fstring",
          parts: [{ kind: "lit", value: "cost: {" }],
        },
      }),
    ]);

    expect(code).toContain('print(f"cost: {{")');
  });

  it("emits unknown lines as comments", () => {
    const code = generatePython([
      stmt({ kind: "unknown", source: "use a quantum computer", note: "?" }),
    ]);

    expect(code).toContain("# unsupported: use a quantum computer");
  });
});
